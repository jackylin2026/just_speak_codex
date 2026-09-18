import { DEFAULT_PREFERENCES, LOCAL_MODELS, type LocalModel, type Preferences } from '../shared/types';

/**
 * What the app remembers between recordings. It lives in this browser's storage, which is
 * per origin and per machine: the rec bar sets it, the detail box reads it, and nothing is sent
 * anywhere for safe-keeping.
 */
const KEY = 'just-speak.preferences';

export function loadPreferences(): Preferences {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Preferences>;
    const localModel = LOCAL_MODELS.includes(stored.localModel as LocalModel)
      ? (stored.localModel as LocalModel)
      : DEFAULT_PREFERENCES.localModel;
    return {
      localModel,
      audioCoaching: stored.audioCoaching ?? DEFAULT_PREFERENCES.audioCoaching,
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export function savePreferences(preferences: Preferences): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(preferences));
  } catch {
    // Storage can be unavailable; the defaults still work for this session.
  }
}

/** Preferences shared between the two windows of the same origin. */
export function watchPreferences(handler: (preferences: Preferences) => void): () => void {
  const listener = (event: StorageEvent) => {
    if (event.key === KEY) handler(loadPreferences());
  };
  window.addEventListener('storage', listener);
  return () => window.removeEventListener('storage', listener);
}
