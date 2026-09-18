import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

import type { LocalModel, LocalStatus, Segment } from '../shared/types';
import { AppError } from './errors';
import { downloadedModels } from './model-cache';

export interface LocalTranscription {
  status(): LocalStatus;
  prepare(model: LocalModel): void;
  transcribe(audio: Buffer, model: LocalModel, signal: AbortSignal): Promise<string>;
  stream(model: LocalModel, handlers: StreamHandlers): LocalStream;
  close(): void;
}

export interface LocalOptions {
  python: string;
  script: string;
  modelsDir: string;
  threads: number;
}

export interface StreamHandlers {
  /** The model is loaded and the session is open: audio will be listened to from here. */
  onReady?(): void;
  /** Called as each pause closes a segment, while the recording is still going. */
  onSegment(segment: Segment): void;
}

export interface LocalStream {
  /**
   * Audio in. Returns false when the worker has fallen behind and its input is full: the
   * caller should stop reading from the network until `drain()` resolves, rather than
   * dropping frames on the floor.
   */
  push(frame: Buffer): boolean;
  drain(): Promise<void>;
  /** Flush, transcribe the last segment, and resolve with the whole transcript. */
  stop(): Promise<string>;
  /** Abandon the recording. The worker keeps running and keeps its model loaded. */
  cancel(): void;
}

/** Audio buffered for a session still waiting its turn, before the recording is refused. */
const QUEUE_LIMIT_BYTES = 24000 * 2 * 60;

/**
 * One recording in flight. Serialized against every other use of the worker: a session
 * started while the model is busy waits its turn with its audio buffered, which is what a
 * queue buys over v1's "busy, retry" — a recording that has already been spoken cannot be
 * retried.
 */
class Session implements LocalStream {
  readonly id = crypto.randomUUID();
  private queued: Buffer[] = [];
  private bytes = 0;
  private live = false;
  /** The worker has been told to start, whether or not it has answered yet. */
  private announced = false;
  private ended = false;
  private release?: () => void;
  private drainWaiters: Array<() => void> = [];
  private ready: Promise<void>;
  private resolveStarted?: () => void;
  private rejectStarted?: (error: Error) => void;
  private resolveDone?: (text: string) => void;
  private rejectDone?: (error: Error) => void;

  constructor(
    private owner: LocalTranscriber,
    private model: LocalModel,
    private handlers: StreamHandlers,
  ) {
    this.ready = this.begin();
    // Nobody awaits this until stop(), but a failure must not surface as an unhandled
    // rejection before then.
    this.ready.catch(() => {});
  }

  private async begin() {
    this.release = await this.owner.acquire();
    if (this.ended) {
      // Cancelled while queued: never touch the worker.
      this.release();
      this.release = undefined;
      return;
    }
    this.owner.attach(this);
    await new Promise<void>((resolve, reject) => {
      this.resolveStarted = resolve;
      this.rejectStarted = reject;
      this.announced = true;
      this.owner.write(this.id, { operation: 'start', model: this.model });
    });
  }

  /** Called for every message the worker sends under this session's id. */
  receive(result: Record<string, unknown>) {
    if (this.ended) return;
    if (result.error) {
      const error = new AppError(
        503,
        'Local transcription stopped. Prepare this model in Settings, then retry.',
      );
      if (this.live) this.finish(error);
      else this.rejectStarted?.(error);
      return;
    }
    if (result.started) {
      this.live = true;
      this.flush();
      this.resolveStarted?.();
      this.handlers.onReady?.();
      return;
    }
    if (result.event === 'segment') {
      this.handlers.onSegment({
        index: Number(result.index),
        text: String(result.text),
        startMs: Number(result.startMs),
        endMs: Number(result.endMs),
      });
      return;
    }
    if (result.done) this.finish(undefined, String(result.text ?? ''));
  }

  private flush() {
    const queued = this.queued.splice(0);
    this.bytes = 0;
    for (const frame of queued)
      this.owner.write(this.id, { operation: 'audio', audio: frame.toString('base64') });
  }

  /** Settle the session exactly once, whichever way it ends. */
  finish(error?: Error, text?: string) {
    if (this.ended) return;
    this.ended = true;
    this.owner.detach(this.id);
    this.release?.();
    this.release = undefined;
    for (const waiter of this.drainWaiters.splice(0)) waiter();
    if (error) this.rejectDone?.(error);
    else if (this.resolveDone) this.resolveDone(text ?? '');
    // A session that fails before stop() was called settles on stop() instead.
    else this.rejectStarted?.(error ?? new AppError(499, 'The recording was cancelled.'));
  }

