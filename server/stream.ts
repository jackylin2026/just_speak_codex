import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';

import { MAX_STREAM_SECONDS, SAMPLE_RATE, type StreamEvent, type LocalModel } from '../shared/types';
import { localModelSchema } from '../shared/schemas';
import type { LocalStream, LocalTranscription } from './local-transcriber';
import { AppError } from './errors';

/**
 * One recording per connection.
 *
 * The browser sends audio and says when it started and stopped; it never decides where a
 * sentence ends — segments arrive from the worker as they close, each already transcribed,
 * while the speaker is still going. `done` carries the assembled transcript, which is what
 * the polish step and the history get.
 *
 * Audio is fed to the worker as fast as it arrives, but not faster than the worker can
 * take it: when its input fills, reading from the socket stops until it drains, so a slow
 * model slows the recording down instead of dropping words.
 */
export interface StreamOptions {
  origins: string[];
  transcriber?: LocalTranscription;
  /** Bytes of 24 kHz 16-bit mono PCM: the recorder's own cap, plus slack. */
  maxBytes?: number;
}

/** A 100 ms frame is ~4.8 kB; anything near this is not a frame from our recorder. */
const MAX_FRAME_BYTES = 1024 * 1024;

const requestSchema = z.union([
  z.object({ type: z.literal('start'), model: localModelSchema.default('base.en') }).strict(),
  z.object({ type: z.literal('stop') }).strict(),
]);

function reject(socket: Duplex, status: 403 | 404, message: string) {
  socket.write(`HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : 'Not Found'}\r\n\r\n`);
  socket.destroy();
}

export interface StreamAttachment {
  sockets: WebSocketServer;
  /** Audio this endpoint is holding right now, in bytes: for the figure in Settings. */
  held(): number;
}

export function attachStream(server: Server, options: StreamOptions): StreamAttachment {
  const allowed = new Set(options.origins);
  const maxBytes = options.maxBytes ?? MAX_STREAM_SECONDS * SAMPLE_RATE * 2 + 1024 * 1024;
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const active = new Map<WebSocket, number>();

  const send = (socket: WebSocket, event: StreamEvent) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
  };
  const fail = (socket: WebSocket, message: string) => send(socket, { type: 'error', message });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== '/api/stream') return reject(socket, 404, 'Unknown websocket endpoint.');
    // Browsers always send Origin on a websocket handshake, so a request without one is
    // not our frontend. This is the only gate on the socket: there is no cookie to check.
    const origin = request.headers.origin;
    if (!origin || !allowed.has(origin))
      return reject(socket, 403, 'Requests must come from the local app.');

    sockets.handleUpgrade(request, socket, head, (webSocket) => {
      let session: LocalStream | undefined;
      let model: LocalModel | undefined;
      let bytes = 0;
      let paused = false;
      let finished = false;
      active.set(webSocket, 0);

      const stop = () => {
        if (finished) return;
        finished = true;
        session?.cancel();
        session = undefined;
        active.delete(webSocket);
      };

      const resumeWhenDrained = () => {
        if (paused) return;
        paused = true;
        // The worker's input is full. Stop reading the socket rather than buffering the
        // recording in memory without limit.
        webSocket.pause();
        void session
          ?.drain()
          .catch(() => {})
          .then(() => {
            paused = false;
            if (webSocket.readyState === webSocket.OPEN) webSocket.resume();
          });
      };

      webSocket.on('message', (data, isBinary) => {
        if (finished) return;

        if (isBinary) {
          if (!session) return fail(webSocket, 'Send start before audio.');
          bytes += Array.isArray(data)
            ? data.reduce((total, part) => total + part.byteLength, 0)
            : data.byteLength;
          active.set(webSocket, bytes);
          if (bytes > maxBytes) {
            fail(webSocket, 'That recording is longer than the ten minute limit.');
            webSocket.close(1009, 'too long');
            stop();
            return;
          }
          const frame = Buffer.isBuffer(data)
            ? data
            : Array.isArray(data)
              ? Buffer.concat(data)
              : Buffer.from(data);
          if (!session.push(frame)) resumeWhenDrained();
          return;
        }

        let request: z.infer<typeof requestSchema>;
        try {
          request = requestSchema.parse(JSON.parse(data.toString()));
        } catch {
          return fail(webSocket, 'Send start or stop.');
        }

        if (request.type === 'start') {
          if (session) return fail(webSocket, 'This stream has already started.');
          if (!options.transcriber)
            return fail(webSocket, 'Local transcription is not installed. Run npm run setup:local.');
          model = request.model;
          bytes = 0;
          try {
            session = options.transcriber.stream(model, {
              // The model is loaded and the worker is listening: this is when the client
              // can treat the stream as live, cold start included.
              onReady: () => send(webSocket, { type: 'ready', model: model! }),
              onSegment: (segment) => send(webSocket, { type: 'segment', ...segment }),
            });
          } catch (error) {
            session = undefined;
            fail(webSocket, message(error));
          }
          return;
        }

        if (!session) return fail(webSocket, 'Send start before stop.');

        // stop
        const current = session;
        finished = true;
        void current
          .stop()
          .then((text) => send(webSocket, { type: 'done', text }))
          .catch((error) => {
            if (!(error instanceof AppError && error.status === 499)) fail(webSocket, message(error));
          });
      });

      webSocket.on('close', stop);
      webSocket.on('error', () => webSocket.terminate());
    });
  });

  return {
    sockets,
    held: () => [...active.values()].reduce((total, size) => total + size, 0),
  };
}

function message(error: unknown): string {
  return error instanceof AppError
    ? error.message
    : 'Local transcription failed. Please retry.';
}
