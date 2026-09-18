import type { Notice } from '../shell/types';

/** Who is speaking. Every voice may replace what is on the strip; only its own it may clear. */
export type Voice = 'model' | 'detail' | 'recBar';

export type Spoken = Notice & { from: Voice };

/**
 * What the status strip should say next.
 *
 * One strip, three voices: Settings reporting the model, the detail box reporting itself,
 * and the rec bar reporting what a recording did. The newest message wins, whichever voice said it
 * — but silence only clears the voice that went quiet, because going quiet is not news
 * about anyone else. Without that rule the model's message, re-derived on every status
 * poll, would keep erasing the rec bar's account of a paste that never landed.
 *
 * A voice repeating itself changes nothing. That is the other half of the same problem:
 * the poll that re-derives an unchanged message must not outrank something newer.
 */
export function nextNotice(
  current: Spoken | undefined,
  from: Voice,
  message?: Notice,
): Spoken | undefined {
  if (!message) return current?.from === from ? undefined : current;
  if (current?.from === from && current.text === message.text && current.tone === message.tone)
    return current;
  return { ...message, from };
}
