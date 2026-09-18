import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { attachStream } from '../server/stream';
import type {
  LocalStream,
  LocalTranscription,
  StreamHandlers,
} from '../server/local-transcriber';
import type { LocalModel } from '../shared/types';

const ORIGINS = ['tauri://localhost', 'http://localhost:1420'];
let server: Server;
let url: string;
const open: WebSocket[] = [];

/** Stands in for the model: records what the transport hands it, and can be driven. */
function transcriber(options: { push?: () => boolean } = {}) {
  let handlers: StreamHandlers | undefined;
  const session: LocalStream = {
    push: vi.fn(options.push ?? (() => true)),
    drain: vi.fn(async () => {}),
    stop: vi.fn(async () => 'one two'),
    cancel: vi.fn(),
  };
  const fake: LocalTranscription = {
    status: () => ({ status: 'ready', threads: 6, downloaded: ['base.en'] }),
    prepare: vi.fn(),
    transcribe: vi.fn(),
    close: vi.fn(),
    stream: vi.fn((_model: LocalModel, incoming: StreamHandlers) => {
      handlers = incoming;
      incoming.onReady?.();
      return session;
    }),
  };
  return { fake, session, handlers: () => handlers! };
}

beforeEach(async () => {
  server = createServer();
});
afterEach(async () => {
  open.splice(0).forEach((socket) => socket.terminate());
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function listen(model: LocalTranscription = transcriber().fake, maxBytes = 64) {
  attachStream(server, { origins: ORIGINS, maxBytes, transcriber: model });
  return new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/stream`;
      resolve();
    }),
  );
}

function connect(origin?: string, path = '/api/stream') {
  const socket = new WebSocket(`${url.replace('/api/stream', path)}`, {
    ...(origin && { headers: { Origin: origin } }),
  });
  open.push(socket);
  return socket;
}
function next(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.once('message', (data) => resolve(JSON.parse(data.toString())));
    socket.once('error', reject);
    socket.once('close', () => reject(new Error('closed before a message arrived')));
  });
}
function isOpen(socket: WebSocket): Promise<boolean> {
  return new Promise((resolve) => {
    socket.once('open', () => resolve(true));
    socket.once('error', () => resolve(false));
    socket.once('close', () => resolve(false));
  });
}

describe('streaming handshake', () => {
  it('refuses a websocket from anywhere but the app', async () => {
    await listen();
    expect(await isOpen(connect('https://untrusted.example'))).toBe(false);
    expect(await isOpen(connect())).toBe(false); // a browser always sends an origin
    expect(await isOpen(connect('tauri://localhost'))).toBe(true);
  });
  it('refuses a path that is not the stream', async () => {
    await listen();
    expect(await isOpen(connect('tauri://localhost', '/api/socket'))).toBe(false);
  });
});

describe('streaming protocol', () => {
  it('answers start once the model is listening, and feeds it the audio', async () => {
    const fake = transcriber();
    await listen(fake.fake, 24000);
    const socket = connect('tauri://localhost');
    await isOpen(socket);
    socket.send(JSON.stringify({ type: 'start', model: 'small.en' }));
    expect(await next(socket)).toEqual({ type: 'ready', model: 'small.en' });

    socket.send(Buffer.alloc(4800));
    await vi.waitFor(() => expect(fake.session.push).toHaveBeenCalledTimes(1));
    expect((fake.session.push as ReturnType<typeof vi.fn>).mock.calls[0][0]).toHaveLength(4800);
  });
  it('relays segments as they close and the transcript when the recording stops', async () => {
    const fake = transcriber();
    await listen(fake.fake);
    const socket = connect('tauri://localhost');
    await isOpen(socket);
    socket.send(JSON.stringify({ type: 'start', model: 'base.en' }));
    await next(socket);

    fake.handlers().onSegment({ index: 0, text: 'one', startMs: 0, endMs: 900 });
    expect(await next(socket)).toEqual({
      type: 'segment',
      index: 0,
      text: 'one',
      startMs: 0,
      endMs: 900,
    });

    socket.send(JSON.stringify({ type: 'stop' }));
    expect(await next(socket)).toEqual({ type: 'done', text: 'one two' });
    expect(fake.session.stop).toHaveBeenCalled();
  });
  it('abandons the recording when the socket goes away mid-stream', async () => {
    const fake = transcriber();
    await listen(fake.fake);
    const socket = connect('tauri://localhost');
    await isOpen(socket);
    socket.send(JSON.stringify({ type: 'start', model: 'base.en' }));
    await next(socket);
    socket.close();
    await vi.waitFor(() => expect(fake.session.cancel).toHaveBeenCalled());
  });
  it('stops reading when the worker falls behind', async () => {
    const fake = transcriber({ push: () => false });
    await listen(fake.fake, 24000);
    const socket = connect('tauri://localhost');
    await isOpen(socket);
    socket.send(JSON.stringify({ type: 'start', model: 'base.en' }));
    await next(socket);
    socket.send(Buffer.alloc(128));
    // The transport asked the session to drain rather than buffering without limit.
    await vi.waitFor(() => expect(fake.session.drain).toHaveBeenCalled());
  });
  it('refuses a second start, stop before start, and anything that is not a message', async () => {
    await listen();
    const socket = connect('tauri://localhost');
    await isOpen(socket);
    socket.send(JSON.stringify({ type: 'stop' }));
    expect(await next(socket)).toEqual({ type: 'error', message: 'Send start before stop.' });
    socket.send('not json at all');
    expect(await next(socket)).toEqual({ type: 'error', message: 'Send start or stop.' });

    socket.send(JSON.stringify({ type: 'start', model: 'base.en' }));
    await next(socket);
    socket.send(JSON.stringify({ type: 'start', model: 'base.en' }));
    expect(await next(socket)).toEqual({
      type: 'error',
      message: 'This stream has already started.',
    });
  });
  it('refuses audio before start, and closes a recording that runs past the limit', async () => {
    await listen();
    const early = connect('tauri://localhost');
    await isOpen(early);
    early.send(Buffer.alloc(8));
    expect(await next(early)).toEqual({ type: 'error', message: 'Send start before audio.' });

    const socket = connect('tauri://localhost');
    await isOpen(socket);
    socket.send(JSON.stringify({ type: 'start', model: 'base.en' }));
    await next(socket);
    const closed = new Promise<number>((resolve) => socket.once('close', resolve));
    socket.send(Buffer.alloc(96));
    expect(await next(socket)).toEqual({
      type: 'error',
      message: 'That recording is longer than the ten minute limit.',
    });
    expect(await closed).toBe(1009);
  });
});
