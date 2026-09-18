// Streams a WAV file through /api/stream exactly the way the recorder will: a start
// message, ~100 ms of 24 kHz 16-bit mono PCM per frame, then stop. Prints every event
// with the time it arrived, so the latency of the first segment is visible rather than
// asserted.
//
//   node scripts/stream-check.mjs /path/to/speech.wav [port] [model]
//
// The file must already be 24 kHz, mono, 16-bit PCM:
//   ffmpeg -i input -ac 1 -ar 24000 -sample_fmt s16 speech.wav
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';

const [, , file, port = '3000', model = 'base.en'] = process.argv;
if (!file) {
  console.error('usage: node scripts/stream-check.mjs speech.wav [port] [model]');
  process.exit(2);
}

const audio = readFileSync(file).subarray(44); // skip the WAV header
const frame = 4800; // 100 ms
const socket = new WebSocket(`ws://127.0.0.1:${port}/api/stream`, {
  headers: { Origin: 'tauri://localhost' },
});
const started = Date.now();
const at = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;

socket.on('open', () => console.log(`${at()} connected, ${audio.length / 2 / 24000}s of audio`));
socket.on('error', (error) => {
  console.error(`${at()} socket failed: ${error.message}`);
  process.exit(1);
});
socket.on('message', (data) => console.log(`${at()} ${data.toString()}`));

let sent = 0;
await new Promise((resolve) => socket.once('open', resolve));
socket.send(JSON.stringify({ type: 'start', model }));

while (sent < audio.length) {
  socket.send(audio.subarray(sent, sent + frame));
  sent += frame;
  await delay(100); // real time, the way a microphone delivers it
}

socket.send(JSON.stringify({ type: 'stop' }));
// The server keeps the socket open after `done`: it is the client's recording, and the
// client is the one that knows when it is finished with it.
await new Promise((resolve) => {
  socket.on('message', (data) => {
    if (JSON.parse(data.toString()).type === 'done') resolve();
  });
});
console.log(`${at()} finished`);
socket.close();
