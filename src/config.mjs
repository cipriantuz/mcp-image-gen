// Configuration from environment variables. Nothing here is logged: the API key only
// travels in the Authorization header of requests to the configured OpenAI endpoint.
import os from 'node:os';
import path from 'node:path';

const int = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
};

export function loadConfig(env = process.env) {
  return {
    openai: {
      // Optional: without a key the cloud backend is off and `auto` goes straight to ComfyUI.
      apiKey: env.OPENAI_API_KEY || '',
      baseUrl: (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
      model: env.OPENAI_IMAGE_MODEL || 'gpt-image-1',
      timeoutMs: int(env.OPENAI_TIMEOUT_MS, 300_000),
    },
    comfyui: {
      url: (env.COMFYUI_URL || 'http://127.0.0.1:8188').replace(/\/+$/, ''),
      timeoutMs: int(env.COMFYUI_TIMEOUT_MS, 20 * 60_000),
      pollMs: int(env.COMFYUI_POLL_MS, 2_000),
      // Model files as named in the ComfyUI models folders.
      unet: env.QWEN_UNET || 'qwen_image_2.1_int8_convrot.safetensors',
      clip: env.QWEN_CLIP || 'qwen3vl_8b_int8_convrot.safetensors',
      vae: env.QWEN_VAE || 'qwen_image_2.1_vae_bf16.safetensors',
    },
    outputDir: env.IMAGE_OUTPUT_DIR || path.join(os.homedir(), 'Pictures', 'mcp-image-gen'),
    // After a rate-limit error, `auto` skips the cloud for this long.
    cloudPauseMs: int(env.CLOUD_PAUSE_MS, 15 * 60_000),
  };
}
