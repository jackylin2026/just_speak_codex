import { describe, expect, it } from 'vitest';

import { nextNotice, type Spoken } from '../src/detail/notice';

const said = (from: Spoken['from'], text: string, tone: 'info' | 'error' = 'error'): Spoken => ({
  from,
  text,
  tone,
});

describe('the status strip', () => {
  it('says what was said', () => {
    expect(nextNotice(undefined, 'recBar', { text: 'The text is on your clipboard.', tone: 'error' }))
      .toEqual(said('recBar', 'The text is on your clipboard.'));
  });

  it('takes the newest message, whichever voice said it', () => {
    const model = said('model', 'Downloading base.en — 141 MB.', 'info');
    expect(nextNotice(model, 'recBar', { text: 'The paste did not land.', tone: 'error' })).toEqual(
      said('recBar', 'The paste did not land.'),
    );
    expect(
      nextNotice(said('recBar', 'The paste did not land.'), 'detail', {
        text: 'Could not check this recording.',
        tone: 'error',
      }),
    ).toEqual(said('detail', 'Could not check this recording.'));
  });

  it('does not let a voice erase another voice by falling silent', () => {
    // The model's message is derived from every status poll, so it falls silent constantly.
    // That is not news about the rec bar's failed paste.
    const recBar = said('recBar', 'The paste did not land.');
    expect(nextNotice(recBar, 'model', undefined)).toBe(recBar);
    expect(nextNotice(recBar, 'detail', undefined)).toBe(recBar);
  });

  it('clears its own message when it falls silent', () => {
    expect(nextNotice(said('model', 'Downloading base.en.', 'info'), 'model', undefined)).toBeUndefined();
    // Nothing to clear is the same as cleared, and must not disturb anyone else.
    expect(nextNotice(undefined, 'model', undefined)).toBeUndefined();
  });

  it('ignores a voice repeating itself', () => {
    // Otherwise the poll that re-derives an unchanged message would outrank the rec bar's news.
    const downloading = said('model', 'Downloading base.en.', 'info');
    expect(nextNotice(downloading, 'model', { text: 'Downloading base.en.', tone: 'info' })).toBe(
      downloading,
    );
  });

  it('treats the same words in a different tone as news', () => {
    const loud = said('recBar', 'No microphone.', 'info');
    expect(nextNotice(loud, 'recBar', { text: 'No microphone.', tone: 'error' })).toEqual(
      said('recBar', 'No microphone.'),
    );
  });

  it('replaces its own message when it changes', () => {
    expect(
      nextNotice(said('model', 'Downloading base.en.', 'info'), 'model', {
        text: 'Loading base.en into memory…',
        tone: 'info',
      }),
    ).toEqual(said('model', 'Loading base.en into memory…', 'info'));
  });
});
