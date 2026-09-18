import type { Api } from './api';
import { encodeWav, type Recorder } from './audio';
import type { InsertResult, Shell } from './shell/types';
import { DEFAULT_PREFERENCES, SAMPLE_RATE, type HistoryEntry, type Preferences, type Segment, type StreamEvent } from '../shared/types';

/**
 * One recording, from the hotkey to the text landing in another application.
 *
 * The shape is an event stream, not a request: audio leaves continuously, segments come
 * back as they close, and the transcript is assembled from what arrived rather than from
 * one response. Everything it talks to — the API, the recorder, the shell — is injected,
 * so this file has no DOM and no platform in it.
 */

export type SessionState =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'polishing'
  | 'done'
  | 'error';

export interface Transcript {
  /** What was recognised, verbatim, including the segments that arrived mid-stream. */
  original: string;
  /** The polish of the whole thing. Falls back to the original if polishing fails. */
  polished: string;
  segments: Segment[];
}

export interface SessionOutcome extends Transcript {
  insert?: InsertResult;
  /** Set when something went wrong that the user should know about. */
  error?: string;
}

export interface SessionHandlers {
  onState(state: SessionState, detail?: string): void;
  onSegment(segment: Segment): void;
  /** The polished preview as it forms, one segment at a time. */
  onPreview(text: string): void;
  onLevel(level: number): void;
  onFinished(outcome: SessionOutcome): void;
}

export interface SessionDeps {
  api: Api;
  recorder: Recorder;
  shell: Shell;
  handlers: SessionHandlers;
  /**
   * Read when a recording starts, not when the session was built: the detail box can change
   * the model or turn coaching off while the rec bar is open, and the next recording should
   * hear about it.
   */
  preferences?: () => Preferences;
  /** How the socket is opened. Replaced in tests; the browser's own WebSocket otherwise. */
  connect?(url: string): WebSocket;
}

/** The recorder stops at ten minutes; this is the same ceiling, in bytes of 16-bit PCM. */
const MAX_KEPT_BYTES = 600 * 24000 * 2;
/** The coaching endpoint takes two minutes of audio; longer recordings are transcribed only. */
const MAX_COACHING_BYTES = 120 * 24000 * 2;

export class Session {
  private socket?: WebSocket;
  /** The recording has ended on purpose: a closing socket is then expected, not a fault. */
  private settled = false;
  /** Resolves once the recording has been delivered, failed, or abandoned. */
  private delivered?: Promise<void>;
  private deliver?: () => void;
  private state: SessionState = 'idle';
  private revision = 0;
  private segments: Segment[] = [];
  private previews: string[] = [];
  private socketError?: string;
  /** The recording itself, kept only when coaching will need it. */
  private kept: Int16Array[] = [];
  private keptBytes = 0;

  constructor(private deps: SessionDeps) {}

  get current(): SessionState {
    return this.state;
  }

  /** Start recording, or stop and deliver what was said. */
  async toggle(): Promise<void> {
    if (this.state === 'listening' || this.state === 'connecting') return this.stop();
    return this.start();
  }

  private preferences(): Preferences {
    return this.deps.preferences?.() ?? DEFAULT_PREFERENCES;
  }

  private set(state: SessionState, detail?: string) {
    this.state = state;
    this.deps.handlers.onState(state, detail);
  }

