import { describe, expect, it, vi } from 'vitest';

import { prepareAndFollow, prepareControl, prepareNotice } from '../src/model-preparation';
import type { LocalModel, LocalStatus, Readiness } from '../shared/types';

const at = (state: LocalStatus['status'], extra: Partial<LocalStatus> = {}): LocalStatus => ({
  status: state,
  model: 'base.en',
  threads: 6,
  downloaded: [],
  ...extra,
});

const status = (state: LocalStatus['status'], model: LocalModel = 'base.en'): Readiness => ({
  openai: false,
  cerebras: false,
  models: { speaking: 'gpt-audio', text: 'qwen' },
  local: at(state, { model }),
});

describe('following a preparation', () => {
  it('keeps reading until the model is no longer loading', async () => {
    const seen: string[] = [];
    const readiness = vi
      .fn()
      .mockResolvedValueOnce(status('loading'))
      .mockResolvedValueOnce(status('loading'))
      .mockResolvedValueOnce(status('ready'));
    const api = { prepare: vi.fn(async () => {}), readiness };

    const last = await prepareAndFollow(api, 'base.en', (value) => seen.push(value.local!.status), {
      waitMs: 0,
    });

    expect(api.prepare).toHaveBeenCalledWith('base.en');
    expect(seen).toEqual(['loading', 'loading', 'ready']);
    expect(last.local?.status).toBe('ready');
    expect(readiness).toHaveBeenCalledTimes(3);
  });

  it('stops on a failure rather than waiting for ever', async () => {
    const seen: string[] = [];
    const api = {
      prepare: vi.fn(async () => {}),
      readiness: vi.fn(async () => status('error')),
    };
    await prepareAndFollow(api, 'small.en', (value) => seen.push(value.local!.status), { waitMs: 0 });
    expect(seen).toEqual(['error']);
    expect(api.readiness).toHaveBeenCalledTimes(1);
  });

  it('reports the first status even when the model is already loaded', async () => {
    const seen: string[] = [];
    const api = {
      prepare: vi.fn(async () => {}),
      readiness: vi.fn(async () => status('ready')),
    };
    await prepareAndFollow(api, 'base.en', (value) => seen.push(value.local!.status), { waitMs: 0 });
    expect(seen).toEqual(['ready']);
  });
});

describe('the model control', () => {
  it('offers a download when the model is not here', () => {
    expect(prepareControl(at('idle'), 'base.en')).toEqual({
      label: 'Start Download',
      enabled: true,
    });
  });

  it('is done already when the model is on disk but this session has loaded nothing', () => {
    expect(prepareControl(at('idle', { downloaded: ['base.en'] }), 'base.en')).toEqual({
      label: 'Downloaded',
      enabled: false,
    });
  });

  it('counts a loaded model as here, whatever the directory says', () => {
    expect(prepareControl(at('ready'), 'base.en')).toEqual({
      label: 'Downloaded',
      enabled: false,
    });
  });

  it('is busy exactly while it is fetching this model', () => {
    expect(prepareControl(at('loading'), 'base.en')).toEqual({
      label: 'Downloading…',
      enabled: false,
    });
  });

  it('offers to try again after a failure', () => {
    expect(prepareControl(at('error'), 'base.en')).toEqual({
      label: 'Restart Download',
      enabled: true,
    });
  });

  it('cannot offer a download with no Python to run it', () => {
    expect(prepareControl(at('not-installed'), 'base.en')).toEqual({
      label: 'Not installed',
      enabled: false,
    });
  });

  it('answers for the model chosen, not the one on disk', () => {
    const onDisk = at('idle', { downloaded: ['small.en'] });
    expect(prepareControl(onDisk, 'small.en').label).toBe('Downloaded');
    expect(prepareControl(onDisk, 'base.en').label).toBe('Start Download');
  });
});

describe('what the status strip is told', () => {
  it('names the size of a first download', () => {
    expect(prepareNotice(at('loading', { model: 'small.en' }), 'small.en')).toBe(
      'Downloading small.en — the first time, this is 464 MB and takes a few minutes.',
    );
  });

  it('does not promise a download that is only a load', () => {
    expect(prepareNotice(at('loading', { downloaded: ['base.en'] }), 'base.en')).toBe(
      'Loading base.en into memory…',
    );
  });

  it('repeats what the server said went wrong', () => {
    expect(prepareNotice(at('error', { error: 'No route to Hugging Face.' }), 'base.en')).toBe(
      'No route to Hugging Face.',
    );
  });

  it('stays quiet when there is nothing to report', () => {
    expect(prepareNotice(at('ready', { downloaded: ['base.en'] }), 'base.en')).toBeUndefined();
    expect(prepareNotice(at('idle'), 'base.en')).toBeUndefined();
    expect(prepareNotice(undefined, 'base.en')).toBeUndefined();
  });
});
