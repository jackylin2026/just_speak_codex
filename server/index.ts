import { createServer } from 'node:http';

import { createApp } from './app';
import { createConfig, loadEnv } from './config';
import { createHistoryStore } from './history';
import { LocalTranscriber } from './local-transcriber';
import { createProviders } from './providers';
import { attachStream } from './stream';

// Before anything reads the environment: the shell launches this process from an unknown
// working directory, so `.env` is resolved by absolute path (see config.ts).
loadEnv();
const config = createConfig(process.env);

const local = new LocalTranscriber(config.local);
// Wired after the stream exists: the app is needed to build the server, the server to
// build the stream, and the figure in Settings comes from the stream.
let heldAudio = () => 0;
const app = createApp({
  providers: createProviders(process.env, fetch, local),
  history: createHistoryStore(config.historyDir),
  port: config.port,
  origins: config.origins,
  heldAudio: () => heldAudio(),
  setup: config.setup,
});

// The API is the whole server now: the frontend is a webview loading the app bundle, so
// there is no static host and no Vite middleware here.
const server = createServer(app);
const stream = attachStream(server, { origins: config.origins, transcriber: local });
heldAudio = () => stream.held();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    local.close();
    server.close(() => process.exit(0));
    // The shell kills by process group as well; this is for a server run by hand.
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
process.on('exit', () => local.close());

server.listen(config.port, '127.0.0.1', () => {
  console.log(`just_speak_codex API is ready at http://127.0.0.1:${config.port}`);
  console.log(`Data directory: ${config.dataDir}`);
});
