import fs from 'node:fs/promises';
import { config } from './config.mjs';
import { adaptGuiModelAnalysis } from './gui-model-adapter.mjs';
import { AGENT_DECISION_SCHEMA, UNIFIED_AGENT_SYSTEM_PROMPT } from './agent-model-protocol.mjs';

const activeRequestControllers = new Set();
let lmStudioRequestBroker = null;
const agentContextTokenLimit = Number.isSafeInteger(Number(process.env.AI_WORKSTATION_AGENT_CONTEXT_TOKENS))
 ? Number(process.env.AI_WORKSTATION_AGENT_CONTEXT_TOKENS)
 : config.unifiedAgentContextTokens;
// The ContextCompiler already fits the context to 65% of the model window. This
// outer guard must stay looser than that, otherwise every compiled context is
// reduced a second time and the compiler's structural work is thrown away.
const maxAgentPromptTokens = Math.max(4_096, Math.floor(agentContextTokenLimit * 0.70));
const maxAgentPromptCharacters = Math.min(100_000, maxAgentPromptTokens * 4);
const stringShorteningLimits = [2_000, 500, 120, 40];
const truncationRetryFloor = 1_600;
const truncationRetryCeiling = Math.max(
  truncationRetryFloor,
  Math.min(Number(process.env.AI_WORKSTATION_LM_MAX_OUTPUT_TOKENS) || 4_096, 8_192)
);

function shortenString(value, limit) {
  if (typeof value !== 'string' || value.length <= limit) return value;
  return `${value.slice(0, limit)}…[truncated ${value.length - limit} characters]`;
}

function shortenLongStrings(value, limit) {
  if (typeof value === 'string') return shortenString(value, limit);
  if (Array.isArray(value)) return value.map((entry) => shortenLongStrings(entry, limit));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, shortenLongStrings(entry, limit)]));
  }
  return value;
}

// Slicing the serialized prompt cut JSON in the middle of a structure and, on a
// format-repair round, cut the repair instruction off entirely. Reduce the
// context structurally instead, so the model always receives parsable JSON and
// always sees why its previous answer was rejected.
function fitAgentPromptToWindow(context, envelope = {}, characterBudget = maxAgentPromptCharacters) {
  const serialize = (value) => JSON.stringify({ context: value, ...envelope });
  const original = serialize(context);
  if (original.length <= characterBudget) return original;
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    return serialize(shortenLongStrings(context, Math.max(40, characterBudget - 200)));
  }

  const reduction = { reason: 'the context exceeded the agent prompt window and was reduced before the request.' };
  // `base` keeps the untouched strings so every shortening pass starts from the
  // original text instead of nesting one truncation marker inside another.
  const base = { ...context };
  let shorteningLimit = null;
  const render = () => ({
    ...(shorteningLimit === null ? base : shortenLongStrings(base, shorteningLimit)),
    contextReduction: reduction
  });
  const fits = () => serialize(render()).length <= characterBudget;

  // One pathological string must not cost the whole memory and event history,
  // so the widest shortening pass runs before anything is dropped.
  const [widestLimit, ...tighterLimits] = stringShorteningLimits;
  if (JSON.stringify(shortenLongStrings(base, widestLimit)).length < JSON.stringify(base).length) {
    shorteningLimit = widestLimit;
    reduction.shortenedStringsOver = widestLimit;
  }

  if (!fits() && Array.isArray(base.recentEvents) && base.recentEvents.length > 1) {
    const events = [...base.recentEvents];
    while (events.length > 1) {
      events.shift();
      base.recentEvents = events;
      if (fits()) break;
    }
    reduction.droppedOldestEvents = context.recentEvents.length - events.length;
  }
  if (!fits() && Array.isArray(base.relevantMemory) && base.relevantMemory.length > 1) {
    const memory = [...base.relevantMemory];
    while (memory.length > 1) {
      memory.pop();
      base.relevantMemory = memory;
      if (fits()) break;
    }
    reduction.droppedLeastRelevantMemories = context.relevantMemory.length - memory.length;
  }

  for (const limit of tighterLimits) {
    if (fits()) break;
    shorteningLimit = limit;
    reduction.shortenedStringsOver = limit;
  }
  if (fits()) return serialize(render());

  // Last resort: keep only the pinned block, still as valid JSON.
  reduction.droppedEverythingExceptPinned = true;
  const pinnedOnly = { pinned: shortenLongStrings(base.pinned ?? null, 400), contextReduction: reduction };
  const serialized = serialize(pinnedOnly);
  return serialized.length <= characterBudget ? serialized : serialize({ contextReduction: reduction });
}

