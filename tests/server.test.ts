import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../server/app';
import type { HistoryStore } from '../server/history';
import { createProviders, type Providers } from '../server/providers';
import { wav } from './wav';

const ORIGINS = ['tauri://localhost', 'http://localhost:3000', 'http://localhost:1420'];

function providers(): Providers {
  return {
    readiness: () => ({ openai: true, cerebras: true, models: { speaking: 's', text: 'l' } }),
    transcribe: vi.fn().mockResolvedValue('Hello'),
    polish: vi.fn().mockResolvedValue('Hello.'),
    language: vi
      .fn()
      .mockResolvedValue({ summary: 'Good', corrections: [], practice: 'Try again.' }),
    speaking: vi.fn().mockResolvedValue('Clear speaking.'),
  };
}
function history(): HistoryStore {
  return {
    read: vi.fn().mockResolvedValue('# History\n'),
    append: vi.fn().mockResolvedValue(undefined),
    rewrite: vi.fn().mockResolvedValue(undefined),
    entries: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockResolvedValue(undefined),
  };
}
function app(
  backend: Providers = providers(),
  store: HistoryStore = history(),
  timeoutMs = 60000,
) {
  return createApp({ providers: backend, history: store, port: 3000, origins: ORIGINS, timeoutMs });
}

describe('local API', () => {
  it('validates the local model and forwards it', async () => {
    const backend = providers();
    const server = app(backend);
    await request(server)
      .post('/api/transcribe')
      .set('Host', 'localhost:3000')
      .set('Content-Type', 'audio/wav')
      .set('X-Local-Model', '../../anything')
      .send(wav())
      .expect(400);
    expect(backend.transcribe).not.toHaveBeenCalled();
    await request(server)
      .post('/api/transcribe')
      .set('Host', 'localhost:3000')
      .set('Content-Type', 'audio/wav')
      .set('X-Local-Model', 'small.en')
      .send(wav())
      .expect(200);
    expect(backend.transcribe).toHaveBeenCalledWith(
      expect.any(Buffer),
      'small.en',
      expect.any(AbortSignal),
    );
  });
  it('starts model preparation only for approved models and local origins', async () => {
    const backend = providers();
    backend.prepareLocal = vi.fn();
    const server = app(backend);
    await request(server)
      .post('/api/local/prepare')
      .set('Host', 'localhost:3000')
      .send({ model: 'base.en' })
      .expect(202);
    expect(backend.prepareLocal).toHaveBeenCalledWith('base.en');
    await request(server)
      .post('/api/local/prepare')
      .set('Host', 'localhost:3000')
      .send({ model: 'large' })
      .expect(400);
    await request(server)
      .post('/api/local/prepare')
      .set('Host', 'localhost:3000')
      .set('Origin', 'https://example.com')
      .send({ model: 'base.en' })
      .expect(403);
    expect(backend.prepareLocal).toHaveBeenCalledTimes(1);
  });
  it('validates audio before either audio endpoint can call a provider', async () => {
    const backend = providers();
    const server = app(backend);
    for (const endpoint of ['transcribe', 'feedback/speaking']) {
      await request(server)
        .post(`/api/${endpoint}`)
        .set('Host', 'localhost:3000')
        .set('Content-Type', 'audio/wav')
        .send(Buffer.from('bad'))
        .expect(400);
      await request(server)
        .post(`/api/${endpoint}`)
        .set('Host', 'localhost:3000')
        .send({ text: 'Text is not audio' })
        .expect(400);
    }
    expect(backend.transcribe).not.toHaveBeenCalled();
    expect(backend.speaking).not.toHaveBeenCalled();
  });
  it('returns successful text and individual timing', async () => {
    const response = await request(app())
      .post('/api/transcribe')
      .set('Host', 'localhost:3000')
      .set('Content-Type', 'audio/wav')
      .send(wav())
      .expect(200);
    expect(response.body).toEqual({ text: 'Hello', ms: expect.any(Number) });
  });
  it('rejects oversized text, malformed JSON, and cross-origin requests', async () => {
    const backend = providers();
    const server = app(backend);
    await request(server)
      .post('/api/polish')
      .set('Host', 'localhost:3000')
      .send({ text: 'a'.repeat(12001) })
      .expect(400);
    await request(server)
      .post('/api/polish')
      .set('Host', 'localhost:3000')
      .set('Content-Type', 'application/json')
      .send('{bad')
      .expect(400);
    await request(server)
      .post('/api/polish')
      .set('Host', 'localhost:3000')
      .set('Origin', 'https://untrusted.example')
      .send({ text: 'hi' })
      .expect(403);
    await request(server).get('/api/config').set('Host', 'untrusted.example:3000').expect(403);
    expect(backend.polish).not.toHaveBeenCalled();
  });
  it('returns a recoverable timeout and cancels the upstream request', async () => {
    const backend = providers();
    backend.polish = vi.fn(
      (_text, signal) =>
        new Promise<string>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason)),
        ),
    );
    const response = await request(app(backend, history(), 15))
      .post('/api/polish')
      .set('Host', 'localhost:3000')
      .send({ text: 'Hello' })
      .expect(504);
    expect(response.body.error).toContain('timed out');
  });
  it('shows configuration without keys and explains missing credentials', async () => {
    const server = createApp({
      providers: createProviders({ OPENAI_API_KEY: 'test-secret' }),
      history: history(),
      port: 3000,
      origins: ORIGINS,
    });
    const response = await request(server)
      .get('/api/config')
      .set('Host', 'localhost:3000')
      .expect(200);
    expect(response.body.openai).toBe(true);
    expect(response.body.cerebras).toBe(false);
    expect(JSON.stringify(response.body)).not.toContain('test-secret');
    await request(server)
      .post('/api/polish')
      .set('Host', 'localhost:3000')
      .send({ text: 'Hi' })
      .expect(503);
  });
});

