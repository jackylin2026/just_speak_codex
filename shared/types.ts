import type { z } from 'zod';
import type { languageFeedbackSchema } from './schemas';

/** A recording that is uploaded for coaching. Longer ones are transcribed, not coached. */
export const MAX_SECONDS = 120;
export const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
/** How long a recording may run. The recorder stops itself here. */
export const MAX_STREAM_SECONDS = 600;
export const SAMPLE_RATE = 24000;
export const LOCAL_MODELS = ['base.en', 'small.en'] as const;
export type LocalModel = (typeof LOCAL_MODELS)[number];

/**
 * There is no provider choice any more: recognition is always local Whisper, and the
 * only cloud audio call left is speaking feedback.
 */
export interface Preferences {
  localModel: LocalModel;
  audioCoaching: boolean;
}
export const DEFAULT_PREFERENCES: Preferences = {
  localModel: 'base.en',
  audioCoaching: true,
};

export interface LocalStatus {
  status: 'not-installed' | 'idle' | 'loading' | 'ready' | 'transcribing' | 'error';
  model?: LocalModel;
  error?: string;
  threads: number;
  /**
   * Models already on this computer, complete enough to load with no network. `status` only
   * ever describes what is loaded right now, which resets every launch; this is what lets a
   * control say a model is here rather than offering to download it again.
   */
  downloaded: LocalModel[];
}

export type LanguageFeedback = z.infer<typeof languageFeedbackSchema>;

/** A stretch of continuous speech between pauses, transcribed while you are still speaking. */
export interface Segment {
  index: number;
  text: string;
  startMs: number;
  endMs: number;
}

/** What the detail box needs to draw one recording in the history. */
export interface HistoryEntry {
  id: string;
  createdAt: string;
  duration: number;
  originalTranscript: string;
  polished: string;
  language?: LanguageFeedback;
  speaking?: string;
}

/**
 * Client → server over /api/stream. Audio arrives as binary frames, not JSON.
 *
 * There is no `cancel`: a recording is ended by stopping it, and abandoned by the socket
 * closing — which is what the server does on the client's behalf either way.
 */
export type StreamRequest = { type: 'start'; model: LocalModel } | { type: 'stop' };

/** Server → client over /api/stream. */
export type StreamEvent =
  | { type: 'ready'; model: LocalModel }
  | ({ type: 'segment' } & Segment)
  | { type: 'done'; text: string }
  | { type: 'error'; message: string };

/**
 * What the app is holding in memory as audio, and what it could hold at most. Nothing is
 * written to disk, so this number is the whole of the privacy story and belongs on screen.
 */
export interface AudioMemory {
  capSeconds: number;
  capBytes: number;
  /** Bytes of recording currently in memory on the server. */
  heldBytes: number;
}

export interface Readiness {
  /** Whether speaking feedback can run. Transcription is local and has no key. */
  openai: boolean;
  cerebras: boolean;
  models: { speaking: string; text: string };
  local?: LocalStatus;
  audio?: AudioMemory;
  /** Where the Python environment goes, and the script that puts it there. */
  setup?: { script: string; dataDir: string };
}