function trackedRequestSignal(timeoutMs, externalSignal = null) {
  const controller = new AbortController();
  activeRequestControllers.add(controller);
  const signals = [controller.signal, AbortSignal.timeout(timeoutMs)];
  if (externalSignal) signals.push(externalSignal);
  return {
    signal: AbortSignal.any(signals),
    dispose() {
      activeRequestControllers.delete(controller);
    }
  };
}

async function requestLmStudioJson(url, options, timeoutMs, signal = null) {
  const tracked = trackedRequestSignal(timeoutMs, signal);
  try {
    const response = await fetch(url, { ...options, signal: tracked.signal });
    const body = await response.json();
    return { response, body };
  } finally {
    tracked.dispose();
  }
}

export function abortActiveLmStudioRequests(reason = 'AI execution was stopped by the user.') {
  const controllers = [...activeRequestControllers];
  for (const controller of controllers) controller.abort(new Error(reason));
  return controllers.length;
}

export function activeLmStudioRequestCount() {
  return activeRequestControllers.size;
}

export function configureLmStudioRequestBroker(broker = null) {
  if (broker != null && typeof broker.runModel !== 'function') throw new TypeError('LM Studio request broker must expose runModel().');
  lmStudioRequestBroker = broker;
}

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

export function normalizeVisionPrompt(value, maxLength = 4_000) {
  if (value == null || value === '') {
    return 'Опиши видимое окно, выдели важный текст и элементы управления. Ничего не выполняй.';
  }
  if (typeof value !== 'string') throw new TypeError('prompt must be a string.');
  const prompt = value.trim();
  if (!prompt) throw new TypeError('prompt must not be empty.');
  if (prompt.length > maxLength) throw new TypeError('prompt is too long.');
  return prompt;
}

