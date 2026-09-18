import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { HistoryEntry } from '../shared/types';

/**
 * The history is one markdown file that the user owns: readable in any editor, greppable,
 * and portable. The comparison between what was said and what was said better is the
 * point of it, so both are written; audio never is.
 *
 * Each entry is preceded by an HTML comment carrying its id, which renders as nothing
 * and lets an entry be found again after a rewrite (deleting one entry is a rewrite of
 * the whole document without it).
 */
export interface HistoryStore {
  read(): Promise<string>;
  append(entry: HistoryEntry): Promise<void>;
  rewrite(markdown: string): Promise<void>;
  /** The document, read back as recordings. The detail box needs the parts, not the prose. */
  entries(): Promise<HistoryEntry[]>;
  /** Replace one recording's block, leaving the rest of the document as it was. */
  update(id: string, change: (entry: HistoryEntry) => HistoryEntry): Promise<HistoryEntry | undefined>;
}

const FILE = 'entries.md';
const WIDTH = 2 * 1024 * 1024;

function two(value: number) {
  return String(value).padStart(2, '0');
}

function stamp(iso: string) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`;
}

function duration(seconds: number) {
  return `${Math.floor(seconds / 60)}:${two(Math.round(seconds % 60))}`;
}

export function renderEntry(entry: HistoryEntry): string {
  const lines = [
    // The duration is in the marker as well as the heading: the heading is for a person
    // to read, and the marker is what the document is read back from.
    `<!-- entry: ${entry.createdAt} ${entry.id} ${entry.duration} -->`,
    `## ${stamp(entry.createdAt)} — ${duration(entry.duration)}`,
    '',
    '**Polished**',
    '',
    entry.polished,
    '',
    '**Original**',
    '',
    entry.originalTranscript,
  ];

  if (entry.language) {
    lines.push('', '### Grammar', '', entry.language.summary);
    if (entry.language.corrections.length) {
      lines.push('');
      for (const correction of entry.language.corrections)
        lines.push(
          `- **${correction.original}** → ${correction.suggestion} _(${correction.kind})_: ${correction.explanation}`,
        );
    }
    lines.push('', `Practice: ${entry.language.practice}`);
  }

  if (entry.speaking) lines.push('', '### Speaking', '', entry.speaking);

  return `${lines.join('\n').trimEnd()}\n\n`;
}

// The duration is in the marker so that reading an entry back is exact. Entries written
// before it was there are still read: the heading has the duration as a person reads it.
const MARKER = /^<!-- entry: (\S+) (\S+)(?: ([\d.]+))? -->$/;
const HEADING = /^## .*— (\d+):(\d\d)$/m;

/**
 * Read the document back into recordings.
 *
 * This is the other half of renderEntry, and the two are tested against each other: what
 * is written must be readable again, or caching feedback into an entry would quietly lose
 * something. Anything the renderer does not write is simply absent.
 */
export function parseEntries(markdown: string): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const block of markdown.split(/(?=<!-- entry: )/)) {
    const lines = block.split('\n');
    const marker = MARKER.exec(lines[0] ?? '');
    if (!marker) continue;
    const [, createdAt, id, duration] = marker;
    const heading = HEADING.exec(block);
    const entry: HistoryEntry = {
      id,
      createdAt,
      duration: duration
        ? Number(duration)
        : heading
          ? Number(heading[1]) * 60 + Number(heading[2])
          : 0,
      originalTranscript: '',
      polished: '',
    };

    const section = (name: string) => {
      const start = lines.findIndex((line) => line.trim() === name);
      if (start === -1) return undefined;
      const rest = lines.slice(start + 1);
      const end = rest.findIndex((line) => /^(###|\*\*|<!-- )/.test(line.trim()));
      return rest.slice(0, end === -1 ? undefined : end).join('\n').trim();
    };

    entry.polished = section('**Polished**') ?? '';
    entry.originalTranscript = section('**Original**') ?? '';

    const grammar = lines.findIndex((line) => line.trim() === '### Grammar');
    if (grammar !== -1) {
      const rest = lines.slice(grammar + 1);
      const speakingAt = rest.findIndex((line) => line.trim() === '### Speaking');
      const grammarLines = speakingAt === -1 ? rest : rest.slice(0, speakingAt);
      const summary = grammarLines.slice(0, indexOf(grammarLines, (line) => line.startsWith('- ') || line.startsWith('Practice:')))
        .join('\n')
        .trim();
      const corrections = grammarLines
        .filter((line) => line.startsWith('- '))
        .map((line) => /^- \*\*(.+?)\*\* → (.*?) _\((grammar|phrasing)\)_: (.*)$/.exec(line))
        .filter((match): match is RegExpExecArray => match !== null)
        .map((match) => ({
          original: match[1],
          suggestion: match[2],
          kind: match[3] as 'grammar' | 'phrasing',
          explanation: match[4],
        }));
      const practice = grammarLines.find((line) => line.startsWith('Practice:'));
      entry.language = {
        summary: summary || 'Checked.',
        corrections,
        practice: practice ? practice.slice('Practice:'.length).trim() : 'Read it aloud once more.',
      };
    }

    const speaking = lines.findIndex((line) => line.trim() === '### Speaking');
    if (speaking !== -1) {
      const value = lines
        .slice(speaking + 1)
        .join('\n')
        .split(/(?=<!-- entry: )/)[0]
        .trim();
      if (value) entry.speaking = value;
    }

    if (entry.polished && entry.originalTranscript) entries.push(entry);
  }
  return entries;
}

function indexOf(lines: string[], match: (line: string) => boolean) {
  const found = lines.findIndex(match);
  return found === -1 ? lines.length : found;
}

export function createHistoryStore(dir: string): HistoryStore {
  const file = join(dir, FILE);
  // Appends and rewrites queue up rather than interleave: two recordings finishing at
  // once must not produce half-written sections.
  let queue: Promise<void> = Promise.resolve();

  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work, work);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const write = async (markdown: string) => {
    if (Buffer.byteLength(markdown) > WIDTH)
      throw new Error('The history file is too large to write.');
    await mkdir(dir, { recursive: true });
    // Write beside the target and rename: a crash mid-write leaves the old file whole.
    const temporary = `${file}.tmp`;
    await writeFile(temporary, markdown, 'utf8');
    await rename(temporary, file);
  };

  return {
    async read() {
      try {
        return await readFile(file, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
        throw error;
      }
    },
    append(entry) {
      return serialize(async () => {
        const existing = await this.read();
        const separator = existing && !existing.endsWith('\n\n') ? '\n' : '';
        await write(`${existing}${separator}${renderEntry(entry)}`);
      });
    },
    rewrite(markdown) {
      return serialize(() => write(markdown));
    },
    async entries() {
      return parseEntries(await this.read());
    },
    update(id, change) {
      return serialize(async () => {
        // Split on the markers and put the document back together unchanged, so that
        // editing one entry — caching its feedback, say — cannot disturb the others.
        const blocks = (await this.read()).split(/(?=<!-- entry: )/);
        let changed: HistoryEntry | undefined;
        const next = blocks.map((block) => {
          const marker = MARKER.exec(block.split('\n')[0] ?? '');
          if (!marker || marker[2] !== id) return block;
          const [entry] = parseEntries(block);
          if (!entry) return block;
          changed = change(entry);
          return renderEntry(changed);
        });
        if (!changed) return undefined;
        await write(next.join(''));
        return changed;
      });
    },
  };
}
