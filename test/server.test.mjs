// End to end: the real server process over stdio, against the fake OpenAI and ComfyUI.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { after, before, test } from 'node:test';

import { fakeComfy, json, startServer, tempDir } from './helpers.mjs';

const KEY = 'test-openai-key-0000';
const out = tempDir();
let api;
let comfy;
let child;
let stderr = '';
let stdout = '';
const pending = new Map();
let nextId = 0;

function request(method, params) {
  nextId += 1;
  const id = nextId;
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((resolve) => pending.set(id, resolve));
}

before(async () => {
  // OpenAI rejects the key and echoes it back, as real APIs sometimes do.
  api = await startServer((req, body, res) => json(res, 401, { error: { message: `Incorrect API key provided: ${KEY}` } }));
  comfy = await fakeComfy();
  child = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'src', 'server.mjs')], {
    env: { ...process.env, OPENAI_API_KEY: KEY, OPENAI_BASE_URL: api.url, COMFYUI_URL: comfy.url, COMFYUI_POLL_MS: '5', IMAGE_OUTPUT_DIR: out },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => { stderr += d; });
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    stdout += `${line}\n`;
    const m = JSON.parse(line);
    pending.get(m.id)?.(m);
    pending.delete(m.id);
  });
});

after(async () => {
  child.kill();
  await Promise.all([api.close(), comfy.close()]);
});

test('initialize and tools/list', async () => {
  const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.result.capabilities, { tools: {} });
  assert.equal(init.result.serverInfo.name, 'mcp-image-gen');
  const list = await request('tools/list', {});
  assert.deepEqual(list.result.tools.map((t) => t.name), ['generate_image']);
  assert.deepEqual(list.result.tools[0].inputSchema.required, ['prompt']);
});

test('tools/call: OpenAI auth fails -> ComfyUI image saved; the key appears nowhere', async () => {
  const res = await request('tools/call', { name: 'generate_image', arguments: { prompt: 'a lighthouse at dusk', output: out } });
  const text = res.result.content[0].text;
  assert.equal(res.result.isError, undefined);
  assert.match(text, /^Qwen-Image 2\.1 on ComfyUI \(768x1376\) · 1 image/);
  assert.match(text, /OpenAI unavailable \(HTTP 401: Incorrect API key provided: \[redacted\]\)/);
  const file = text.split('\n')[2];
  assert.ok(fs.existsSync(file));
  assert.ok(!stdout.includes(KEY) && !stderr.includes(KEY));
});

test('invalid arguments come back as a tool error, not a crash', async () => {
  const res = await request('tools/call', { name: 'generate_image', arguments: { prompt: 'x', variants: 9 } });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /^Error: variants must be an integer from 1 to 4$/);
});

test('unknown tool and unknown method are JSON-RPC errors; notifications get no answer', async () => {
  assert.equal((await request('tools/call', { name: 'other', arguments: {} })).error.code, -32602);
  assert.equal((await request('resources/list', {})).error.code, -32601);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  assert.deepEqual((await request('ping', {})).result, {});
});