export function normalizeTextPrompt(value, maxLength = 20_000) {
  if (typeof value !== 'string') throw new TypeError('prompt must be a string.');
  const prompt = value.trim();
  if (!prompt) throw new TypeError('prompt must not be empty.');
  if (prompt.length > maxLength) throw new TypeError('text prompt is too long.');
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

export function buildVisionRequest({ model, prompt, imageDataUrl, systemPrompt = DEFAULT_SYSTEM_PROMPT, maxOutputTokens = 1800, maxPromptLength = 4_000 }) {
  return buildMultiImageVisionRequest({
    model,
    prompt,
    imageDataUrls: [imageDataUrl],
    systemPrompt,
    maxOutputTokens,
    maxPromptLength
  });
}

export function buildMultiImageVisionRequest({
  model,
  prompt,
  imageDataUrls,
  systemPrompt = DEFAULT_SYSTEM_PROMPT,
  maxOutputTokens = 1800,
  maxPromptLength = 4_000
}) {
  if (typeof model !== 'string' || !model.trim()) throw new TypeError('LM Studio model is required.');
  if (!Array.isArray(imageDataUrls) || imageDataUrls.length === 0 || imageDataUrls.length > 4) {
    throw new TypeError('One to four PNG images are required.');
  }
  for (const imageDataUrl of imageDataUrls) {
    if (!imageDataUrl?.startsWith('data:image/png;base64,')) throw new TypeError('Every image must be a PNG data URL.');
  }
  return {
    model: model.trim(),
    system_prompt: systemPrompt,
    input: [
      { type: 'text', content: normalizeVisionPrompt(prompt, maxPromptLength) },
      ...imageDataUrls.map((dataUrl) => ({ type: 'image', data_url: dataUrl }))
    ],
    temperature: 0,
    max_output_tokens: maxOutputTokens,
    context_length: agentContextTokenLimit,
    store: false,
    stream: false
  };
}

async function readPngDataUrl(imagePath, maxImageBytes) {
  const file = await fs.stat(imagePath);
  if (!file.isFile()) throw new Error('Captured image is not a file.');
  if (file.size <= 0 || file.size > maxImageBytes) throw new Error('Captured image size is outside the safe limit.');
  const image = await fs.readFile(imagePath);
  return `data:image/png;base64,${image.toString('base64')}`;
}

export function buildTextRequest({ model, prompt, systemPrompt, maxOutputTokens = 800, maxPromptLength = 20_000 }) {
  if (typeof model !== 'string' || !model.trim()) throw new TypeError('LM Studio model is required.');
  if (typeof systemPrompt !== 'string' || !systemPrompt.trim()) throw new TypeError('systemPrompt is required.');
  return {
    model: model.trim(),
    system_prompt: systemPrompt.trim(),
    input: [{ type: 'text', content: normalizeTextPrompt(prompt, maxPromptLength) }],
    temperature: 0,
    max_output_tokens: maxOutputTokens,
    context_length: agentContextTokenLimit,
    store: false,
    stream: false
  };
}

const shortString = { type: 'string' };
const pointSchema = {
  type: 'object',
  properties: { x: { type: 'number' }, y: { type: 'number' } },
  required: ['x', 'y'],
  additionalProperties: false
};
const targetHintSchema = {
  type: 'object',
  properties: {
    automationId: shortString,
    name: shortString,
    controlType: shortString,
    visibleText: shortString
  },
  additionalProperties: false
};
function typedActionSchema(type, properties = {}, required = []) {
  return {
    type: 'object',
    properties: {
      type: { type: 'string', enum: [type] },
      ...properties
    },
    required: ['type', ...required],
    additionalProperties: false
  };
}

// A permissive action object let a model emit `{ type: "click" }` without a
// point. The JSON was valid but could never be executed, so autonomous mode
// kept retrying a protocol error. Require the physical fields for each type.
const actionSchema = {
  oneOf: [
    typedActionSchema('click', { point: pointSchema, targetHint: targetHintSchema }, ['point', 'targetHint']),
    typedActionSchema('doubleClick', { point: pointSchema, targetHint: targetHintSchema }, ['point', 'targetHint']),
    typedActionSchema('scroll', { point: pointSchema, delta: { type: 'number' } }, ['point', 'delta']),
    typedActionSchema('drag', {
      from: pointSchema,
      to: pointSchema,
      modifiers: { type: 'array', items: { type: 'string', enum: ['Control', 'Shift', 'Alt'] } },
      durationMs: { type: 'number' }
    }, ['from', 'to', 'durationMs']),
    typedActionSchema('typeText', {
      point: pointSchema,
      text: { type: 'string' },
      textMode: { type: 'string', enum: ['replace', 'insert'] },
      targetHint: targetHintSchema
    }, ['point', 'text', 'textMode', 'targetHint']),
    typedActionSchema('wait', { durationMs: { type: 'number' } }, ['durationMs']),
    typedActionSchema('done')
  ]
};
const riskSchema = {
  type: 'object',
  properties: {
    level: { type: 'string', enum: ['read_only', 'local_change', 'external_effect', 'dangerous'] },
    reason: shortString
  },
  required: ['level', 'reason'],
  additionalProperties: false
};
const plannerStepSchema = {
  type: 'object',
  properties: {
    action: actionSchema,
    reason: shortString,
    expectedResult: shortString,
    risk: riskSchema,
    confidence: { type: 'number' },
    precondition: shortString,
    checkpoint: { type: 'string', enum: ['deterministic', 'visual'] }
  },
  required: ['action', 'reason', 'expectedResult', 'risk', 'confidence', 'precondition', 'checkpoint'],
  additionalProperties: false
};
const plannerSchema = {
  type: 'object',
  properties: {
    observation: shortString,
    ...plannerStepSchema.properties,
    nextActions: { type: 'array', items: plannerStepSchema }
  },
  required: ['observation', ...plannerStepSchema.required],
  additionalProperties: false
};

function responseFormat(name, schema) {
  return { type: 'json_schema', json_schema: { name, strict: true, schema } };
}

function responseFormatForSystemPrompt(systemPrompt) {
  if (systemPrompt === UNIFIED_AGENT_SYSTEM_PROMPT) {
    return responseFormat('jarvis_agent_decision', AGENT_DECISION_SCHEMA);
  }
  if (systemPrompt.includes('local interface planner')) {
    return responseFormat('next_ui_action', plannerSchema);
  }
  if (systemPrompt.includes('autonomous supervisor') && systemPrompt.includes('proposed action')) {
    return responseFormat('jarvis_review', {
      type: 'object',
      properties: {
        decision: { type: 'string', enum: ['approve', 'revise', 'research', 'abort'] },
        reason: shortString,
        guidance: shortString,
        researchQuery: shortString,
        confidence: { type: 'number' }
      },
      required: ['decision', 'reason', 'guidance', 'researchQuery', 'confidence'],
      additionalProperties: false
    });
  }
  if (systemPrompt.includes('local visual validator') || systemPrompt.includes('focused visual validator')) {
    return responseFormat('action_validation', {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        evidence: shortString,
        confidence: { type: 'number' },
        nextStep: shortString,
        limitations: { type: 'array', items: shortString },
        learningUpdate: { type: ['object', 'null'], additionalProperties: true }
      },
      required: ['success', 'evidence', 'confidence', 'nextStep', 'limitations'],
      additionalProperties: false
    });
  }
  if (systemPrompt.includes('refine a click target') || systemPrompt.includes('locate a requested visible input field') ||
      systemPrompt.includes('verify a point on a universal Windows application editing surface')) {
    return responseFormat('visual_point', {
      oneOf: [
        {
          type: 'object',
          properties: {
            targetVisible: { type: 'boolean', enum: [true] },
            point: pointSchema,
            confidence: { type: 'number' },
            evidence: shortString
          },
          required: ['targetVisible', 'point', 'confidence', 'evidence'],
          additionalProperties: false
        },
        {
          type: 'object',
          properties: {
            targetVisible: { type: 'boolean', enum: [false] },
            confidence: { type: 'number' },
            evidence: shortString
          },
          required: ['targetVisible', 'confidence', 'evidence'],
          additionalProperties: false
        }
      ]
    });
  }
  if (systemPrompt.includes('recover a drawing gesture')) {
    return responseFormat('visual_gesture', {
      oneOf: [
        {
          type: 'object',
          properties: {
            targetVisible: { type: 'boolean', enum: [true] },
            from: pointSchema,
            to: pointSchema,
            confidence: { type: 'number' },
            evidence: shortString
          },
          required: ['targetVisible', 'from', 'to', 'confidence', 'evidence'],
          additionalProperties: false
        },
        {
          type: 'object',
          properties: {
            targetVisible: { type: 'boolean', enum: [false] },
            confidence: { type: 'number' },
            evidence: shortString
          },
          required: ['targetVisible', 'confidence', 'evidence'],
          additionalProperties: false
        }
      ]
    });
  }
  if (systemPrompt.includes('choose one coherent practice goal')) {
    return responseFormat('practice_goal', {
      type: 'object',
      properties: {
        actionable: { type: 'boolean' }, goal: shortString, learningObjective: shortString,
        hypothesis: shortString, reason: shortString, successCriteria: shortString,
        risk: { type: 'string', enum: ['read_only', 'local_change'] },
        confidence: { type: 'number' }
      },
      required: ['actionable', 'goal', 'learningObjective', 'hypothesis', 'reason', 'successCriteria', 'risk', 'confidence'],
      additionalProperties: false
    });
  }
  if (systemPrompt.includes('compare two screenshots')) {
    return responseFormat('reference_comparison', {
      type: 'object',
      properties: {
        success: { type: 'boolean' }, evidence: shortString,
        confidence: { type: 'number' },
        limitations: { type: 'array', items: shortString }
      },
      required: ['success', 'evidence', 'confidence', 'limitations'],
      additionalProperties: false
    });
  }
  if (systemPrompt.includes('compile a passive Windows UI observation into causal semantic experience')) {
    const semanticEpisode = {
      type: 'object',
      properties: {
        title: shortString,
        goal: shortString,
        causalSequence: { type: 'array', items: shortString },
        result: shortString,
        success: { type: 'string', enum: ['yes', 'partial', 'no', 'unclear'] },
        technique: shortString,
        retrievalTerms: { type: 'array', items: shortString }
      },
      required: ['title', 'goal', 'causalSequence', 'result', 'success', 'technique', 'retrievalTerms'],
      additionalProperties: false
    };
    const portableKnowledge = {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['technique', 'preference', 'lesson'] },
        name: shortString,
        description: shortString,
        trigger: shortString,
        expectedResult: shortString,
        scope: { type: 'string', enum: ['universal', 'selected_application'] }
      },
      required: ['type', 'name', 'description', 'trigger', 'expectedResult', 'scope'],
      additionalProperties: false
    };
    return responseFormat('observed_semantic_experience', {
      type: 'object',
      properties: {
        understood: { type: 'boolean' },
        confidence: { type: 'number' },
        sessionGoal: shortString,
        whyActions: shortString,
        comparison: {
          type: 'object',
          properties: {
            before: shortString,
            after: shortString,
            changed: { type: 'boolean' },
            matchedIntent: { type: 'string', enum: ['yes', 'partial', 'no', 'unclear'] },
            outcome: shortString,
            evidence: { type: 'array', items: shortString }
          },
          required: ['before', 'after', 'changed', 'matchedIntent', 'outcome', 'evidence'],
          additionalProperties: false
        },
        actionEvidence: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              stepRange: shortString,
              action: shortString,
              purpose: shortString,
              importance: { type: 'string', enum: ['causal', 'supporting', 'noise'] }
            },
            required: ['stepRange', 'action', 'purpose', 'importance'],
            additionalProperties: false
          }
        },
        noiseSummary: shortString,
        episodes: { type: 'array', items: semanticEpisode },
        portableKnowledge: { type: 'array', items: portableKnowledge }
      },
      required: ['understood', 'confidence', 'sessionGoal', 'whyActions', 'comparison', 'actionEvidence', 'noiseSummary', 'episodes', 'portableKnowledge'],
      additionalProperties: false
    });
  }
  if (systemPrompt === DEFAULT_SYSTEM_PROMPT) {
    return responseFormat('visible_window', {
      type: 'object',
      properties: {
        summary: shortString,
        application: shortString,
        visibleText: { type: 'array', items: shortString },
        interactiveElements: { type: 'array', items: {
          type: 'object',
          properties: { label: shortString, role: shortString, center: pointSchema, confidence: { type: 'number' } },
          required: ['label', 'role', 'center', 'confidence'],
          additionalProperties: false
        } },
        unansweredItems: { type: 'array', items: { type: 'object', additionalProperties: true } },
        suggestedActions: { type: 'array', items: { type: 'object', additionalProperties: true } },
        limitations: { type: 'array', items: shortString }
      },
      required: ['summary', 'application', 'visibleText', 'interactiveElements', 'unansweredItems', 'suggestedActions', 'limitations'],
      additionalProperties: false
    });
  }
  return responseFormat('compact_json_response', {
    type: 'object',
    additionalProperties: true
  });
}

