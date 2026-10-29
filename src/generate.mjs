// The generate_image tool: input validation, backend choice with automatic fallback
// (OpenAI first; rate-limited or unavailable -> local ComfyUI), and saving the PNGs.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { MAX_REFERENCES, generateComfyUI } from './comfyui.mjs';
import { classify, generateOpenAI } from './openai.mjs';

export const FORMATS = ['portrait', 'square', 'landscape'];
export const QUALITIES = ['low', 'medium', 'high'];
export const BACKENDS = ['auto', 'openai', 'comfyui'];
const MAX_PROMPT = 4000;
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);

export class InputError extends Error {}

export function validate(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new InputError('arguments must be an object');
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
  if (!prompt) throw new InputError('prompt is required');
  if (prompt.length > MAX_PROMPT) throw new InputError(`prompt is longer than ${MAX_PROMPT} characters`);
  if (args.references !== undefined && !Array.isArray(args.references)) throw new InputError('references must be an array of paths');
  const references = (args.references ?? []).map((r) => {
    if (typeof r !== 'string' || !r.trim()) throw new InputError('each reference must be a non-empty path');
    return path.resolve(r);
  });
  if (references.length > MAX_REFERENCES) throw new InputError(`at most ${MAX_REFERENCES} references`);
  for (const file of references) {
    if (!IMAGE_EXT.has(path.extname(file).toLowerCase())) throw new InputError(`not a PNG/JPEG/WebP image: ${file}`);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      throw new InputError(`reference not found: ${file}`);
    }
    if (!stat.isFile()) throw new InputError(`reference is not a file: ${file}`);
    if (stat.size > MAX_REFERENCE_BYTES) throw new InputError(`reference larger than 20 MB: ${file}`);
  }
  const pick = (value, allowed, fallback, name) => {
    if (value === undefined) return fallback;
    if (!allowed.includes(value)) throw new InputError(`${name} must be one of: ${allowed.join(', ')}`);
    return value;
  };
  const format = pick(args.format, FORMATS, 'portrait', 'format');
  const quality = pick(args.quality, QUALITIES, undefined, 'quality');
  const backend = pick(args.backend, BACKENDS, 'auto', 'backend');
  const variants = args.variants === undefined ? 1 : Number(args.variants);
  if (!Number.isInteger(variants) || variants < 1 || variants > 4) throw new InputError('variants must be an integer from 1 to 4');
  if (args.output !== undefined && (typeof args.output !== 'string' || !args.output.trim() || args.output.includes('\0'))) {
    throw new InputError('output must be a folder or a .png file path');
  }
  return { prompt, references, format, quality, backend, variants, output: args.output };
}

// Width x height from the PNG header (IHDR): what was actually saved.
export const pngSize = (b) => (b.length > 24 && b.toString('latin1', 12, 16) === 'IHDR' ? `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}` : '?');

function destinations(outputDir, output, backend, n) {
  let dir;
  let base;
  if (output && /\.png$/i.test(output)) {
    dir = path.dirname(path.resolve(output));
    base = path.basename(output, path.extname(output));
  } else {
    dir = output ? path.resolve(output) : path.join(outputDir, new Date().toLocaleDateString('sv-SE'));
    base = `img_${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}_${backend}`;
  }
  fs.mkdirSync(dir, { recursive: true });
  return Array.from({ length: n }, (_, i) => path.join(dir, n === 1 ? `${base}.png` : `${base}_v${i + 1}.png`));
}

function save(config, output, backend, images) {
  const files = destinations(config.outputDir, output, backend, images.length);
  images.forEach((buffer, i) => fs.writeFileSync(files[i], buffer));
  // The path and, under it, a file:/// link (Ctrl+click in most terminals opens the image).
  return files.map((f) => `${f}\n${pathToFileURL(f).href}`).join('\n');
}

const count = (n) => `${n} ${n === 1 ? 'image' : 'images'}`;
const seconds = (t0, now) => Math.round((now() - t0) / 1000);

// One generator per server process: it remembers the cloud pause after a rate limit.
export function createGenerator(config, { now = Date.now, openai = generateOpenAI, comfyui = generateComfyUI } = {}) {
  let cloudPausedUntil = 0;

  return async function generate(args) {
    const input = validate(args);
    const t0 = now();
    let note = '';

    if (input.backend !== 'comfyui') {
      if (input.backend === 'auto' && !config.openai.apiKey) {
        note = 'OpenAI not configured (no OPENAI_API_KEY)';
      } else if (input.backend === 'auto' && now() < cloudPausedUntil) {
        note = `OpenAI skipped until ${new Date(cloudPausedUntil).toTimeString().slice(0, 5)} after a rate limit`;
      } else {
        try {
          const r = await openai(config, input);
          const links = save(config, input.output, 'openai', r.images);
          return `OpenAI (${r.model}, ${pngSize(r.images[0])}, ${r.quality}) · ${count(r.images.length)} · ${seconds(t0, now)} s\n${links}`;
        } catch (e) {
          const kind = classify(e);
          if (kind === 'rate-limited') cloudPausedUntil = now() + config.cloudPauseMs;
          if (input.backend === 'openai' || kind === 'refused') {
            const hint = kind === 'refused' && input.backend === 'auto' ? ' (not retried locally; use backend "comfyui" to try there)' : '';
            throw new Error(`OpenAI: ${e.message}${hint}`);
          }
          note = `OpenAI ${kind} (${e.message})`;
        }
      }
    }

    const r = await comfyui(config, input);
    const links = save(config, input.output, 'comfyui', r.images);
    return `Qwen-Image 2.1 on ComfyUI (${pngSize(r.images[0])}) · ${count(r.images.length)} · ${seconds(t0, now)} s${note ? `\n${note}` : ''}\n${links}`;
  };
}
