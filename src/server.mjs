#!/usr/bin/env node
// MCP server over stdio (newline-delimited JSON-RPC 2.0): one tool, generate_image.
// stdout carries only protocol messages; nothing is logged, so no secret can leak there.
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

import { loadConfig } from './config.mjs';
import { BACKENDS, FORMATS, QUALITIES, createGenerator } from './generate.mjs';

const INSTRUCTIONS = 'The generate_image tool creates an image directly from the session: with the OpenAI Images API when it is configured, and automatically with Qwen-Image 2.1 on a local ComfyUI server when the cloud is rate-limited or unavailable. Use it whenever the user wants a new image (character, reference, background, thumbnail, sketch) instead of writing generation code. English prompts give better results. References keep a character, a place or a style. After generating, look at the image with Read before saying it is done, and give the user the image path and the file:/// link from the result.';

export const TOOL = {
  name: 'generate_image',
  description: 'Generates a PNG image and saves it to disk. Tries the OpenAI Images API first (when OPENAI_API_KEY is set); when it is rate-limited or unavailable, falls back automatically to Qwen-Image 2.1 on the local ComfyUI server. Returns the file paths and the backend used.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', maxLength: 4000, description: 'What the image must contain. English works best.' },
      output: { type: 'string', description: 'Folder or .png file to save to. Default: the image folder, in a subfolder per day.' },
      references: { type: 'array', items: { type: 'string' }, maxItems: 10, description: 'Paths to reference images (character, place, style); with them the image is made by editing.' },
      format: { type: 'string', enum: FORMATS, description: 'portrait (default): 1024x1536 on OpenAI, 768x1376 on ComfyUI. square: 1:1. landscape: the portrait sizes rotated.' },
      quality: { type: 'string', enum: QUALITIES, description: 'OpenAI only. Default: the model default.' },
      variants: { type: 'integer', minimum: 1, maximum: 4, description: 'How many variants (default 1).' },
      backend: { type: 'string', enum: BACKENDS, description: 'auto (default): OpenAI, then ComfyUI when OpenAI is rate-limited or unavailable. openai / comfyui: only that backend.' },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
  // Keeps the tool in the model's base tool list instead of behind deferred tool search.
  _meta: { 'anthropic/alwaysLoad': true },
};

export function createServer({ generate, write }) {
  const send = (message) => write(`${JSON.stringify(message)}\n`);

  return async function handle(line) {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      return;
    }
    if (m === null || typeof m !== 'object' || m.id === undefined) return; // notifications need no answer
    const ok = (result) => send({ jsonrpc: '2.0', id: m.id, result });
    try {
      if (m.method === 'initialize') {
        ok({
          protocolVersion: m.params?.protocolVersion || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'mcp-image-gen', version: '1.0.0' },
          instructions: INSTRUCTIONS,
        });
      } else if (m.method === 'tools/list') {
        ok({ tools: [TOOL] });
      } else if (m.method === 'tools/call') {
        if (m.params?.name !== TOOL.name) {
          send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `unknown tool: ${String(m.params?.name).slice(0, 80)}` } });
          return;
        }
        try {
          ok({ content: [{ type: 'text', text: await generate(m.params.arguments ?? {}) }] });
        } catch (e) {
          ok({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
        }
      } else if (m.method === 'ping') {
        ok({});
      } else {
        send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `unknown method: ${String(m.method).slice(0, 80)}` } });
      }
    } catch (e) {
      send({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: e.message } });
    }
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const handle = createServer({
    generate: createGenerator(loadConfig()),
    write: (text) => process.stdout.write(text),
  });
  readline.createInterface({ input: process.stdin }).on('line', (line) => void handle(line));
}