export function toStructuredChatCompletionRequest(requestBody) {
  const userContent = requestBody.input.map((item) => {
    if (item.type === 'text') return { type: 'text', text: item.content };
    if (item.type === 'image') return { type: 'image_url', image_url: { url: item.data_url } };
    throw new TypeError(`Unsupported LM Studio input type: ${item.type}`);
  });
  return {
    model: requestBody.model,
    messages: [
      { role: 'system', content: requestBody.system_prompt },
      { role: 'user', content: userContent }
    ],
    temperature: requestBody.temperature,
    max_tokens: requestBody.max_output_tokens,
    stream: false,
    response_format: responseFormatForSystemPrompt(requestBody.system_prompt)
  };
}

function outputText(response) {
  const completionContent = response?.choices?.[0]?.message?.content;
  if (typeof completionContent === 'string') return completionContent;
  const message = response?.output?.find((item) => item?.type === 'message' && typeof item.content === 'string');
  return message?.content ?? null;
}

function assertCompletionFinished(response) {
  const finishReason = response?.choices?.[0]?.finish_reason ?? null;
  if (finishReason === 'length') {
    const error = new Error('LM Studio output was truncated before the structured response completed.');
    error.code = 'lm_output_truncated';
    error.finishReason = finishReason;
    throw error;
  }
  return finishReason;
}

