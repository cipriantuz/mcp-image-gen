// Cloud backend: the official OpenAI Images API.
//   no references -> POST {baseUrl}/images/generations (JSON)
//   references    -> POST {baseUrl}/images/edits (multipart, one `image[]` part per reference)
// Both answer { data: [{ b64_json }] } for the GPT image models.
import fs from 'node:fs';
import path from 'node:path';

export const SIZES = { portrait: '1024x1536', square: '1024x1024', landscape: '1536x1024' };

export class BackendError extends Error {
  constructor(status, message, body = '') {
    super(message);
    this.status = status;
    this.body = String(body);
  }
}

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.png': 'image/png' };

// Upstream text goes into error messages: one line, bounded, never containing the key.
export function cleanMessage(text, apiKey) {
  let out = String(text).replace(/\s+/g, ' ').trim().slice(0, 240);
  if (apiKey) out = out.split(apiKey).join('[redacted]');
  return out;
}

// rate-limited = no quota left right now; unavailable = network, auth or server trouble;
// refused = the request itself (content policy, parameters): not retried elsewhere automatically.
export function classify(error) {
  const status = error.status ?? 0;
  const text = `${error.body || ''} ${error.message || ''}`;
  if (status === 429 || /rate_limit|insufficient_quota|quota/i.test(text)) return 'rate-limited';
  if (status === 0 || status === 401 || status === 403 || status === 404 || status >= 500) return 'unavailable';
  return 'refused';
}

export async function generateOpenAI(config, { prompt, references, format, quality, variants }) {
  const { apiKey, baseUrl, model, timeoutMs } = config.openai;
  if (!apiKey) throw new BackendError(0, 'OPENAI_API_KEY is not set');
  const fields = { model, prompt, n: variants, size: SIZES[format], ...(quality && { quality }) };
  const headers = { authorization: `Bearer ${apiKey}` };
  let body;
  if (references.length) {
    body = new FormData();
    for (const [key, value] of Object.entries(fields)) body.append(key, String(value));
    for (const file of references) {
      const type = MIME[path.extname(file).toLowerCase()] || 'image/png';
      body.append('image[]', new Blob([fs.readFileSync(file)], { type }), path.basename(file));
    }
  } else {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(fields);
  }
  const url = `${baseUrl}/images/${references.length ? 'edits' : 'generations'}`;
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new BackendError(0, cleanMessage(e.cause?.message || e.message, apiKey));
  }
  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try {
      message = JSON.parse(text).error?.message || text;
    } catch {}
    throw new BackendError(res.status, `HTTP ${res.status}: ${cleanMessage(message, apiKey)}`, cleanMessage(text, apiKey));
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new BackendError(502, 'the response is not JSON');
  }
  const images = (json.data || []).filter((d) => d.b64_json).map((d) => Buffer.from(d.b64_json, 'base64'));
  if (!images.length) throw new BackendError(502, 'the response has no images');
  return { images, model, quality: json.quality || quality || 'default' };
}
