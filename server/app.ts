import express, { type Request, type Response, type NextFunction } from 'express';
import { MAX_AUDIO_BYTES, MAX_STREAM_SECONDS, SAMPLE_RATE, type AudioMemory } from '../shared/types';
import {
  textInputSchema,
  localModelSchema,
  historyEntrySchema,
  historyRewriteSchema,
} from '../shared/schemas';
import { validateAudio } from './audio';
import { AppError } from './errors';
import type { HistoryStore } from './history';
import type { Providers } from './providers';

export interface AppOptions {
  providers: Providers;
  history: HistoryStore;
  port?: number;
  /** Browser origins that may call the API. The Tauri webview's origin is one of them. */
  origins?: string[];
  timeoutMs?: number;
  /** How much audio is in memory right now, for the figure Settings shows. */
  heldAudio?: () => number;
  /** Where local transcription is installed from, for the message when it is missing. */
  setup?: { script: string; dataDir: string };
}

export function createApp({
  providers,
  history,
  port = 3000,
  origins = [],
  timeoutMs = 60000,
  heldAudio,
  setup,
}: AppOptions) {
  const app = express();
  app.disable('x-powered-by');
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
  const allowed = new Set(origins);

  // The frontend is a webview, not the same origin as the API, so every call is a
  // cross-origin request: without these headers the browser blocks the response before
  // it reaches the app, and preflights for JSON and custom headers never get past
  // OPTIONS. Allowing an origin is not the same as trusting it — the API still binds to
  // localhost and every route validates its input.
  app.use((req, res, next) => {
    if (!hosts.has(req.headers.host || ''))
      return res.status(403).json({ error: 'Use the app on localhost.' });
    const origin = req.headers.origin;
    if (origin && !allowed.has(origin))
      return res.status(403).json({ error: 'Requests must come from the local app.' });
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Local-Model');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', express.json({ limit: '64kb' }));
  const audioBody = express.raw({ type: ['audio/wav', 'audio/x-wav'], limit: MAX_AUDIO_BYTES });
  const endpoint =
    (
      work: (req: Request, signal: AbortSignal) => Promise<Record<string, unknown>>,
      stepTimeout = timeoutMs,
    ) =>
    async (req: Request, res: Response, next: NextFunction) => {
      const controller = new AbortController();
      const timeout = AbortSignal.timeout(stepTimeout);
      const signal = AbortSignal.any([controller.signal, timeout]);
      const disconnected = () => {
        if (!res.writableEnded) controller.abort();
      };
      res.on('close', disconnected);
      const start = performance.now();
      try {
        const result = await work(req, signal);
        if (!controller.signal.aborted)
          res.json({ ...result, ms: Math.round(performance.now() - start) });
      } catch (error) {
        if (!controller.signal.aborted)
          next(
            timeout.aborted
              ? new AppError(504, 'This step timed out. Your other results are safe; please retry.')
              : error,
          );
      } finally {
        res.off('close', disconnected);
      }
    };
  const text = (req: Request) => {
    const result = textInputSchema.safeParse(req.body);
    if (!result.success)
      throw new AppError(400, 'Provide a transcript between 1 and 12,000 characters.');
    return result.data.text;
  };
  const audio = (req: Request) => {
    validateAudio(req.body);
    return req.body as Buffer;
  };

  const audioMemory = (): AudioMemory => ({
    capSeconds: MAX_STREAM_SECONDS,
    capBytes: MAX_STREAM_SECONDS * SAMPLE_RATE * 2,
    heldBytes: heldAudio?.() ?? 0,
  });
  app.get('/api/config', (_req, res) =>
    res.json({ ...providers.readiness(), audio: audioMemory(), setup }),
  );
  app.post('/api/local/prepare', (req, res) => {
    const model = localModelSchema.safeParse(req.body?.model);
    if (!model.success)
      throw new AppError(400, 'Choose base.en or small.en for local transcription.');
    if (!providers.prepareLocal) throw new AppError(503, 'Local transcription is not installed.');
    providers.prepareLocal(model.data);
    res.status(202).json({ local: providers.readiness().local });
  });
  app.post(
    '/api/transcribe',
    audioBody,
    endpoint(
      async (req, signal) => {
        const model = localModelSchema.safeParse(req.get('X-Local-Model') ?? 'base.en');
        if (!model.success) throw new AppError(400, 'Choose base.en or small.en.');
        return { text: await providers.transcribe(audio(req), model.data, signal) };
      },
      Math.max(timeoutMs, 120000),
    ),
  );
  app.post(
    '/api/polish',
    endpoint(async (req, signal) => ({ text: await providers.polish(text(req), signal) })),
  );
  app.post(
    '/api/feedback/language',
    endpoint(async (req, signal) => ({ feedback: await providers.language(text(req), signal) })),
  );
  app.post(
    '/api/feedback/speaking',
    audioBody,
    endpoint(async (req, signal) => ({ text: await providers.speaking(audio(req), signal) })),
  );
  app.get('/api/history', endpoint(async () => ({ markdown: await history.read() })));
  app.get('/api/history/entries', endpoint(async () => ({ entries: await history.entries() })));
  app.post(
    '/api/history/entries/:id/feedback',
    endpoint(async (req, signal) => {
      // Coaching is lazy: a past recording has no feedback until someone asks for it, and
      // then it is written into the document so the next look is free.
      const [entry] = (await history.entries()).filter((item) => item.id === req.params.id);
      if (!entry) throw new AppError(404, 'That recording is not in your history.');
      const language = await providers.language(entry.originalTranscript, signal);
      const updated = await history.update(entry.id, (current) => ({ ...current, language }));
      if (!updated) throw new AppError(404, 'That recording is not in your history.');
      return { entry: updated };
    }),
  );
  app.post(
    '/api/history',
    endpoint(async (req) => {
      const body = historyRewriteSchema.safeParse(req.body);
      if (!body.success) throw new AppError(400, 'Send the history markdown to store.');
      await history.rewrite(body.data.markdown);
      return { markdown: body.data.markdown };
    }),
  );
  app.post(
    '/api/history/entries',
    endpoint(async (req) => {
      const entry = historyEntrySchema.safeParse(req.body);
      if (!entry.success)
        throw new AppError(400, 'Send one recording with its original and polished text.');
      await history.append(entry.data);
      return { id: entry.data.id };
    }),
  );
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API endpoint.' }));
  app.use((error: Error & { type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) return res.status(error.status).json({ error: error.message });
    if (error.type === 'entity.too.large')
      return res.status(413).json({ error: 'This request is too large.' });
    if (error instanceof SyntaxError)
      return res.status(400).json({ error: 'Invalid request data.' });
    res.status(500).json({ error: 'This step could not be completed. Please retry.' });
  });
  return app;
}
