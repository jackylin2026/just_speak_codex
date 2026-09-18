import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalTranscriber } from '../server/local-transcriber';
import type { Segment } from '../shared/types';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
type Message = { id: string; operation: string; model: string; audio?: string };
const managers: LocalTranscriber[] = [];
const MODELS = '/tmp/just-speak-models';

/** A child process that speaks the worker's line protocol, scripted by the test. */
function mockWorker(
  script: (message: Message, send: (data: object) => void) => void,
  options: { full?: boolean } = {},
) {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, {
    stdout,
    stderr,
    stdin: new Writable({
      write(chunk, _encoding, callback) {
        const message = JSON.parse(chunk.toString()) as Message;
        queueMicrotask(() => {
          if (!options.full) callback();
          respond(message, (data) => stdout.write(JSON.stringify({ id: message.id, ...data }) + '\n'));
        });
      },
    }),
    kill: vi.fn(() => {
      queueMicrotask(() => child.emit('exit', null, 'SIGKILL'));
      return true;
    }),
  });
  const respond = script;
  return child;
}

/** A worker that answers prepare, segment events as audio arrives, stop, and cancel. */
function streamingWorker() {
  let spoken = 0;
  return mockWorker((message, send) => {
    if (message.operation === 'prepare') return send({ ready: true });
    if (message.operation === 'start') return send({ started: true });
    if (message.operation === 'audio') {
      spoken += 1;
      if (spoken === 2)
        send({ event: 'segment', index: 0, text: 'one', startMs: 0, endMs: 900 });
      return;
    }
    if (message.operation === 'stop')
      return send({ event: 'segment', index: 1, text: 'two', startMs: 1000, endMs: 1800 }),
        send({ done: true, text: 'one two' });
    if (message.operation === 'cancel') return send({ cancelled: true });
    if (message.operation === 'transcribe') return send({ text: 'Local transcript' });
  });
}

/** A worker whose input is always full: `write` returns false until the test drains it. */
function slowWorker(spawnMock: ReturnType<typeof vi.mocked<typeof spawn>>) {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdout = new PassThrough();
  const stdin = new EventEmitter() as EventEmitter & {
    writableLength: number;
    write(chunk: Buffer): boolean;
  };
  stdin.writableLength = 4096;
  let started = false;
  stdin.write = (chunk: Buffer) => {
    const message = JSON.parse(chunk.toString()) as Message;
    queueMicrotask(() => {
      if (message.operation !== 'start') return;
      started = true;
      stdout.write(JSON.stringify({ id: message.id, started: true }) + '\n');
    });
    return false;
  };
  Object.assign(child, {
    stdout,
    stderr: new PassThrough(),
    stdin,
    kill: vi.fn(),
  });
  spawnMock.mockImplementation(() => child);
  return {
    get started() {
      return started;
    },
    drain: () => stdin.emit('drain'),
  };
}

function manager() {
  const value = new LocalTranscriber({
    python: process.execPath,
    script: 'local/worker.py',
    modelsDir: MODELS,
    threads: 2,
  });
  managers.push(value);
  return value;
}
beforeEach(() => vi.mocked(spawn).mockReset());
afterEach(() => {
  managers.splice(0).forEach((value) => value.close());
});

