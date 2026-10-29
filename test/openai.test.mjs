import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';

import { BackendError, classify, generateOpenAI } from '../src/openai.mjs';
import { fakePng, json, parseForm, startServer, tempDir, testConfig } from './helpers.mjs';

const KEY = 'test-openai-key-0000';
const b64 = fakePng(1024, 1536).toString('base64');
let reply = (res) => json(res, 200, { created: 1, data: [{ b64_json: b64 }], quality: 'low' });
const api = await startServer((req, body, res) => reply(res, req, body));
after(() => api.close());

const input = { prompt: 'a red fox in snow', references: [], format: 'portrait', quality: 'low', variants: 1 };

test('text to image: JSON request to /images/generations with the model, size, n and quality', async () => {
  const r = await generateOpenAI(testConfig({ openaiUrl: api.url }), input);
  const req = api.requests.at(-1);
  assert.equal(req.method, 'POST');
  assert.equal(req.url, '/images/generations');
  assert.equal(req.headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(JSON.parse(req.body.toString()), { model: 'gpt-image-1', prompt: 'a red fox in snow', n: 1, size: '1024x1536', quality: 'low' });
  assert.equal(r.images.length, 1);
  assert.deepEqual(r.images[0], fakePng(1024, 1536));
  assert.equal(r.quality, 'low');
});

test('with references: multipart to /images/edits, one image[] part per reference', async () => {
  const dir = tempDir();
  const refs = ['a.png', 'b.jpg'].map((name) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, fakePng(64, 64));
    return file;
  });
  await generateOpenAI(testConfig({ openaiUrl: api.url }), { ...input, references: refs, format: 'landscape', quality: undefined, variants: 2 });
  const req = api.requests.at(-1);
  assert.equal(req.url, '/images/edits');
  const form = await parseForm(req);
  assert.equal(form.get('model'), 'gpt-image-1');
  assert.equal(form.get('size'), '1536x1024');
  assert.equal(form.get('n'), '2');
  assert.equal(form.get('quality'), null);
  const images = form.getAll('image[]');
  assert.deepEqual(images.map((f) => [f.name, f.type]), [['a.png', 'image/png'], ['b.jpg', 'image/jpeg']]);
});

test('HTTP errors keep the status, carry the API message and never the key', async () => {
  reply = (res) => json(res, 401, { error: { message: `Incorrect API key provided: ${KEY}.`, code: 'invalid_api_key' } });
  await assert.rejects(generateOpenAI(testConfig({ openaiUrl: api.url }), input), (e) => {
    assert.equal(e.status, 401);
    assert.match(e.message, /^HTTP 401: Incorrect API key provided: \[redacted\]\./);
    assert.ok(!e.message.includes(KEY) && !e.body.includes(KEY));
    return true;
  });
  reply = (res) => json(res, 200, { data: [] });
  await assert.rejects(generateOpenAI(testConfig({ openaiUrl: api.url }), input), /no images/);
});

test('no key: rejected before any request', async () => {
  const before = api.requests.length;
  await assert.rejects(generateOpenAI(testConfig({ openaiUrl: api.url, apiKey: '' }), input), /OPENAI_API_KEY is not set/);
  assert.equal(api.requests.length, before);
});

test('network failure is status 0', async () => {
  await assert.rejects(generateOpenAI(testConfig({ openaiUrl: 'http://127.0.0.1:9' }), input), (e) => e.status === 0);
});

test('classify: rate-limited, unavailable, refused', () => {
  assert.equal(classify(new BackendError(429, 'HTTP 429: Rate limit reached')), 'rate-limited');
  assert.equal(classify(new BackendError(400, 'x', '{"error":{"code":"insufficient_quota"}}')), 'rate-limited');
  for (const status of [0, 401, 403, 404, 500, 503]) assert.equal(classify(new BackendError(status, 'x')), 'unavailable');
  assert.equal(classify(new BackendError(400, 'HTTP 400: Your request was rejected by the safety system')), 'refused');
});
