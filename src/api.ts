import type { HistoryEntry, LanguageFeedback, LocalModel, Readiness } from '../shared/types';

/**
 * What the app asks the API, and nothing else.
 *
 * The interface exists so the session and the rec bar can be tested against a fake that
 * records calls, without a server: the only place that knows about HTTP is here.
 */
export interface Api {
  readiness(): Promise<Readiness>;
  polish(text: string, signal?: AbortSignal): Promise<string>;
  prepare(model: LocalModel): Promise<void>;
  history(): Promise<string>;
  entries(): Promise<HistoryEntry[]>;
  appendEntry(entry: HistoryEntry): Promise<void>;
  rewriteHistory(markdown: string): Promise<void>;
  /** Ask the server to coach a past recording and remember the answer. */
  checkGrammar(id: string): Promise<HistoryEntry>;
  /** Send a recording for pronunciation coaching. The only upload there is. */
  speaking(wav: ArrayBuffer): Promise<string>;
  /** Origin to open the streaming socket to, including the port. */
  streamUrl(): string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function createApi(port: number, fetcher: typeof fetch = fetch): Api {
  const base = `http://127.0.0.1:${port}`;
  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetcher(`${base}${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
    if (!response.ok) {
      // The API's errors are written for the person reading them, so pass them through
      // rather than inventing a message here.
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(response.status, body.error ?? `The app returned ${response.status}.`);
    }
    return (await response.json()) as T;
  }

  return {
    readiness: () => call<Readiness>('/api/config'),
    polish: async (text, signal) =>
      (await call<{ text: string }>('/api/polish', {
        method: 'POST',
        body: JSON.stringify({ text }),
        signal,
      })).text,
    prepare: async (model) => {
      await call('/api/local/prepare', { method: 'POST', body: JSON.stringify({ model }) });
    },
    history: async () => (await call<{ markdown: string }>('/api/history')).markdown,
    entries: async () => (await call<{ entries: HistoryEntry[] }>('/api/history/entries')).entries,
    appendEntry: async (entry) => {
      await call('/api/history/entries', { method: 'POST', body: JSON.stringify(entry) });
    },
    rewriteHistory: async (markdown) => {
      await call('/api/history', { method: 'POST', body: JSON.stringify({ markdown }) });
    },
    speaking: async (wav) =>
      (
        await call<{ text: string }>('/api/feedback/speaking', {
          method: 'POST',
          body: wav,
          headers: { 'Content-Type': 'audio/wav' },
        })
      ).text,
    checkGrammar: async (id) =>
      (
        await call<{ entry: HistoryEntry }>(`/api/history/entries/${encodeURIComponent(id)}/feedback`, {
          method: 'POST',
        })
      ).entry,
    streamUrl: () => `ws://127.0.0.1:${port}/api/stream`,
  };
}

export type { HistoryEntry, LanguageFeedback, LocalModel, Readiness };