describe('persistent local worker', () => {
  it('loads once, reuses the process, and sends audio without cloud credentials', async () => {
    vi.mocked(spawn).mockImplementation(() => streamingWorker());
    const local = manager();
    local.prepare('base.en');
    await vi.waitFor(() => expect(local.status().status).toBe('ready'));
    expect(
      await local.transcribe(
        Buffer.from('test recording'),
        'base.en',
        new AbortController().signal,
      ),
    ).toBe('Local transcript');
    expect(spawn).toHaveBeenCalledTimes(1);
    const options = vi.mocked(spawn).mock.calls[0][2] as { env: NodeJS.ProcessEnv };
    expect(options.env).not.toHaveProperty('OPENAI_API_KEY');
    expect(options.env).not.toHaveProperty('CEREBRAS_API_KEY');
    // The cache location is whatever it was configured with, not a fixed path inside
    // the source tree: models live in user data once the app is packaged.
    expect(options.env.LOCAL_WHISPER_CACHE).toBe(MODELS);
    expect(options.env.HF_HOME).toBe(`${MODELS}/hub`);
  });
  it('queues overlapping work instead of refusing it', async () => {
    vi.mocked(spawn).mockImplementation(() => mockWorker((message, send) => {
      // Answer the first request late, so the second is provably waiting behind it.
      if (message.operation === 'prepare') return void setTimeout(() => send({ ready: true }), 30);
      setTimeout(() => send({ text: `text ${message.id.slice(0, 4)}` }), 5);
    }));
    const local = manager();
    const first = local.transcribe(Buffer.from('audio'), 'base.en', new AbortController().signal);
    const second = local.transcribe(Buffer.from('audio'), 'base.en', new AbortController().signal);
    // Neither throws "busy": a recording that has already been spoken cannot be retried.
    const [a, b] = await Promise.all([first, second]);
    expect(a).toMatch(/^text /);
    expect(b).toMatch(/^text /);
  });
  it('reports setup failures without exposing worker details and permits retry', async () => {
    let failure = true;
    vi.mocked(spawn).mockImplementation(() =>
      mockWorker((_message, send) =>
        send(failure ? { error: 'dependencies', detail: 'secret' } : { ready: true }),
      ),
    );
    const local = manager();
    local.prepare('base.en');
    await vi.waitFor(() => expect(local.status().status).toBe('error'));
    expect(local.status().error).toContain('setup:local');
    expect(JSON.stringify(local.status())).not.toContain('secret');
    failure = false;
    local.prepare('base.en');
    await vi.waitFor(() => expect(local.status().status).toBe('ready'));
  });
  it('does not leave a pre-cancelled recording marked as running', async () => {
    vi.mocked(spawn).mockImplementation(() => streamingWorker());
    const local = manager();
    const controller = new AbortController();
    controller.abort();
    await expect(
      local.transcribe(Buffer.from('audio'), 'base.en', controller.signal),
    ).rejects.toThrow();
    expect(local.status().status).toBe('idle');
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('streaming session', () => {
  it('relays segments as they close and answers stop with the whole transcript', async () => {
    const child = streamingWorker();
    vi.mocked(spawn).mockImplementation(() => child);
    const local = manager();
    const segments: Segment[] = [];
    const ready = vi.fn();
    const session = local.stream('base.en', { onSegment: (segment) => segments.push(segment), onReady: ready });

    session.push(Buffer.from('frame one'));
    session.push(Buffer.from('frame two'));
    await vi.waitFor(() => expect(segments).toHaveLength(1));
    expect(ready).toHaveBeenCalled();
    expect(segments[0]).toEqual({ index: 0, text: 'one', startMs: 0, endMs: 900 });

    const text = await session.stop();
    expect(text).toBe('one two');
    expect(segments.map((segment) => segment.text)).toEqual(['one', 'two']);
    expect(child.kill).not.toHaveBeenCalled();
  });
  it('cancels through the protocol and keeps the loaded model', async () => {
    const child = streamingWorker();
    vi.mocked(spawn).mockImplementation(() => child);
    const local = manager();
    const first = local.stream('base.en', { onSegment: () => {} });
    first.push(Buffer.from('frame'));
    // Cancelled before the worker had even acknowledged the start: it must still be told
    // to close, or it holds the session open and refuses the next recording.
    first.cancel();
    // Cancelling must not take the worker with it: no SIGKILL, no model reload.
    expect(child.kill).not.toHaveBeenCalled();
    expect(local.status().status).not.toBe('error');

    const segments: Segment[] = [];
    const second = local.stream('base.en', { onSegment: (segment) => segments.push(segment) });
    second.push(Buffer.from('one'));
    second.push(Buffer.from('two'));
    await vi.waitFor(() => expect(segments).toHaveLength(1));
    expect(await second.stop()).toBe('one two');
    expect(spawn).toHaveBeenCalledTimes(1);
  });
  it('queues a recording that starts while the worker is busy, keeping its audio', async () => {
    vi.mocked(spawn).mockImplementation(() => streamingWorker());
    const local = manager();
    const first = local.stream('base.en', { onSegment: () => {} });
    const queued: Segment[] = [];
    const second = local.stream('base.en', { onSegment: (segment) => queued.push(segment) });
    // Audio that arrives before its turn is held, not dropped.
    second.push(Buffer.from('frame one'));
    second.push(Buffer.from('frame two'));
    expect(await first.stop()).toBe('one two');
    await vi.waitFor(() => expect(queued).toHaveLength(1));
    expect(queued[0].text).toBe('one');
    expect(await second.stop()).toBe('one two');
  });
  it('tells the caller to stop reading when the worker falls behind', async () => {
    const local = manager();
    const child = slowWorker(vi.mocked(spawn));
    const session = local.stream('base.en', { onSegment: () => {} });
    await vi.waitFor(() => expect(child.started).toBe(true));

    // The worker says its input is full, so the transport must stop reading the socket
    // rather than buffer the recording without limit.
    expect(session.push(Buffer.alloc(64))).toBe(false);
    let drained = false;
    const waiting = session.drain().then(() => (drained = true));
    await Promise.resolve();
    expect(drained).toBe(false);
    child.drain();
    await waiting;
    expect(drained).toBe(true);
    session.cancel();
  });
});