function nextOutputTokenLimit(current) {
  return Math.min(truncationRetryCeiling, Math.max(truncationRetryFloor, Math.ceil(Number(current) * 2)));
}

async function requestStructuredCompletion({ baseUrl, requestBody, timeoutMs, signal = null, useBroker = true }) {
  const execute = async () => {
    let maxOutputTokens = Math.max(1, Number(requestBody.max_output_tokens) || 1);
    let truncationRetries = 0;
    while (true) {
      const attemptBody = { ...requestBody, max_output_tokens: maxOutputTokens };
      const { response, body } = await requestLmStudioJson(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(toStructuredChatCompletionRequest(attemptBody))
      }, timeoutMs, signal);
      if (!response.ok) throw new Error(body?.error?.message || body?.error || `LM Studio HTTP ${response.status}`);
      try {
        const finishReason = assertCompletionFinished(body);
        return { body, finishReason, maxOutputTokens, truncationRetries };
      } catch (error) {
        if (error.code !== 'lm_output_truncated' || maxOutputTokens >= truncationRetryCeiling) throw error;
        maxOutputTokens = nextOutputTokenLimit(maxOutputTokens);
        truncationRetries += 1;
      }
    }
  };
  return useBroker && lmStudioRequestBroker
    ? lmStudioRequestBroker.runModel(requestBody.model, execute)
    : execute();
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
  maxPromptLength = 4_000,
  maxImageBytes = 20 * 1024 * 1024,
  timeoutMs = 180_000,
  signal = null,
  useBroker = true
}) {
  const imageDataUrl = await readPngDataUrl(imagePath, maxImageBytes);
  const requestBody = buildVisionRequest({
    model,
    prompt,
    imageDataUrl,
    systemPrompt,
    maxOutputTokens,
    maxPromptLength
  });

  const { body, finishReason, maxOutputTokens: usedOutputTokenLimit, truncationRetries } =
    await requestStructuredCompletion({ baseUrl, requestBody, timeoutMs, signal, useBroker });
  const raw = outputText(body);
  return {
    model: body.model_instance_id || body.model || model,
    analysis: adaptGuiModelAnalysis(model, parseModelJson(raw)),
    raw,
    stats: {
      ...(body.stats || body.usage || {}),
      outputTokenLimit: usedOutputTokenLimit,
      truncationRetries
    },
    finishReason
  };
}

