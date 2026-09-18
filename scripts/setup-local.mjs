// Installs the Python environment local transcription runs in. Models are not downloaded
// here; they arrive when a model is prepared from Settings, into the same data directory.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// The same resolution as server/config.ts: a dev checkout keeps everything in the
// repository, a packaged build points JUST_SPEAK_DATA_DIR at user data.
const dataDir = process.env.JUST_SPEAK_DATA_DIR?.trim() || root;
const modelsDir = process.env.LOCAL_MODELS_DIR?.trim() || join(dataDir, '.local-models');
const cache = join(dataDir, '.local-runtime', 'uv-cache');
// uv venv takes the directory to create; uv pip install takes the interpreter inside it.
const venvDir = join(dataDir, '.venv');
const python = join(venvDir, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
// uv can fetch a Python of its own; the version is a request, not a requirement, because
// an interpreter that already exists is always reused below.
const version = process.env.LOCAL_WHISPER_PYTHON_VERSION?.trim() || '3.12';

const uv = spawnSync('uv', ['--version'], { stdio: 'ignore' });
if (uv.error || uv.status !== 0) {
  console.error(
    'Install uv (https://docs.astral.sh/uv/getting-started/installation/) and rerun npm run setup:local.',
  );
  process.exit(1);
}
function run(args) {
  const result = spawnSync('uv', args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      UV_CACHE_DIR: cache,
      UV_PYTHON_INSTALL_DIR: join(dataDir, '.local-runtime', 'python'),
    },
  });
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}
// LOCAL_WHISPER_PYTHON means the user brought an interpreter; leave it alone.
const existing = process.env.LOCAL_WHISPER_PYTHON?.trim();
if (existing) {
  if (!existsSync(existing)) {
    console.error(`LOCAL_WHISPER_PYTHON points at ${existing}, which does not exist.`);
    process.exit(1);
  }
} else if (!existsSync(python)) {
  run(['venv', '--python', version, venvDir]);
}
const interpreter = existing || python;
run(['pip', 'install', '--python', interpreter, '-r', join(root, 'local', 'requirements.txt')]);
const check = spawnSync(interpreter, ['-c', 'import faster_whisper'], { stdio: 'inherit' });
if (check.status !== 0) process.exit(1);
console.log(
  `Local transcription installed at ${interpreter}.\n` +
    `Models are stored in ${modelsDir} when you prepare one from Settings.`,
);