describe('the webview is a cross-origin caller', () => {
  it('answers preflights for the app origin with the headers the browser requires', async () => {
    const response = await request(app())
      .options('/api/polish')
      .set('Host', 'localhost:3000')
      .set('Origin', 'tauri://localhost')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type')
      .expect(204);
    expect(response.headers['access-control-allow-origin']).toBe('tauri://localhost');
    expect(response.headers['access-control-allow-headers']).toContain('Content-Type');
    expect(response.headers['access-control-allow-methods']).toContain('POST');
    expect(response.headers.vary).toContain('Origin');
  });
  it('allows the app origin and the dev server, and nothing else', async () => {
    for (const origin of ['tauri://localhost', 'http://localhost:1420']) {
      const response = await request(app())
        .get('/api/config')
        .set('Host', 'localhost:3000')
        .set('Origin', origin)
        .expect(200);
      expect(response.headers['access-control-allow-origin']).toBe(origin);
    }
    await request(app())
      .get('/api/config')
      .set('Host', 'localhost:3000')
      .set('Origin', 'tauri://not-ours')
      .expect(403);
  });
  it('leaves requests without an origin working, such as a local health check', async () => {
    await request(app()).get('/api/config').set('Host', 'localhost:3000').expect(200);
  });
});

describe('coaching on demand', () => {
  it('checks a past recording when asked, and writes the answer into the history', async () => {
    const stored = {
      id: '2b7a1c3e-4d5f-4a6b-8c9d-0e1f2a3b4c5d',
      createdAt: '2026-09-17T15:41:02.000Z',
      duration: 12,
      originalTranscript: 'I goes home.',
      polished: 'I go home.',
    };
    const store = history();
    vi.mocked(store.entries).mockResolvedValue([stored]);
    vi.mocked(store.update).mockImplementation(async (id, change) =>
      id === stored.id ? change(stored) : undefined,
    );
    const backend = providers();
    const server = app(backend, store);

    const response = await request(server)
      .post(`/api/history/entries/${stored.id}/feedback`)
      .set('Host', 'localhost:3000')
      .expect(200);
    expect(backend.language).toHaveBeenCalledWith('I goes home.', expect.any(AbortSignal));
    expect(response.body.entry.language).toMatchObject({ summary: 'Good' });

    // Nothing is invented for a recording that is not there.
    await request(server)
      .post('/api/history/entries/33333333-3333-4333-8333-333333333333/feedback')
      .set('Host', 'localhost:3000')
      .expect(404);
  });
  it('says how much audio is in memory, and how much there could be', async () => {
    const server = createApp({
      providers: providers(),
      history: history(),
      port: 3000,
      origins: ORIGINS,
      heldAudio: () => 1_234_567,
    });
    const response = await request(server)
      .get('/api/config')
      .set('Host', 'localhost:3000')
      .expect(200);
    expect(response.body.audio).toEqual({
      capSeconds: 600,
      capBytes: 600 * 24000 * 2,
      heldBytes: 1_234_567,
    });
  });
});

describe('history', () => {
  it('reads and rewrites the markdown file', async () => {
    const store = history();
    const server = app(providers(), store);
    const read = await request(server)
      .get('/api/history')
      .set('Host', 'localhost:3000')
      .expect(200);
    expect(read.body.markdown).toBe('# History\n');

    await request(server)
      .post('/api/history')
      .set('Host', 'localhost:3000')
      .send({ markdown: '# History\n\nnothing else\n' })
      .expect(200);
    expect(store.rewrite).toHaveBeenCalledWith('# History\n\nnothing else\n');
  });
  it('appends one recording and refuses an incomplete one', async () => {
    const store = history();
    const server = app(providers(), store);
    const entry = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      duration: 12.5,
      originalTranscript: 'I goes home.',
      polished: 'I go home.',
    };
    await request(server)
      .post('/api/history/entries')
      .set('Host', 'localhost:3000')
      .send(entry)
      .expect(200);
    expect(store.append).toHaveBeenCalledWith(expect.objectContaining({ id: entry.id }));
    await request(server)
      .post('/api/history/entries')
      .set('Host', 'localhost:3000')
      .send({ ...entry, polished: '' })
      .expect(400);
    await request(server)
      .post('/api/history/entries')
      .set('Host', 'localhost:3000')
      .send({ ...entry, id: 'not-a-uuid' })
      .expect(400);
    expect(store.append).toHaveBeenCalledTimes(1);
  });
});