export async function analyzeImagesWithLmStudio({
  baseUrl,
  model,
  imagePaths,
  prompt,
  systemPrompt,
  maxOutputTokens,
  maxImageBytes = 20 * 1024 * 1024,
  timeoutMs = 180_000
}) {
  if (!Array.isArray(imagePaths) || imagePaths.length < 2 || imagePaths.length > 4) {
    throw new TypeError('Two to four image paths are required for comparison.');
  }
  const imageDataUrls = await Promise.all(imagePaths.map((imagePath) => readPngDataUrl(imagePath, maxImageBytes)));
  const requestBody = buildMultiImageVisionRequest({
    model,
    prompt,
    imageDataUrls,
    systemPrompt,
    maxOutputTokens
  });
  const { body, finishReason, maxOutputTokens: usedOutputTokenLimit, truncationRetries } =
    await requestStructuredCompletion({ baseUrl, requestBody, timeoutMs });
  const raw = outputText(body);
  return {
    model: body.model_instance_id || body.model || model,
    analysis: adaptGuiModelAnalysis(model, parseModelJson(raw)),
    raw,
    stats: {
      ...(body.stats || body.usage || {}),
      outputTokenLimit: usedOutputTokenLimit,
      truncationRetries
    },
    finishReason
  };
}

export async function analyzeTextWithLmStudio({
  baseUrl,
  model,
  prompt,
  systemPrompt,
  maxOutputTokens = 800,
  maxPromptLength = 20_000,
  timeoutMs = 180_000,
  signal = null,
  useBroker = true
}) {
  const requestBody = buildTextRequest({ model, prompt, systemPrompt, maxOutputTokens, maxPromptLength });
  const { body, finishReason, maxOutputTokens: usedOutputTokenLimit, truncationRetries } =
    await requestStructuredCompletion({ baseUrl, requestBody, timeoutMs, signal, useBroker });
  const raw = outputText(body);
  return {
    model: body.model_instance_id || body.model || model,
    analysis: adaptGuiModelAnalysis(model, parseModelJson(raw)),
    raw,
    stats: {
      ...(body.stats || body.usage || {}),
      outputTokenLimit: usedOutputTokenLimit,
      truncationRetries
    },
    finishReason
  };
}

