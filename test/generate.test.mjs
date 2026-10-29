import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';

import { createGenerator, validate } from '../src/generate.mjs';
import { fakeComfy, fakePng, json, startServer, tempDir, testConfig } from './helpers.mjs';

// The fake OpenAI answers with whatever `cloud` says; every request is counted.
let cloud = (res) => json(res, 200, { data: [{ b64_json: fakePng(1024, 1536).toString('base64') }] });
const api = await startServer((req, body, res) => cloud(res));
const comfy = await fakeComfy();
after(() => Promise.all([api.close(), comfy.close()]));

const calls = (server, prefix) => server.requests.filter((r) => r.url.startsWith(prefix)).length;

function setup({ apiKey } = {}) {
  let clock = 1_000_000;
  const out = tempDir();
  const config = testConfig({ openaiUrl: api.url, comfyUrl: comfy.url, outputDir: out, apiKey });
  const generate = createGenerator(config, { now: () => clock });
  return { generate, out, advance: (ms) => { clock += ms; } };
}

const lines = (text) => text.split('\n');

test('auto: OpenAI answers, the image is saved, the result names the backend and the file', async () => {
  const { generate, out } = setup();
  const file = path.join(out, 'fox.png');
  const text = await generate({ prompt: 'a fox', output: file });
  assert.match(lines(text)[0], /^OpenAI \(gpt-image-1, 1024x1536, default\) · 1 image · 0 s$/);
  assert.equal(lines(text)[1], file);
  assert.match(lines(text)[2], /^file:\/\/\/.*fox\.png$/);
  assert.deepEqual(fs.readFileSync(file), fakePng(1024, 1536));
});

test('auto: rate limit -> falls back to ComfyUI, then skips OpenAI for the pause, then tries it again', async () => {
  const { generate, out, advance } = setup();
  cloud = (res) => json(res, 429, { error: { message: 'Rate limit reached for images', code: 'rate_limit_exceeded' } });
  const before = { openai: api.requests.length, comfy: calls(comfy, '/prompt') };
  const first = await generate({ prompt: 'a fox', output: out });
  assert.match(lines(first)[0], /^Qwen-Image 2\.1 on ComfyUI \(768x1376\) · 1 image/);
  assert.match(lines(first)[1], /^OpenAI rate-limited \(HTTP 429: Rate limit reached for images\)$/);
  assert.match(lines(first)[2], /_comfyui\.png$/);
  assert.equal(api.requests.length, before.openai + 1);

  advance(10 * 60_000);
  const second = await generate({ prompt: 'a fox', output: out });
  assert.match(lines(second)[1], /^OpenAI skipped until \d\d:\d\d after a rate limit$/);
  assert.equal(api.requests.length, before.openai + 1); // no request during the pause
  assert.equal(calls(comfy, '/prompt'), before.comfy + 2);

  advance(6 * 60_000);
  cloud = (res) => json(res, 200, { data: [{ b64_json: fakePng(1024, 1536).toString('base64') }] });
  assert.match(await generate({ prompt: 'a fox', output: out }), /^OpenAI /);
});

test('auto: OpenAI unavailable (5xx) -> ComfyUI, without a pause', async () => {
  const { generate, out } = setup();
  cloud = (res) => json(res, 503, { error: { message: 'overloaded' } });
  assert.match(lines(await generate({ prompt: 'x', output: out }))[1], /^OpenAI unavailable \(HTTP 503: overloaded\)$/);
  const before = api.requests.length;
  await generate({ prompt: 'x', output: out });
  assert.equal(api.requests.length, before + 1);
});

test('auto: a refusal is not retried locally', async () => {
  const { generate, out } = setup();
  cloud = (res) => json(res, 400, { error: { message: 'Your request was rejected by the safety system.' } });
  const before = calls(comfy, '/prompt');
  await assert.rejects(generate({ prompt: 'x', output: out }), /^Error: OpenAI: HTTP 400: Your request was rejected.*use backend "comfyui"/);
  assert.equal(calls(comfy, '/prompt'), before);
});

test('backend "openai": no fallback; backend "comfyui": no cloud request', async () => {
  const { generate, out } = setup();
  cloud = (res) => json(res, 500, { error: { message: 'boom' } });
  const comfyBefore = calls(comfy, '/prompt');
  await assert.rejects(generate({ prompt: 'x', output: out, backend: 'openai' }), /^Error: OpenAI: HTTP 500: boom$/);
  assert.equal(calls(comfy, '/prompt'), comfyBefore);
  const apiBefore = api.requests.length;
  assert.match(await generate({ prompt: 'x', output: out, backend: 'comfyui', variants: 2 }), /· 2 images ·/);
  assert.equal(api.requests.length, apiBefore);
  assert.equal(fs.readdirSync(out).filter((f) => /_comfyui_v[12]\.png$/.test(f)).length, 2);
});

test('auto without OPENAI_API_KEY: straight to ComfyUI with a note', async () => {
  const { generate, out } = setup({ apiKey: '' });
  const before = api.requests.length;
  const text = await generate({ prompt: 'x', output: out });
  assert.match(lines(text)[1], /^OpenAI not configured/);
  assert.equal(api.requests.length, before);
});

test('validation: prompt, references, enums, variants, output', () => {
  const dir = tempDir();
  const ref = path.join(dir, 'r.png');
  fs.writeFileSync(ref, fakePng(8, 8));
  assert.deepEqual(validate({ prompt: ' p ' }), { prompt: 'p', references: [], format: 'portrait', quality: undefined, backend: 'auto', variants: 1, output: undefined });
  assert.throws(() => validate({ prompt: '  ' }), /prompt is required/);
  assert.throws(() => validate({ prompt: 'x'.repeat(4001) }), /longer than 4000/);
  assert.throws(() => validate({ prompt: 'p', references: 'r.png' }), /array/);
  assert.throws(() => validate({ prompt: 'p', references: Array(11).fill(ref) }), /at most 10/);
  assert.throws(() => validate({ prompt: 'p', references: [path.join(dir, 'missing.png')] }), /not found/);
  assert.throws(() => validate({ prompt: 'p', references: [path.join(dir, 'notes.txt')] }), /not a PNG/);
  assert.throws(() => validate({ prompt: 'p', format: 'vertical' }), /format must be one of/);
  assert.throws(() => validate({ prompt: 'p', backend: 'other' }), /backend must be one of/);
  assert.throws(() => validate({ prompt: 'p', variants: 5 }), /variants/);
  assert.throws(() => validate({ prompt: 'p', variants: 1.5 }), /variants/);
  assert.throws(() => validate({ prompt: 'p', output: 'a\0b' }), /output/);
  assert.throws(() => validate(null), /object/);
  assert.equal(validate({ prompt: 'p', references: [ref] }).references[0], ref);
});
