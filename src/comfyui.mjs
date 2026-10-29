// Local backend: Qwen-Image 2.1 on a ComfyUI server, over its HTTP API.
//   references -> POST /upload/image (multipart), one unique name each
//   each variant -> POST /prompt { prompt: <API-format workflow> }, then GET /history/<id>
//                   until completed, then GET /view for every output image
// The workflow needs a ComfyUI build with the Qwen-Image 2.1 nodes (TextEncodeQwenImage21,
// QwenImage21Cache) and the three model files named in the config.
import { randomBytes, randomInt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SIZES = { portrait: [768, 1376], square: [1024, 1024], landscape: [1376, 768] };
export const MAX_REFERENCES = 10;
const NEGATIVE = 'text, letters, watermark, logo, blurry, deformed, low quality';
const STEPS = 25;

// The API-format graph: text-to-image without references, reference-guided otherwise.
// The encoder template has three image inputs: one or two references are padded by
// repeating the last one; references 4..N get their own LoadImage node and input.
// EmptyLatentImage fixes the canvas size; without it the canvas follows the first reference.
export function buildWorkflow({ prompt, width, height, seed, prefix, images = [], models }) {
  const workflow = {
    unet: { class_type: 'UNETLoader', inputs: { unet_name: models.unet, weight_dtype: 'default' } },
    cache: { class_type: 'QwenImage21Cache', inputs: { model: ['unet', 0], device: 'auto', dtype: 'default' } },
    clip: { class_type: 'CLIPLoader', inputs: { clip_name: models.clip, type: 'qwen_image', device: 'default' } },
    vae: { class_type: 'VAELoader', inputs: { vae_name: models.vae } },
    enc: {
      class_type: 'TextEncodeQwenImage21',
      inputs: { clip: ['clip', 0], prompt, negative_prompt: images.length ? NEGATIVE : '', resolution: 1024 },
    },
    latent: { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
    sampler: {
      class_type: 'KSampler',
      inputs: {
        model: ['cache', 0], seed, steps: STEPS, cfg: 1.0, sampler_name: 'euler', scheduler: 'simple',
        positive: ['enc', 0], negative: ['enc', 1], latent_image: ['latent', 0], denoise: 1.0,
      },
    },
    decode: { class_type: 'VAEDecode', inputs: { samples: ['sampler', 0], vae: ['vae', 0] } },
    save: { class_type: 'SaveImage', inputs: { images: ['decode', 0], filename_prefix: prefix } },
  };
  if (images.length) {
    const padded = [...images];
    while (padded.length < 3) padded.push(padded[padded.length - 1]);
    workflow.enc.inputs.vae = ['vae', 0];
    padded.forEach((name, i) => {
      workflow[`img${i + 1}`] = { class_type: 'LoadImage', inputs: { image: name } };
      workflow.enc.inputs[`images.image_${i + 1}`] = [`img${i + 1}`, 0];
    });
  }
  return workflow;
}

async function call(url, options = {}, what) {
  let res;
  try {
    res = await fetch(url, { ...options, signal: AbortSignal.timeout(options.timeoutMs ?? 120_000) });
  } catch (e) {
    throw new Error(`ComfyUI ${what}: ${e.cause?.message || e.message}`);
  }
  if (!res.ok) {
    const text = (await res.text()).replace(/\s+/g, ' ').slice(0, 300);
    throw new Error(`ComfyUI ${what}: HTTP ${res.status} ${text}`);
  }
  return res;
}

async function upload(base, file) {
  const name = `${randomBytes(6).toString('hex')}_${path.basename(file)}`;
  const form = new FormData();
  form.append('image', new Blob([fs.readFileSync(file)]), name);
  form.append('overwrite', 'true');
  const res = await call(`${base}/upload/image`, { method: 'POST', body: form }, 'upload');
  const json = await res.json();
  if (!json.name) throw new Error(`ComfyUI upload: unexpected answer for ${path.basename(file)}`);
  return json.subfolder ? `${json.subfolder}/${json.name}` : json.name;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runJob(config, workflow) {
  const { url, timeoutMs, pollMs } = config.comfyui;
  const res = await call(`${url}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: 'mcp-image-gen' }),
  }, 'queue');
  const { prompt_id: id } = await res.json();
  if (!id) throw new Error('ComfyUI queue: no prompt_id in the answer');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const history = await (await call(`${url}/history/${encodeURIComponent(id)}`, {}, 'history')).json();
    const entry = history[id];
    if (entry?.status?.status_str === 'error') {
      throw new Error(`ComfyUI job failed: ${JSON.stringify(entry.status.messages ?? []).slice(0, 300)}`);
    }
    if (entry?.status?.completed) {
      return Object.values(entry.outputs ?? {}).flatMap((node) => node.images ?? []);
    }
    await sleep(pollMs);
  }
  throw new Error(`ComfyUI job ${id} did not finish within ${Math.round(timeoutMs / 1000)} s`);
}

async function download(base, image) {
  const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder ?? '', type: image.type ?? 'output' });
  const res = await call(`${base}/view?${query}`, {}, 'download');
  return Buffer.from(await res.arrayBuffer());
}

export async function generateComfyUI(config, { prompt, references, format, variants }) {
  const { url, unet, clip, vae } = config.comfyui;
  if (references.length > MAX_REFERENCES) throw new Error(`at most ${MAX_REFERENCES} references`);
  const [width, height] = SIZES[format];
  const images = [];
  for (const file of references) images.push(await upload(url, file));
  const seed = randomInt(0, 2 ** 31);
  const out = [];
  for (let i = 0; i < variants; i += 1) {
    const prefix = `mcp_${randomBytes(4).toString('hex')}_v${i}`;
    const workflow = buildWorkflow({ prompt, width, height, seed: seed + i, prefix, images, models: { unet, clip, vae } });
    const outputs = await runJob(config, workflow);
    if (!outputs.length) throw new Error('ComfyUI job finished without images');
    out.push(await download(url, outputs[0]));
  }
  return { images: out };
}
