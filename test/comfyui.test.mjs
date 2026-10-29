import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { buildWorkflow, generateComfyUI } from '../src/comfyui.mjs';
import { fakeComfy, fakePng, tempDir, testConfig } from './helpers.mjs';

const models = { unet: 'u.safetensors', clip: 'c.safetensors', vae: 'v.safetensors' };

function refs(n) {
  const dir = tempDir();
  return Array.from({ length: n }, (_, i) => {
    const file = path.join(dir, `ref${i + 1}.png`);
    fs.writeFileSync(file, fakePng(32, 32));
    return file;
  });
}

test('text-to-image workflow: no image nodes, empty negative, canvas size from the format', () => {
  const w = buildWorkflow({ prompt: 'p', width: 768, height: 1376, seed: 7, prefix: 'x', models });
  assert.deepEqual(Object.keys(w).filter((k) => k.startsWith('img')), []);
  assert.equal(w.enc.inputs.negative_prompt, '');
  assert.equal(w.enc.inputs.vae, undefined);
  assert.deepEqual(w.latent.inputs, { width: 768, height: 1376, batch_size: 1 });
  assert.equal(w.sampler.inputs.seed, 7);
  assert.equal(w.unet.inputs.unet_name, 'u.safetensors');
  assert.equal(w.save.inputs.filename_prefix, 'x');
});

test('reference workflow: one reference is padded to three; four references add a fourth input', () => {
  const one = buildWorkflow({ prompt: 'p', width: 1, height: 1, seed: 1, prefix: 'x', images: ['a.png'], models });
  assert.deepEqual([1, 2, 3].map((i) => one[`img${i}`].inputs.image), ['a.png', 'a.png', 'a.png']);
  assert.deepEqual(one.enc.inputs.vae, ['vae', 0]);
  assert.match(one.enc.inputs.negative_prompt, /watermark/);
  const four = buildWorkflow({ prompt: 'p', width: 1, height: 1, seed: 1, prefix: 'x', images: ['a', 'b', 'c', 'd'], models });
  assert.deepEqual(four.enc.inputs['images.image_4'], ['img4', 0]);
  assert.equal(four.img4.inputs.image, 'd');
});

test('generation: uploads the references, queues one job per variant with consecutive seeds, downloads the outputs', async () => {
  const comfy = await fakeComfy();
  try {
    const r = await generateComfyUI(testConfig({ comfyUrl: comfy.url }), { prompt: 'a fox', references: refs(2), format: 'landscape', variants: 2 });
    assert.equal(r.images.length, 2);
    assert.deepEqual(r.images[0], fakePng(768, 1376));
    const uploads = comfy.requests.filter((q) => q.url === '/upload/image');
    assert.equal(uploads.length, 2);
    assert.equal(comfy.workflows.length, 2);
    const [w1, w2] = comfy.workflows;
    assert.match(w1.img1.inputs.image, /^[0-9a-f]{12}_ref1\.png$/);
    assert.match(w1.img2.inputs.image, /^[0-9a-f]{12}_ref2\.png$/);
    assert.equal(w1.img3.inputs.image, w1.img2.inputs.image);
    assert.deepEqual([w1.latent.inputs.width, w1.latent.inputs.height], [1376, 768]);
    assert.equal(w2.sampler.inputs.seed, w1.sampler.inputs.seed + 1);
    assert.ok(comfy.requests.some((q) => q.url.startsWith('/view?filename=p1.png')));
  } finally {
    await comfy.close();
  }
});

test('a failed job is an error with the ComfyUI messages', async () => {
  const comfy = await fakeComfy({ failJob: true });
  try {
    await assert.rejects(
      generateComfyUI(testConfig({ comfyUrl: comfy.url }), { prompt: 'x', references: [], format: 'square', variants: 1 }),
      /ComfyUI job failed: .*execution_error/,
    );
  } finally {
    await comfy.close();
  }
});

test('ComfyUI down is an error naming the step', async () => {
  await assert.rejects(
    generateComfyUI(testConfig({ comfyUrl: 'http://127.0.0.1:9' }), { prompt: 'x', references: [], format: 'square', variants: 1 }),
    /^Error: ComfyUI queue:/,
  );
});