export function createLmStudioAgentClient({ baseUrl, timeoutMs = 180_000, maxOutputTokens = 1_600 } = {}) {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) throw new TypeError('LM Studio baseUrl is required.');
  return async function lmStudioAgentClient(context, {
    model,
    signal = null,
    systemPrompt = UNIFIED_AGENT_SYSTEM_PROMPT,
    responseSchema = AGENT_DECISION_SCHEMA,
    repair = false,
    formatError = null
  } = {}) {
    if (responseSchema !== AGENT_DECISION_SCHEMA) throw new TypeError('Unsupported agent decision schema.');
    const prompt = fitAgentPromptToWindow(context, repair ? {
      formatRepair: {
        error: String(formatError || 'The prior response did not match the decision schema.'),
        instruction: 'Return one corrected decision using the same context.'
      }
    } : {});
    const screenshotPath = context?.pinned?.lastToolResult?.result?.screenshotPath ||
      context?.pinned?.lastObservation?.screenshotPath || null;
    const maxPromptLength = maxAgentPromptCharacters;
    const result = screenshotPath
      ? await analyzeImageWithLmStudio({
        baseUrl,
        model,
        imagePath: screenshotPath,
        prompt,
        systemPrompt,
        maxOutputTokens,
        maxPromptLength,
        timeoutMs,
        signal,
        useBroker: false
      })
      : await analyzeTextWithLmStudio({
        baseUrl,
        model,
        prompt,
        systemPrompt,
        maxOutputTokens,
        maxPromptLength,
        timeoutMs,
        signal,
        useBroker: false
      });
    return result.analysis;
  };
}
