import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHistoryStore, parseEntries, renderEntry } from '../server/history';
import type { HistoryEntry } from '../shared/types';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'just-speak-history-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: '2b7a1c3e-4d5f-4a6b-8c9d-0e1f2a3b4c5d',
    createdAt: '2026-09-17T15:41:02.000Z',
    duration: 12.4,
    originalTranscript: 'I goes home and I see my friend.',
    polished: 'I go home and I see my friend.',
    ...overrides,
  };
}

describe('markdown history', () => {
  it('reads as empty before anything is written', async () => {
    expect(await createHistoryStore(dir).read()).toBe('');
  });
  it('keeps the original beside the polished text, and never audio', async () => {
    const store = createHistoryStore(dir);
    await store.append(entry());
    const markdown = await readFile(join(dir, 'entries.md'), 'utf8');
    expect(markdown).toContain('I goes home and I see my friend.');
    expect(markdown).toContain('I go home and I see my friend.');
    expect(markdown).toContain('<!-- entry: 2026-09-17T15:41:02.000Z 2b7a1c3e');
    expect(markdown).toMatch(/## 2026-09-17 \d\d:41 — 0:12/);
    expect(markdown).not.toContain('audio');
  });
  it('writes the coaching when there is any', async () => {
    const markdown = renderEntry(
      entry({
        language: {
          summary: 'Almost right.',
          corrections: [
            {
              original: 'I goes',
              suggestion: 'I go',
              kind: 'grammar',
              explanation: 'Third person agreement.',
            },
          ],
          practice: 'Say it again in the past tense.',
        },
        speaking: 'What works: clear vowels.',
      }),
    );
    expect(markdown).toContain('### Grammar');
    expect(markdown).toContain('- **I goes** → I go _(grammar)_: Third person agreement.');
    expect(markdown).toContain('Practice: Say it again in the past tense.');
    expect(markdown).toContain('### Speaking');
    expect(markdown).toContain('What works: clear vowels.');
  });
  it('appends rather than replaces, including two recordings at once', async () => {
    const store = createHistoryStore(dir);
    const first = entry({ id: '11111111-1111-4111-8111-111111111111' });
    const second = entry({
      id: '22222222-2222-4222-8222-222222222222',
      createdAt: '2026-09-17T16:00:00.000Z',
    });
    await Promise.all([store.append(first), store.append(second)]);
    const markdown = await store.read();
    expect(markdown).toContain(first.id);
    expect(markdown).toContain(second.id);
    expect(markdown.match(/^## /gm)).toHaveLength(2);
  });
  it('reads back what it wrote, so an entry can be edited in place', async () => {
    const store = createHistoryStore(dir);
    const written = entry({
      language: {
        summary: 'Almost right.',
        corrections: [
          {
            original: 'I goes',
            suggestion: 'I go',
            kind: 'grammar',
            explanation: 'Third person agreement.',
          },
        ],
        practice: 'Say it in the past tense.',
      },
      speaking: 'What works: clear vowels.',
    });
    await store.append(written);

    const [read] = await store.entries();
    expect(read).toEqual(written);

    // And a change to one entry leaves the round trip intact.
    const updated = await store.update(written.id, (current) => ({
      ...current,
      speaking: 'Rewritten coaching.',
    }));
    expect(updated?.speaking).toBe('Rewritten coaching.');
    const [again] = await store.entries();
    expect(again.speaking).toBe('Rewritten coaching.');
    expect(again.language).toEqual(written.language);
    expect(again.duration).toBe(written.duration);
  });

  it('reads entries written before the duration was in the marker', async () => {
    // Every recording made before this existed has a marker without it.
    const legacy = [
      '<!-- entry: 2026-09-17T15:41:02.000Z 2b7a1c3e-4d5f-4a6b-8c9d-0e1f2a3b4c5d -->',
      '## 2026-09-17 23:41 — 1:05',
      '',
      '**Polished**',
      '',
      'I go home.',
      '',
      '**Original**',
      '',
      'I goes home.',
      '',
      '',
    ].join('\n');
    const [entry] = parseEntries(legacy);
    expect(entry?.id).toBe('2b7a1c3e-4d5f-4a6b-8c9d-0e1f2a3b4c5d');
    expect(entry?.duration).toBe(65);
    expect(entry?.polished).toBe('I go home.');
    expect(entry?.originalTranscript).toBe('I goes home.');
  });

  it('updates only the entry it was asked for', async () => {
    const store = createHistoryStore(dir);
    const first = entry({ id: '11111111-1111-4111-8111-111111111111', polished: 'First.' });
    const second = entry({ id: '22222222-2222-4222-8222-222222222222', polished: 'Second.' });
    await store.append(first);
    await store.append(second);

    await store.update(first.id, (current) => ({ ...current, polished: 'First, polished.' }));
    const entries = await store.entries();
    expect(entries.map((item) => item.polished)).toEqual(['First, polished.', 'Second.']);
    expect(await store.update('33333333-3333-4333-8333-333333333333', (item) => item)).toBeUndefined();
  });

  it('rewrites the whole document, which is how an entry is deleted', async () => {
    const store = createHistoryStore(dir);
    await store.append(entry());
    await store.append(
      entry({
        id: '33333333-3333-4333-8333-333333333333',
        originalTranscript: 'Keep me.',
        polished: 'Keep me.',
      }),
    );
    // Which is exactly what the entry comments are for: a block can be found and
    // dropped without parsing the prose around it.
    const remove = (markdown: string, id: string) =>
      markdown
        .split(/(?=<!-- entry: )/)
        .filter((part) => !part.includes(id))
        .join('');
    await store.rewrite(remove(await store.read(), '2b7a1c3e-4d5f-4a6b-8c9d-0e1f2a3b4c5d'));

    const markdown = await store.read();
    expect(markdown).not.toContain('2b7a1c3e-4d5f-4a6b-8c9d-0e1f2a3b4c5d');
    expect(markdown).toContain('33333333-3333-4333-8333-333333333333');
  });
});
