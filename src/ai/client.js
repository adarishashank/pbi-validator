import { config } from '../config.js';
import { createLogger } from '../logger.js';

const logger = createLogger('ai');

export class AiError extends Error {
  constructor(message, status, retryable = false) { super(message); this.status = status; this.retryable = retryable; }
}

export function aiStatus() {
  return {
    configured: !!config.ai.apiKey || config.ai.allowNoKey,
    provider: /nvidia\.com/i.test(config.ai.baseUrl) ? 'NVIDIA API catalog (hosted)' : 'Self-hosted / custom endpoint',
    baseUrl: config.ai.baseUrl,
    textModel: config.ai.textModel,
    visionModel: config.ai.visionModel,
    imagesAllowed: config.ai.allowImages,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Removes reasoning traces some open models emit before the answer. */
export function stripReasoning(text) {
  return String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*<\/think>/i, '').trim();
}

/** Extracts the first JSON object/array from a model response. */
export function parseJsonLoose(text) {
  const t = stripReasoning(text).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const start = t.search(/[[{]/);
  if (start < 0) throw new AiError('Model did not return JSON');
  const open = t[start], close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return JSON.parse(t.slice(start, i + 1));
  }
  throw new AiError('Model returned malformed JSON');
}

/**
 * OpenAI-compatible chat completion (NVIDIA API catalog, self-hosted NIM,
 * vLLM, Ollama…). Retries on rate limits and transient errors.
 */
export async function chat({ model, messages, maxTokens = 2048, temperature = 0.2, json = false, thinking = null, timeoutMs = config.ai.timeoutMs }) {
  if (!aiStatus().configured) throw new AiError('AI is not configured: set NVIDIA_API_KEY (get one free at build.nvidia.com) or AI_BASE_URL for a self-hosted NIM.', 503);
  const body = { model, messages, max_tokens: maxTokens, temperature, top_p: 0.9, stream: false };
  if (json) body.response_format = { type: 'json_object' };
  // Reasoning ("thinking") models spend output tokens on hidden reasoning before
  // the answer, which can cut a long JSON answer off. Structured calls turn it off.
  if (thinking === false) body.chat_template_kwargs = { enable_thinking: false };
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const t0 = Date.now();
    try {
      const res = await fetch(`${config.ai.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(config.ai.apiKey ? { Authorization: `Bearer ${config.ai.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        // Some endpoints reject response_format; retry once without it.
        if (res.status === 400 && body.response_format && /response_format|json/i.test(text)) { delete body.response_format; continue; }
        if (res.status === 400 && body.chat_template_kwargs && /chat_template|kwargs|thinking/i.test(text)) { delete body.chat_template_kwargs; continue; }
        const hint = res.status === 401 || res.status === 403 ? ' — check NVIDIA_API_KEY' : res.status === 404 ? ` — model "${model}" not available on this endpoint (set AI_TEXT_MODEL / AI_VISION_MODEL)` : '';
        const retryable = res.status === 429 || res.status >= 500;
        const err = new AiError(`AI endpoint ${res.status}${hint}: ${text.slice(0, 300)}`, retryable ? 503 : 502, retryable);
        if (retryable) { lastErr = err; if (attempt < 3) await sleep(1500 * 2 ** attempt); continue; }
        throw err;
      }
      const data = JSON.parse(text);
      const content = data.choices?.[0]?.message?.content ?? '';
      const finish = data.choices?.[0]?.finish_reason;
      if (finish === 'length') logger.warn(`${model} reply was cut off at max_tokens=${maxTokens} (${data.usage?.completion_tokens ?? '?'} tokens)`);
      logger.debug(`${model} ${Date.now() - t0}ms tokens=${data.usage?.total_tokens ?? '?'}`);
      return { content: stripReasoning(content), usage: data.usage || null, model: data.model || model, ms: Date.now() - t0, finish };
    } catch (e) {
      if (e instanceof AiError && !e.retryable) throw e;
      lastErr = e.name === 'AbortError' ? new AiError(`AI request timed out after ${Math.round(timeoutMs / 1000)}s`, 504) : e;
      if (attempt < 3) await sleep(1500 * 2 ** attempt); // no point sleeping after the last attempt
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new AiError('AI request failed');
}

export async function chatJson(opts) {
  opts = { thinking: config.ai.thinking, ...opts };
  const r = await chat({ ...opts, json: true });
  try {
    return { ...r, json: parseJsonLoose(r.content) };
  } catch {
    // One repair attempt: ask the model to re-emit valid JSON only.
    const fix = await chat({
      model: opts.model,
      maxTokens: opts.maxTokens,
      messages: [...opts.messages, { role: 'assistant', content: r.content }, { role: 'user', content: 'Your previous reply was not valid JSON. Reply again with ONLY the JSON object, no prose, no code fences.' }],
      json: true,
      thinking: opts.thinking,
    });
    return { ...fix, json: parseJsonLoose(fix.content) };
  }
}

export const imagePart = (pngBuffer) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${pngBuffer.toString('base64')}` } });
