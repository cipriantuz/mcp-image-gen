// Test helpers: a minimal PNG and a local HTTP server that records every request.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../src/config.mjs';

// Signature + IHDR header: enough for the size parser (no CRC check needed).
export function fakePng(width, height) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

// handler(req, body: Buffer, res) answers; every request is recorded as { method, url, headers, body }.
export async function startServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, body, res);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export const json = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
};

// Parses a multipart body the way fetch would, into a FormData.
export const parseForm = (req) => new Response(req.body, { headers: { 'content-type': req.headers['content-type'] } }).formData();

export function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-image-gen-test-'));
}

export function testConfig({ openaiUrl = 'http://127.0.0.1:9', comfyUrl = 'http://127.0.0.1:9', apiKey = 'test-openai-key-0000', outputDir = tempDir() } = {}) {
  return loadConfig({
    OPENAI_API_KEY: apiKey,
    OPENAI_BASE_URL: openaiUrl,
    COMFYUI_URL: comfyUrl,
    COMFYUI_POLL_MS: '5',
    COMFYUI_TIMEOUT_MS: '5000',
    IMAGE_OUTPUT_DIR: outputDir,
  });
}

// A fake ComfyUI: uploads, queue, history (pending once, then done) and view.
export async function fakeComfy({ failJob = false } = {}) {
  const workflows = [];
  let polls = 0;
  let next = 0;
  const server = await startServer(async (req, body, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'POST' && url.pathname === '/upload/image') {
      const form = await parseForm({ body, headers: req.headers });
      return json(res, 200, { name: form.get('image').name, subfolder: '', type: 'input' });
    }
    if (req.method === 'POST' && url.pathname === '/prompt') {
      workflows.push(JSON.parse(body.toString()).prompt);
      next += 1;
      return json(res, 200, { prompt_id: `p${next}`, number: next });
    }
    if (url.pathname.startsWith('/history/')) {
      const id = decodeURIComponent(url.pathname.slice('/history/'.length));
      polls += 1;
      if (polls % 2 === 1) return json(res, 200, {});
      if (failJob) return json(res, 200, { [id]: { status: { status_str: 'error', completed: false, messages: [['execution_error', { node: 'sampler' }]] }, outputs: {} } });
      return json(res, 200, {
        [id]: { status: { status_str: 'success', completed: true }, outputs: { save: { images: [{ filename: `${id}.png`, subfolder: '', type: 'output' }] } } },
      });
    }
    if (url.pathname === '/view') {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(fakePng(768, 1376));
    }
    json(res, 404, { error: 'not found' });
  });
  return { ...server, workflows };
}