  private async start(): Promise<void> {
    const revision = ++this.revision;
    this.settled = false;
    this.delivered = new Promise<void>((resolve) => (this.deliver = resolve));
    this.kept = [];
    this.keptBytes = 0;
    this.segments = [];
    this.previews = [];
    this.socketError = undefined;
    this.set('connecting');

    let socket: WebSocket;
    try {
      socket = (this.deps.connect ?? ((url: string) => new WebSocket(url)))(
        this.deps.api.streamUrl(),
      );
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve(), { once: true });
        socket.addEventListener('error', () => reject(new Error('no connection')), { once: true });
      });
    } catch {
      this.set('error', 'The transcriber is not running.');
      return;
    }
    if (revision !== this.revision) return socket.close();
    this.socket = socket;

    socket.addEventListener('message', (event) => {
      if (revision !== this.revision) return;
      this.receive(event.data as string, revision);
    });
    socket.addEventListener('close', () => {
      if (revision !== this.revision || this.settled) return;
      // Closing while a recording is live — including while waiting for the last segment
      // to be transcribed — is a failure, not the end of a recording.
      if (this.state === 'listening' || this.state === 'connecting' || this.state === 'polishing')
        this.fail(this.socketError ?? 'The transcriber stopped.');
    });

    socket.send(
      JSON.stringify({ type: 'start', model: this.preferences().localModel }),
    );

    // The microphone opens when the model says it is listening: a cold start takes a
    // moment, and audio spoken before then would have nowhere to go.
  }

  private async beginCapture(): Promise<void> {
    const revision = this.revision;
    try {
      await this.deps.recorder.start();
    } catch (error) {
      if (revision !== this.revision) return;
      this.fail(
        (error as DOMException)?.name === 'NotAllowedError'
          ? 'Microphone access was refused.'
          : `The microphone is unavailable (${(error as Error).message}).`,
      );
      return;
    }
    if (revision !== this.revision) return this.deps.recorder.stop();
    this.deps.recorder.onLevel((level) => this.deps.handlers.onLevel(level));
    this.deps.recorder.onFrame((frame) => {
      if (revision !== this.revision) return;
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(frame);
      // Kept only to coach with afterwards, and only while coaching is on: there is no
      // other reason for this app to hold a recording after it has been transcribed.
      if (this.preferences().audioCoaching && this.keptBytes + frame.byteLength <= MAX_KEPT_BYTES) {
        this.kept.push(frame);
        this.keptBytes += frame.byteLength;
      }
    });
    // The recording stops itself at the limit, and the recording should say so rather
    // than just ending.
    this.deps.recorder.onLimit(() => void this.stop());
    this.set('listening');
  }

  private receive(raw: string, revision: number) {
    let event: StreamEvent;
    try {
      event = JSON.parse(raw) as StreamEvent;
    } catch {
      return;
    }
    if (event.type === 'ready') {
      void this.beginCapture();
      return;
    }
    if (event.type === 'segment') {
      const segment: Segment = {
        index: event.index,
        text: event.text,
        startMs: event.startMs,
        endMs: event.endMs,
      };
      this.segments.push(segment);
      this.deps.handlers.onSegment(segment);
      void this.preview(segment.text, revision);
      return;
    }
    if (event.type === 'error') {
      this.socketError = event.message;
      // Surfaced immediately: a model that cannot be prepared, or a worker that has
      // stopped, is something the person speaking needs to know while they are speaking.
      this.set(this.state === 'connecting' ? 'connecting' : 'listening', event.message);
      return;
    }
    if (event.type === 'done') void this.finish(event.text, revision);
  }

  /** Polish a segment as it closes: this is the preview, not the result. */
  private async preview(text: string, revision: number): Promise<void> {
    try {
      const polished = await this.deps.api.polish(text);
      if (revision !== this.revision) return;
      this.previews.push(polished);
      this.deps.handlers.onPreview(this.previews.join(' '));
    } catch {
      // A preview that cannot be polished is not worth interrupting for: the original
      // text is already on screen, and the final polish is what gets inserted.
    }
  }

  /** Stop recording and wait until the text has been polished, inserted, or given up on. */
  private async stop(): Promise<void> {
    const revision = this.revision;
    await this.deps.recorder.stop();
    if (revision !== this.revision) return;
    this.set('polishing');
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'stop' }));
    // finish() runs when the transcriber answers; if it never does, say so rather than
    // waiting for ever.
    const waited = await Promise.race([
      (this.delivered ?? Promise.resolve()).then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 60_000)),
    ]);
    if (!waited && revision === this.revision && this.state === 'polishing')
      this.fail('The transcriber did not answer.', revision);
  }

  private async finish(original: string, revision: number): Promise<void> {
    if (revision !== this.revision) return;
    // Closed here, and deliberately: the recording is over, so the socket closing back is
    // the expected end of it. Reading it as a failure made every recording report one.
    this.settled = true;
    this.socket?.close();
    this.socket = undefined;
    const done = this.deliver;
    // The transcript from the stream is authoritative: a segment can be dropped as
    // speechless, and only the server knows what survived.
    const transcript = original || this.segments.map((segment) => segment.text).join(' ');

    this.set('polishing');
    let polished = transcript;
    let error: string | undefined;
    try {
      polished = (await this.deps.api.polish(transcript)).trim() || transcript;
    } catch (polishError) {
      // Never lose the words: the recognised text is inserted, and the failure is shown.
      error = `Could not polish: ${(polishError as Error).message}`;
    }
    if (revision !== this.revision) return;
    if (!polished.trim()) {
      this.fail('Nothing was recognised.', revision);
      return;
    }

    const insert = await this.deps.shell.insertText(polished);
    if (revision !== this.revision) return;
    this.set('done', insert.ok ? undefined : insert.detail);
    this.deps.handlers.onFinished({ original: transcript, polished, segments: this.segments, insert, error });
    done?.();
    // In the background, and after the words have landed: coaching is slow, and the
    // history is a record of what happened rather than something to wait for.
    void this.remember(transcript, polished, revision);
  }

  private fail(detail: string, revision = this.revision): void {
    if (revision !== this.revision) return;
    this.settled = true;
    this.socket?.close();
    this.socket = undefined;
    const done = this.deliver;
    this.set('error', detail);
    done?.();
    this.deps.handlers.onFinished({
      original: this.segments.map((segment) => segment.text).join(' '),
      polished: this.previews.join(' '),
      segments: this.segments,
      error: detail,
    });
  }

  /**
   * Write the recording into the history, coaching it first if that is switched on.
   *
   * The audio is the only thing here that cannot be recomputed later, so it is the only
   * reason to send anything to the audio model now; grammar feedback is asked for from the
   * detail box, where it can be asked for again.
   */
  private async remember(transcript: string, polished: string, revision: number): Promise<void> {
    const entry: HistoryEntry = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      // From the recorder's own count, not from the audio kept for coaching: that copy only
      // exists when speaking coaching is on, so a recording made with it off was written
      // down as zero seconds long.
      duration: this.deps.recorder.stats().samples / SAMPLE_RATE,
      originalTranscript: transcript,
      polished,
    };

    const coaching = this.preferences().audioCoaching;
    if (coaching && this.kept.length && this.keptBytes <= MAX_COACHING_BYTES) {
      try {
        const pcm = new Int16Array(this.keptBytes / 2);
        let offset = 0;
        for (const frame of this.kept) {
          pcm.set(frame, offset);
          offset += frame.length;
        }
        entry.speaking = await this.deps.api.speaking(encodeWav(pcm));
      } catch (error) {
        await this.deps.shell.report(`speaking coaching failed: ${(error as Error).message}`);
      }
    }
    if (coaching && this.keptBytes > MAX_COACHING_BYTES)
      await this.deps.shell.report(
        'recording is longer than the two minutes coaching accepts; transcribed but not coached',
      );
    // The memory goes as soon as it is no longer wanted.
    this.kept = [];
    this.keptBytes = 0;

    try {
      await this.deps.api.appendEntry(entry);
      if (revision === this.revision) await this.deps.shell.report('saved to history');
    } catch (error) {
      await this.deps.shell.report(`could not save to history: ${(error as Error).message}`);
      return;
    }

    // After the write, never before: the detail box answers this by reading the file, so
    // being told early would have it read the list it already had. Not guarded by the
    // revision, because what changed is the file, not which recording is the current one.
    await this.deps.shell.postHistoryChanged();
  }
}
