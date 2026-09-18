import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { LOCAL_MODELS, type LocalModel } from '../shared/types';

/**
 * The files the worker needs before it can load a model with no network. These are what
 * faster-whisper puts in a Hugging Face snapshot for a converted Whisper checkpoint.
 */
const NEEDED = ['model.bin', 'config.json', 'tokenizer.json', 'vocabulary.txt'];

/**
 * Which models are already on this computer, complete enough to load offline.
 *
 * A status that only says what is loaded forgets everything when the app restarts, and a
 * control built on it offers to download a model that has been sitting here for days. The
 * hub links each file into `snapshots/<revision>/` only once that file has finished
 * downloading — a half-downloaded `model.bin` is an unlinked `.incomplete` blob — so
 * requiring the whole file list, present and non-empty, is what separates a finished
 * download from an interrupted one. Sizes are deliberately not compared: the check should
 * not break when a checkpoint is re-exported a few bytes different.
 *
 * A handful of stats, uncached: readiness is polled every couple of seconds at most.
 */
export function downloadedModels(modelsDir: string): LocalModel[] {
  return LOCAL_MODELS.filter((model) => isComplete(join(modelsDir, repoDirectory(model))));
}

/** The directory the hub cache makes for the repository `WhisperModel(name)` resolves to. */
function repoDirectory(model: LocalModel): string {
  return `models--Systran--faster-whisper-${model}`;
}

function isComplete(repoDir: string): boolean {
  const snapshots = join(repoDir, 'snapshots');
  let revisions: string[];
  try {
    revisions = readdirSync(snapshots);
  } catch {
    return false;
  }
  return revisions.some((revision) => NEEDED.every((name) => isFile(join(snapshots, revision, name))));
}

function isFile(path: string): boolean {
  try {
    // Follows the symlink into the blob, so a link whose blob was pruned counts as absent.
    const stats = statSync(path);
    return stats.isFile() && stats.size > 0;
  } catch {
    return false;
  }
}
