import fs from 'node:fs/promises';

export const DEFAULT_SYSTEM_PROMPT = `You are the read-only visual perception module of a Windows assistant.
Analyze only what is visible in the provided screenshot. Never claim that you clicked, typed, sent, opened, or changed anything.
Return JSON only, without markdown fences. Use this exact top-level shape:
{
  "summary": "short Russian summary",
  "application": "application name or unknown",
  "visibleText": ["important visible text"],
  "interactiveElements": [{"label":"text or description","role":"button|input|item|other","center":{"x":0.0,"y":0.0},"confidence":0.0}],
  "unansweredItems": [{"name":"visible name","preview":"visible preview","reason":"why it appears unanswered","confidence":0.0}],
  "suggestedActions": [{"description":"proposed next step","requiresConfirmation":true}],
  "limitations": ["anything not verifiable from this one frame"]
}
Coordinates are normalized to the image from 0 to 1. Do not invent obscured text or off-screen state.`;

export function normalizeVisionPrompt(value) {
  if (value == null || value === '') {
    return 'Опиши видимое окно, выдели важный текст и элементы управления. Ничего не выполняй.';
  }
  if (typeof value !== 'string') throw new TypeError('prompt must be a string.');
  const prompt = value.trim();
  if (!prompt) throw new TypeError('prompt must not be empty.');
  if (prompt.length > 4_000) throw new TypeError('prompt is too long.');
  return prompt;
}

export function parseModelJson(content) {
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('LM Studio returned no text content.');
  }

  const trimmed = content.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');

  try {
    return JSON.parse(withoutFence);
  } catch {
    const start = withoutFence.indexOf('{');
    const end = withoutFence.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(withoutFence.slice(start, end + 1));
    throw new Error('LM Studio response was not valid JSON.');
  }
}

export function buildVisionRequest({ model, prompt, imageDataUrl, systemPrompt = DEFAULT_SYSTEM_PROMPT, maxOutputTokens = 1800 }) {
  if (typeof model !== 'string' || !model.trim()) throw new TypeError('LM Studio model is required.');
  if (!imageDataUrl?.startsWith('data:image/png;base64,')) throw new TypeError('A PNG data URL is required.');
  return {
    model: model.trim(),
    system_prompt: systemPrompt,
    input: [
      { type: 'text', content: normalizeVisionPrompt(prompt) },
      { type: 'image', data_url: imageDataUrl }
    ],
    temperature: 0,
    max_output_tokens: maxOutputTokens,
    context_length: 8192,
    store: false,
    stream: false
  };
}

export function buildTextRequest({ model, prompt, systemPrompt, maxOutputTokens = 800 }) {
  if (typeof model !== 'string' || !model.trim()) throw new TypeError('LM Studio model is required.');
  if (typeof systemPrompt !== 'string' || !systemPrompt.trim()) throw new TypeError('systemPrompt is required.');
  return {
    model: model.trim(),
    system_prompt: systemPrompt.trim(),
    input: [{ type: 'text', content: normalizeVisionPrompt(prompt) }],
    temperature: 0,
    max_output_tokens: maxOutputTokens,
    context_length: 8192,
    store: false,
    stream: false
  };
}

function outputText(response) {
  const message = response?.output?.find((item) => item?.type === 'message' && typeof item.content === 'string');
  return message?.content ?? null;
}

export async function getLmStudioStatus({ baseUrl, timeoutMs = 5_000 }) {
  try {
    const response = await fetch(`${baseUrl}/api/v1/models`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.json();
    return {
      reachable: response.ok,
      status: response.status,
      models: Array.isArray(body?.models) ? body.models : Array.isArray(body) ? body : [],
      error: response.ok ? null : body?.error || `HTTP ${response.status}`
    };
  } catch (error) {
    return { reachable: false, models: [], error: error.message };
  }
}

export async function analyzeImageWithLmStudio({
  baseUrl,
  model,
  imagePath,
  prompt,
  systemPrompt,
  maxOutputTokens,
  maxImageBytes = 20 * 1024 * 1024,
  timeoutMs = 180_000
}) {
  const file = await fs.stat(imagePath);
  if (!file.isFile()) throw new Error('Captured image is not a file.');
  if (file.size <= 0 || file.size > maxImageBytes) throw new Error('Captured image size is outside the safe limit.');

  const image = await fs.readFile(imagePath);
  const requestBody = buildVisionRequest({
    model,
    prompt,
    imageDataUrl: `data:image/png;base64,${image.toString('base64')}`,
    systemPrompt,
    maxOutputTokens
  });

  const response = await fetch(`${baseUrl}/api/v1/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error?.message || body?.error || `LM Studio HTTP ${response.status}`);

  const raw = outputText(body);
  return {
    model: body.model_instance_id || model,
    analysis: parseModelJson(raw),
    raw,
    stats: body.stats || null
  };
}

export async function analyzeTextWithLmStudio({
  baseUrl,
  model,
  prompt,
  systemPrompt,
  maxOutputTokens = 800,
  timeoutMs = 180_000
}) {
  const requestBody = buildTextRequest({ model, prompt, systemPrompt, maxOutputTokens });
  const response = await fetch(`${baseUrl}/api/v1/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error?.message || body?.error || `LM Studio HTTP ${response.status}`);
  const raw = outputText(body);
  return {
    model: body.model_instance_id || model,
    analysis: parseModelJson(raw),
    raw,
    stats: body.stats || null
  };
}
