import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createConfig, loadEnv, root } from '../server/config';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'just-speak-config-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('configuration', () => {
  it('keeps everything in the repository by default', () => {
    const config = createConfig({});
    expect(config.port).toBe(3000);
    expect(config.dataDir).toBe(root);
    expect(config.historyDir).toBe(join(root, 'history'));
    expect(config.local.python).toBe(join(root, '.venv', 'bin', 'python'));
    expect(config.local.modelsDir).toBe(join(root, '.local-models'));
    expect(config.local.script).toBe(join(root, 'local', 'worker.py'));
  });
  it('moves the data directory when asked, which is what packaging does', () => {
    const data = join(dir, 'app-data');
    const config = createConfig({ JUST_SPEAK_DATA_DIR: data });
    expect(config.dataDir).toBe(data);
    expect(config.historyDir).toBe(join(data, 'history'));
    expect(config.local.python).toBe(join(data, '.venv', 'bin', 'python'));
    expect(config.local.modelsDir).toBe(join(data, '.local-models'));
  });
  it('lets each path be overridden on its own', () => {
    const config = createConfig({
      JUST_SPEAK_DATA_DIR: join(dir, 'app-data'),
      LOCAL_MODELS_DIR: join(dir, 'models'),
      LOCAL_WHISPER_PYTHON: '/opt/python/bin/python3',
    });
    expect(config.local.modelsDir).toBe(join(dir, 'models'));
    expect(config.local.python).toBe('/opt/python/bin/python3');
  });
  it('answers the Tauri webview, the dev server, and nothing else', () => {
    const config = createConfig({ PORT: '4321' });
    expect(config.origins).toEqual(
      expect.arrayContaining([
        'tauri://localhost',
        'http://tauri.localhost',
        'http://localhost:4321',
        'http://127.0.0.1:4321',
        'http://localhost:1420',
      ]),
    );
    expect(createConfig({ JUST_SPEAK_DEV_ORIGIN: 'http://localhost:5199' }).origins).toContain(
      'http://localhost:5199',
    );
  });
  it('refuses settings it cannot honour', () => {
    expect(() => createConfig({ PORT: '80' })).toThrow('PORT');
    expect(() => createConfig({ PORT: 'http' })).toThrow('PORT');
    expect(() => createConfig({ LOCAL_WHISPER_THREADS: '0' })).toThrow('LOCAL_WHISPER_THREADS');
    expect(() => createConfig({ LOCAL_WHISPER_THREADS: '64' })).toThrow('LOCAL_WHISPER_THREADS');
    expect(createConfig({ LOCAL_WHISPER_THREADS: '3' }).local.threads).toBe(3);
  });
});

describe('environment file', () => {
  it('loads .env by absolute path, so the working directory does not matter', async () => {
    const path = join(dir, '.env');
    await writeFile(path, 'JUST_SPEAK_TEST_KEY=from-file\n', 'utf8');
    delete process.env.JUST_SPEAK_TEST_KEY;
    expect(loadEnv({ DOTENV_CONFIG_PATH: path })).toBe(path);
    expect(process.env.JUST_SPEAK_TEST_KEY).toBe('from-file');
    delete process.env.JUST_SPEAK_TEST_KEY;
  });
  it('reports the default location when nothing overrides it', () => {
    expect(loadEnv({ DOTENV_CONFIG_PATH: join(dir, 'missing.env') })).toBe(
      join(dir, 'missing.env'),
    );
    expect(loadEnv({})).toBe(join(root, '.env'));
  });
});