  push(frame: Buffer): boolean {
    if (this.ended) return true;
    if (this.live)
      return this.owner.write(this.id, { operation: 'audio', audio: frame.toString('base64') });
    if (this.bytes + frame.length > QUEUE_LIMIT_BYTES) {
      this.finish(new AppError(409, 'The local model is busy with another recording.'));
      return true;
    }
    this.queued.push(frame);
    this.bytes += frame.length;
    return true;
  }

  drain(): Promise<void> {
    if (this.ended || this.owner.idle(this.id)) return Promise.resolve();
    return new Promise<void>((resolve) => this.drainWaiters.push(resolve));
  }

  /** The worker's input has room again. */
  resume() {
    for (const waiter of this.drainWaiters.splice(0)) waiter();
  }

  async stop(): Promise<string> {
    const text = new Promise<string>((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
    try {
      await this.ready;
    } catch (error) {
      this.finish(error as Error);
      return text;
    }
    if (!this.ended) {
      this.flush();
      this.owner.write(this.id, { operation: 'stop' });
    }
    return text;
  }

  cancel() {
    // If the worker has been told to start, it has to be told to stop, even if it has
    // not answered yet: otherwise it is left holding a session open, and the next
    // recording is refused. Messages are processed in the order they are written, so a
    // cancel sent now arrives after the start it belongs to.
    if (this.announced) this.owner.write(this.id, { operation: 'cancel' });
    this.finish(new AppError(499, 'The recording was cancelled.'));
  }

  /** The worker died, or the server is shutting down. */
  abandon(error: Error) {
    this.finish(error);
  }
}

export class LocalTranscriber implements LocalTranscription {
  private child?: ChildProcessWithoutNullStreams;
  private handlers = new Map<string, (result: Record<string, unknown>) => void>();
  // What is loaded right now. The disk and the thread count are answered fresh by status(),
  // which is why they are not part of it.
  private state: Omit<LocalStatus, 'threads' | 'downloaded'> = { status: 'idle' };
  private preparing?: Promise<void>;
  /** Operations run one at a time: one model is loaded, one session is open. */
  private tail: Promise<void> = Promise.resolve();
  private session?: Session;

  constructor(private options: LocalOptions) {}

  status(): LocalStatus {
    return {
      ...this.state,
      ...(!existsSync(this.options.python) && { status: 'not-installed' as const }),
      threads: this.options.threads,
      downloaded: downloadedModels(this.options.modelsDir),
    };
  }

  /**
   * Wait for the worker to be free, and get back the one function that frees it again.
   * @internal
   */
  acquire(): Promise<() => void> {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const previous = this.tail;
    this.tail = previous.then(() => held);
    return previous.then(() => release);
  }

  /** @internal */
  attach(session: Session) {
    this.session = session;
    this.handlers.set(session.id, (result) => session.receive(result));
    this.state = { status: 'transcribing', model: this.state.model };
  }

  /** @internal */
  detach(id: string) {
    this.handlers.delete(id);
    if (this.session?.id === id) {
      this.session = undefined;
      this.state = { status: 'ready', model: this.state.model };
    }
  }

  /** @internal */
  write(id: string, payload: Record<string, unknown>): boolean {
    const child = this.worker();
    return child.stdin.write(JSON.stringify({ id, ...payload }) + '\n');
  }

  /** @internal */
  idle(id: string): boolean {
    return this.session?.id !== id || !this.child || this.child.stdin.writableLength === 0;
  }

  private worker() {
    if (this.child) return this.child;
    if (!existsSync(this.options.python))
      throw new AppError(
        503,
        'Local transcription is not installed. Run npm run setup:local, then prepare a model in Settings.',
      );
    // Do not pass API keys or Hugging Face account tokens to the model worker.
    const child = spawn(this.options.python, ['-u', this.options.script], {
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        LANG: 'C.UTF-8',
        LOCAL_WHISPER_CACHE: this.options.modelsDir,
        LOCAL_WHISPER_THREADS: String(this.options.threads),
        HF_HOME: join(this.options.modelsDir, 'hub'),
        HF_HUB_DISABLE_TELEMETRY: '1',
        HF_HUB_DISABLE_IMPLICIT_TOKEN: '1',
        HF_HUB_DISABLE_XET: '1',
        PYTHONUNBUFFERED: '1',
      },
      stdio: 'pipe',
    });
    this.child = child;
    // Third-party libraries may print paths or input details. Never forward worker stderr.
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      if (this.child !== child) return;
      try {
        const result = JSON.parse(line) as Record<string, unknown>;
        this.handlers.get(String(result.id))?.(result);
      } catch {
        this.broke(
          new AppError(502, 'Local transcription returned an unreadable response. Please retry.'),
        );
      }
    });
    child.on('error', () => this.broke());
    child.on('exit', () => this.broke());
    child.stdin.on('error', () => this.broke());
    child.stdin.on('drain', () => this.session?.resume());
    return child;
  }

  private broke(reason?: Error) {
    if (!this.child) return;
    this.child = undefined;
    const error = new AppError(
      503,
      reason?.message ?? 'The local transcription worker stopped. Check npm run setup:local and retry.',
    );
    const session = this.session;
    this.session = undefined;
    this.handlers.clear();
    this.state = { status: 'error', error: error.message };
    session?.abandon(error);
  }

  private async request(
    operation: 'prepare' | 'transcribe',
    model: LocalModel,
    signal: AbortSignal,
    audio?: Buffer,
  ) {
    signal.throwIfAborted();
    const release = await this.acquire();
    signal.throwIfAborted();
    const id = crypto.randomUUID();
    const child = this.worker();
    const abort = () => {
      // Native CPU inference cannot be interrupted through Python's stdin. For a one-shot
      // request a model reload is an acceptable price; a session cancels through the
      // protocol instead, which keeps the loaded model.
      this.handlers.delete(id);
      this.child = undefined;
      child.kill('SIGKILL');
      this.state = { status: 'idle' };
    };
    try {
      const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
        signal.addEventListener('abort', abort, { once: true });
        this.handlers.set(id, (value) => {
          if (value.error === 'worker_failed') reject(new AppError(503, 'The local worker stopped.'));
          else resolve(value);
        });
        child.stdin.write(
          JSON.stringify({
            id,
            operation,
            model,
            ...(audio && { audio: audio.toString('base64') }),
          }) + '\n',
        );
      });
      signal.throwIfAborted();
      if (result.error === 'dependencies')
        throw new AppError(
          503,
          'Local Python dependencies are missing. Run npm run setup:local, then retry.',
        );
      if (result.error)
        throw new AppError(
          503,
          operation === 'prepare'
            ? 'Could not prepare the local model. Check your connection to Hugging Face and retry.'
            : 'Local transcription failed. Prepare this model in Settings, then retry the recording.',
        );
      return result;
    } finally {
      signal.removeEventListener('abort', abort);
      this.handlers.delete(id);
      release();
    }
  }

  prepare(model: LocalModel) {
    if (this.state.status === 'ready' && this.state.model === model) return;
    if (this.preparing || this.session)
      throw new AppError(409, 'The local model is busy. Wait for the current operation and retry.');
    if (!existsSync(this.options.python))
      throw new AppError(503, 'Run npm run setup:local before preparing a model.');
    this.state = { status: 'loading', model };
    this.preparing = this.request('prepare', model, AbortSignal.timeout(10 * 60 * 1000))
      .then(() => {
        this.state = { status: 'ready', model };
      })
      .catch((error) => {
        this.state = {
          status: 'error',
          error:
            error instanceof AppError
              ? error.message
              : 'Model preparation timed out. Check your connection and retry.',
        };
      })
      .finally(() => {
        this.preparing = undefined;
      });
  }

  async transcribe(audio: Buffer, model: LocalModel, signal: AbortSignal) {
    signal.throwIfAborted();
    this.state = { status: 'transcribing', model };
    try {
      const result = await this.request('transcribe', model, signal, audio);
      this.state = { status: 'ready', model };
      if (typeof result.text !== 'string' || !result.text.trim())
        throw new AppError(422, 'No speech was recognized locally. Try again in a quieter place.');
      if (result.text.length > 12000)
        throw new AppError(422, 'The transcript is too long. Try a shorter recording.');
      return result.text.trim();
    } catch (error) {
      if (!signal.aborted && !(error instanceof AppError && error.status === 422))
        this.state = {
          status: 'error',
          error:
            error instanceof AppError ? error.message : 'Local transcription failed. Please retry.',
        };
      throw error;
    }
  }

  /**
   * Open a streaming session. Audio handed over before the worker is free is buffered, so
   * a recording that begins while the model is busy is queued rather than refused.
   */
  stream(model: LocalModel, handlers: StreamHandlers): LocalStream {
    if (!existsSync(this.options.python))
      throw new AppError(503, 'Local transcription is not installed. Run npm run setup:local.');
    return new Session(this, model, handlers);
  }

  close() {
    const child = this.child;
    const session = this.session;
    this.child = undefined;
    this.session = undefined;
    this.handlers.clear();
    child?.kill('SIGKILL');
    this.state = { status: 'idle' };
    session?.abandon(new AppError(503, 'The local worker was stopped. Please retry.'));
  }
}
