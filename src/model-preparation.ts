import type { Api } from './api';
import type { LocalModel, LocalStatus, Readiness } from '../shared/types';

/** What a model weighs the first time it is fetched. */
const SIZES: Record<LocalModel, string> = { 'base.en': '141 MB', 'small.en': '464 MB' };

export interface PrepareControl {
  label: string;
  enabled: boolean;
}

/**
 * The control for one model, as a state of that model rather than a button beside a
 * description of it.
 *
 * Whether the model is already here is a question about the disk, not about this session:
 * a status alone forgets at every restart, and would offer to download a model that has
 * been sitting in the cache for days. `ready` outranks the disk check because a loaded
 * model is proof it is here, whatever the directory says.
 */
export function prepareControl(local: LocalStatus | undefined, model: LocalModel): PrepareControl {
  // Empty rather than absent when the reply is older than this window: a server that never
  // heard the question is not evidence that a model is here, but it is not a crash either.
  const here = local?.downloaded ?? [];
  if (local?.status === 'not-installed') return { label: 'Not installed', enabled: false };
  // Whatever failed, preparing again is the remedy — it fetches what is missing and
  // reloads what is broken. Why it failed belongs in the status strip, not in the label.
  if (local?.status === 'error') return { label: 'Restart Download', enabled: true };
  if (local?.status === 'loading' && local.model === model)
    return { label: 'Downloading…', enabled: false };
  if (local?.status === 'ready' && local.model === model)
    return { label: 'Downloaded', enabled: false };
  if (here.includes(model)) return { label: 'Downloaded', enabled: false };
  return { label: 'Start Download', enabled: true };
}

/**
 * What the app is busy with, or what went wrong: the detail box's status strip, and nothing
 * else — undefined leaves it empty, which is where it belongs when there is nothing to
 * report.
 */
export function prepareNotice(
  local: LocalStatus | undefined,
  model: LocalModel,
): string | undefined {
  if (local?.status === 'error')
    return local.error ?? 'The local model could not be prepared. Check your connection and retry.';
  if (local?.status !== 'loading') return undefined;
  const name = local.model ?? model;
  return (local.downloaded ?? []).includes(name)
    ? `Loading ${name} into memory…`
    : `Downloading ${name} — the first time, this is ${SIZES[name]} and takes a few minutes.`;
}

/**
 * Prepare a model, and follow the preparation to its end.
 *
 * Preparing is not a request that finishes: it starts a download and a load, and the status
 * goes `loading` → `ready` some minutes later. Reading the status once, immediately after
 * asking, photographs the first moment of it — which is what left the detail box saying
 * "loading" for ever while the model was in fact ready.
 *
 * Returns the last status it saw, so the caller can stop caring when the answer is no
 * longer "loading".
 */
export async function prepareAndFollow(
  api: Pick<Api, 'prepare' | 'readiness'>,
  model: LocalModel,
  onChange: (readiness: Readiness) => void,
  options: { waitMs?: number; patienceMs?: number } = {},
): Promise<Readiness> {
  const waitMs = options.waitMs ?? 2000;
  const deadline = Date.now() + (options.patienceMs ?? 30 * 60 * 1000);

  await api.prepare(model);
  let latest = await api.readiness();
  onChange(latest);

  while (latest.local?.status === 'loading' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    latest = await api.readiness();
    onChange(latest);
  }
  return latest;
}
