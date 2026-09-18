import { tauriShell } from './tauri';
import type { Shell } from './types';

export type { Shell, ShellInfo, InsertResult } from './types';

export function createShell(): Shell {
  return tauriShell;
}
