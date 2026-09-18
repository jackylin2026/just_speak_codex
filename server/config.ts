import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

/**
 * The repository root: correct from `server/config.ts` in development and from
 * `dist/server.js` after bundling, because both are one directory below it.
 */
export const root = fileURLToPath(new URL('../', import.meta.url));

export interface Config {
  port: number;
  /** Where the interpreter, models and history live; shown when something is missing. */
  setup: { script: string; dataDir: string };
  /** Browser origins the API answers. Anything else gets 403 before a route runs. */
  origins: string[];
  /** Where history, the Python environment and downloaded models live. */
  dataDir: string;
  historyDir: string;
  envPath: string;
  local: {
    python: string;
    script: string;
    modelsDir: string;
    threads: number;
  };
}

/**
 * Load `.env` from an absolute path.
 *
 * `dotenv` resolves a bare path against the current working directory, and the app
 * launches this server from wherever the shell happens to be — so a relative path loses
 * the keys silently. Resolve it here, and let the shell override with
 * `DOTENV_CONFIG_PATH`.
 */
export function loadEnv(env: NodeJS.ProcessEnv = process.env): string {
  const dataDir = env.JUST_SPEAK_DATA_DIR?.trim();
  const envPath =
    env.DOTENV_CONFIG_PATH?.trim() || (dataDir ? join(dataDir, '.env') : join(root, '.env'));
  dotenv.config({ path: envPath, quiet: true });
  return envPath;
}

export function createConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('PORT must be an integer between 1024 and 65535.');

  const dataDir = env.JUST_SPEAK_DATA_DIR?.trim() || root;

  const origins = [
    // The Tauri webview: `tauri://localhost` on Linux and macOS, and an http origin on
    // Windows. The webview is a browser, so its requests are cross-origin and need CORS.
    'tauri://localhost',
    'http://tauri.localhost',
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    // Vite, while the frontend is served by the dev server rather than by the app.
    env.JUST_SPEAK_DEV_ORIGIN?.trim() || 'http://localhost:1420',
  ];

  const threads = Number(env.LOCAL_WHISPER_THREADS || Math.min(6, availableParallelism()));
  if (!Number.isInteger(threads) || threads < 1 || threads > 32)
    throw new Error('LOCAL_WHISPER_THREADS must be an integer between 1 and 32.');

  return {
    port,
    setup: { script: join(root, 'scripts', 'setup-local.mjs'), dataDir },
    origins,
    dataDir,
    historyDir: join(dataDir, 'history'),
    // Beside the source while developing, in the user's data directory once installed:
    // an installed app cannot write next to itself, and its keys are not part of it.
    envPath:
      env.DOTENV_CONFIG_PATH?.trim() ||
      (env.JUST_SPEAK_DATA_DIR?.trim() ? join(dataDir, '.env') : join(root, '.env')),
    local: {
      python:
        env.LOCAL_WHISPER_PYTHON?.trim() ||
        join(dataDir, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
      script: join(root, 'local', 'worker.py'),
      // Packaging moves this out of the repository: an AppImage mounts read-only and
      // ephemerally, so a model cache inside it would be re-downloaded on every launch.
      modelsDir: env.LOCAL_MODELS_DIR?.trim() || join(dataDir, '.local-models'),
      threads,
    },
  };
}
