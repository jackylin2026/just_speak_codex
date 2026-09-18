import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { downloadedModels } from '../server/model-cache';

let modelsDir: string;

beforeEach(() => {
  modelsDir = mkdtempSync(join(tmpdir(), 'just-speak-cache-'));
});
afterEach(() => rmSync(modelsDir, { recursive: true, force: true }));

/** What the hub cache looks like once `faster-whisper-<model>` has landed on this computer. */
function snapshot(model: string, files: string[], options: { dangling?: string } = {}) {
  const dir = join(modelsDir, `models--Systran--faster-whisper-${model}`, 'snapshots', 'a1b2c3');
  const blobs = join(modelsDir, `models--Systran--faster-whisper-${model}`, 'blobs');
  mkdirSync(dir, { recursive: true });
  mkdirSync(blobs, { recursive: true });
  for (const name of files) {
    const blob = join(blobs, `blob-${name}`);
    writeFileSync(blob, 'weights');
    // Real caches link the snapshot at the blob; the check has to follow that link.
    if (name === options.dangling) symlinkSync(join(blobs, 'gone'), join(dir, name));
    else symlinkSync(blob, join(dir, name));
  }
}

const EVERYTHING = ['model.bin', 'config.json', 'tokenizer.json', 'vocabulary.txt'];

describe('what is on disk', () => {
  it('finds nothing in an empty directory', () => {
    expect(downloadedModels(modelsDir)).toEqual([]);
  });

  it('finds nothing when the directory does not exist at all', () => {
    expect(downloadedModels(join(modelsDir, 'nowhere'))).toEqual([]);
  });

  it('counts a complete snapshot', () => {
    snapshot('base.en', EVERYTHING);
    expect(downloadedModels(modelsDir)).toEqual(['base.en']);
  });

  it('counts each model separately', () => {
    snapshot('base.en', EVERYTHING);
    snapshot('small.en', EVERYTHING);
    expect(downloadedModels(modelsDir)).toEqual(['base.en', 'small.en']);
  });

  it('does not count an interrupted download, whose weights never landed', () => {
    // The hub links a file into the snapshot only once that file has finished, so a
    // half-fetched model.bin is missing here while the small files are already present.
    snapshot('base.en', ['config.json', 'tokenizer.json', 'vocabulary.txt']);
    expect(downloadedModels(modelsDir)).toEqual([]);
  });

  it('does not count a snapshot whose blobs have been pruned away', () => {
    snapshot('small.en', EVERYTHING, { dangling: 'model.bin' });
    expect(downloadedModels(modelsDir)).toEqual([]);
  });

  it('does not count an empty file as weights', () => {
    const dir = join(modelsDir, 'models--Systran--faster-whisper-base.en', 'snapshots', 'a1b2c3');
    mkdirSync(dir, { recursive: true });
    for (const name of EVERYTHING) writeFileSync(join(dir, name), '');
    expect(downloadedModels(modelsDir)).toEqual([]);
  });
});
