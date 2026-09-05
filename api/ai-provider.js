const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models'
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const REPLICATE_BASE_URL = 'https://api.replicate.com/v1'
const DEFAULT_TIMEOUT_MS = 60_000
const MAX_TIMEOUT_MS = 180_000
const MAX_BODY_BYTES = 32 * 1024 * 1024
const SECRET_HEADER = 'x-nodedu-ai-egress-secret'

const GEMINI_MODELS = new Set([
  'gemini-2.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-3.1-flash-image',
  'gemini-3.5-flash',
])
const REPLICATE_MODELS = new Set([
  'black-forest-labs/flux-2-klein-9b',
  'prunaai/p-video-avatar',
])
const OPENROUTER_SPEAKING_MODELS = new Set([
  'google/gemini-3.1-flash-lite',
  'google/gemini-3.5-flash-lite',
])
const PREDICTION_ID_PATTERN = /^[A-Za-z0-9_-]{6,128}$/
const MODEL_PATTERN = /^[a-z0-9][a-z0-9._/-]{1,127}$/
const ALLOWED_KEYS = new Set(['operation', 'model', 'fallbackModel', 'predictionId', 'body', 'timeoutMs'])

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function authorize(request) {
  const expected = process.env.AI_EGRESS_SHARED_SECRET
  if (!expected) return json({ error: 'AI_EGRESS_SHARED_SECRET is not configured' }, 500)
  if (request.headers.get(SECRET_HEADER) !== expected) return json({ error: 'Unauthorized' }, 401)
  return null
}

function clampTimeoutMs(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return DEFAULT_TIMEOUT_MS
  return Math.min(Math.max(Math.trunc(parsed), 1_000), MAX_TIMEOUT_MS)
}

function configuredGeminiModels() {
  const models = new Set(GEMINI_MODELS)
  for (const raw of String(process.env.AI_PROVIDER_GEMINI_MODELS || '').split(',')) {
    const model = raw.trim()
    if (MODEL_PATTERN.test(model)) models.add(model)
  }
  return models
}

function configuredOpenRouterSpeakingModels() {
  const models = new Set(OPENROUTER_SPEAKING_MODELS)
  for (const raw of String(process.env.AI_PROVIDER_OPENROUTER_SPEAKING_MODELS || '').split(',')) {
    const model = raw.trim()
    if (MODEL_PATTERN.test(model)) models.add(model)
  }
  return models
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every(key => allowed.has(key))
}

function isValidSpeakingPart(part) {
  if (!isPlainObject(part)) return false
  if (part.type === 'text') {
    return hasOnlyKeys(part, new Set(['type', 'text'])) && typeof part.text === 'string'
  }
  if (part.type === 'input_audio') {
    return hasOnlyKeys(part, new Set(['type', 'input_audio'])) &&
      isPlainObject(part.input_audio) &&
      hasOnlyKeys(part.input_audio, new Set(['data', 'format'])) &&
      typeof part.input_audio.data === 'string' &&
      ['mp3', 'm4a', 'wav', 'webm', 'ogg'].includes(part.input_audio.format)
  }
  return false
}

function isValidSpeakingMessages(messages) {
  return Array.isArray(messages) && messages.length > 0 && messages.length <= 10 && messages.every(message => (
    isPlainObject(message) &&
    hasOnlyKeys(message, new Set(['role', 'content'])) &&
    ['system', 'user', 'assistant'].includes(message.role) &&
    (typeof message.content === 'string' ||
      (Array.isArray(message.content) && message.content.length > 0 && message.content.every(isValidSpeakingPart)))
  ))
}

function isValidGeminiSpeakingBody(body) {
  if (!isPlainObject(body) || !hasOnlyKeys(body, new Set(['contents']))) return false
  if (!Array.isArray(body.contents) || body.contents.length !== 1) return false
  const content = body.contents[0]
  if (!isPlainObject(content) || !hasOnlyKeys(content, new Set(['parts'])) || !Array.isArray(content.parts)) return false
  return content.parts.length > 0 && content.parts.every(part => {
    if (!isPlainObject(part)) return false
    if (typeof part.text === 'string') return hasOnlyKeys(part, new Set(['text']))
    return hasOnlyKeys(part, new Set(['inlineData'])) &&
      isPlainObject(part.inlineData) &&
      hasOnlyKeys(part.inlineData, new Set(['mimeType', 'data'])) &&
      typeof part.inlineData.mimeType === 'string' &&
      part.inlineData.mimeType.startsWith('audio/') &&
      typeof part.inlineData.data === 'string'
  })
}

function validateSpeakingRequest(body) {
  if (!isPlainObject(body) || !hasOnlyKeys(body, new Set(['openRouter', 'gemini']))) {
    return 'Invalid speaking provider body'
  }
  const openRouter = body.openRouter
  const gemini = body.gemini
  if (!isPlainObject(openRouter) ||
      !hasOnlyKeys(openRouter, new Set(['model', 'messages', 'maxTokens', 'responseFormat'])) ||
      !configuredOpenRouterSpeakingModels().has(openRouter.model) ||
      !isValidSpeakingMessages(openRouter.messages) ||
      openRouter.responseFormat !== 'json_object' ||
      !Number.isInteger(openRouter.maxTokens) || openRouter.maxTokens < 16 || openRouter.maxTokens > 4_000) {
    return 'Invalid OpenRouter speaking request'
  }
  if (!isPlainObject(gemini) ||
      !hasOnlyKeys(gemini, new Set(['model', 'fallbackModel', 'body'])) ||
      !configuredGeminiModels().has(gemini.model) ||
      (gemini.fallbackModel !== undefined && (
        !configuredGeminiModels().has(gemini.fallbackModel) || gemini.fallbackModel === gemini.model
      )) ||
      !isValidGeminiSpeakingBody(gemini.body)) {
    return 'Invalid Gemini speaking request'
  }
  return null
}

function validateBody(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'Request body must be an object'
  for (const key of Object.keys(payload)) {
    if (!ALLOWED_KEYS.has(key)) return `Unsupported field: ${key}`
  }
  if (!['gemini-generate', 'replicate-create', 'replicate-status', 'speaking-generate'].includes(payload.operation)) {
    return 'Unsupported operation'
  }
  if (payload.operation === 'gemini-generate' && !configuredGeminiModels().has(payload.model)) {
    return 'Gemini model is not allowed'
  }
  if (payload.fallbackModel !== undefined && (
    payload.operation !== 'gemini-generate' ||
    !configuredGeminiModels().has(payload.fallbackModel) ||
    payload.fallbackModel === payload.model
  )) {
    return 'Gemini fallback model is not allowed'
  }
  if (payload.operation === 'replicate-create' && !REPLICATE_MODELS.has(payload.model)) {
    return 'Replicate model is not allowed'
  }
  if (payload.operation === 'replicate-status' && !PREDICTION_ID_PATTERN.test(String(payload.predictionId || ''))) {
    return 'Invalid predictionId'
  }
  if (payload.operation !== 'replicate-status' &&
      (!payload.body || typeof payload.body !== 'object' || Array.isArray(payload.body))) {
    return 'Provider body must be an object'
  }
  if (payload.operation === 'speaking-generate') return validateSpeakingRequest(payload.body)
  return null
}

async function fetchGemini(model, body, signal) {
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) throw new Error('Gemini provider is not configured')
    return fetch(`${GEMINI_BASE_URL}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
}

function shouldFallbackStatus(status) {
  return status === 401 || status === 403 || status === 429 || (status >= 500 && status !== 504)
}

async function fetchGeminiChain(gemini, signal) {
  const primary = await fetchGemini(gemini.model, gemini.body, signal)
  if (primary.ok || !gemini.fallbackModel || !shouldFallbackStatus(primary.status)) {
    return { response: primary, provider: 'gemini', model: gemini.model }
  }
  await primary.body?.cancel()
  return {
    response: await fetchGemini(gemini.fallbackModel, gemini.body, signal),
    provider: 'gemini',
    model: gemini.fallbackModel,
  }
}

async function fetchSpeaking(payload, signal) {
  const { openRouter, gemini } = payload.body
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) return fetchGeminiChain(gemini, signal)

  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'http-referer': process.env.OPENROUTER_SITE_URL || 'https://nodedu.net',
      'x-title': process.env.OPENROUTER_APP_NAME || 'nodedu-ai-egress',
    },
    body: JSON.stringify({
      model: openRouter.model,
      messages: openRouter.messages,
      max_tokens: openRouter.maxTokens,
      response_format: { type: 'json_object' },
    }),
    signal,
  })
  if (response.ok || !shouldFallbackStatus(response.status) || !process.env.GEMINI_API_KEY) {
    return { response, provider: 'openrouter', model: openRouter.model }
  }
  await response.body?.cancel()
  return fetchGeminiChain(gemini, signal)
}

async function fetchProvider(payload, signal) {
  if (payload.operation === 'speaking-generate') return fetchSpeaking(payload, signal)
  if (payload.operation === 'gemini-generate') {
    const primaryResponse = await fetchGemini(payload.model, payload.body, signal)
    if (primaryResponse.ok || !payload.fallbackModel || !shouldFallbackStatus(primaryResponse.status)) {
      return { response: primaryResponse, provider: 'gemini', model: payload.model }
    }
    await primaryResponse.body?.cancel()
    return {
      response: await fetchGemini(payload.fallbackModel, payload.body, signal),
      provider: 'gemini',
      model: payload.fallbackModel,
    }
  }

  const token = process.env.REPLICATE_API_TOKEN
  if (!token) throw new Error('Replicate provider is not configured')
  if (payload.operation === 'replicate-create') {
    const [owner, model] = payload.model.split('/')
    return { response: await fetch(`${REPLICATE_BASE_URL}/models/${encodeURIComponent(owner)}/${encodeURIComponent(model)}/predictions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        prefer: 'wait',
      },
      body: JSON.stringify(payload.body),
      signal,
    }), provider: 'replicate', model: payload.model }
  }

  return { response: await fetch(`${REPLICATE_BASE_URL}/predictions/${encodeURIComponent(payload.predictionId)}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    signal,
  }), provider: 'replicate', model: null }
}

function copyProviderResponse(response, bytes, metadata) {
  const headers = new Headers(response.headers)
  headers.delete('connection')
  headers.delete('content-encoding')
  headers.delete('content-length')
  headers.delete('transfer-encoding')
  headers.delete('set-cookie')
  headers.set('x-nodedu-ai-provider', metadata.provider)
  if (metadata.model) headers.set('x-nodedu-ai-model', metadata.model)
  return new Response(bytes, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

export async function POST(request) {
  const authError = authorize(request)
  if (authError) return authError

  let payload
  try {
    const raw = await request.text()
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
      return json({ error: 'Request body is too large' }, 413)
    }
    payload = JSON.parse(raw)
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  const validationError = validateBody(payload)
  if (validationError) return json({ error: validationError }, 400)

  const timeoutMs = clampTimeoutMs(payload.timeoutMs)
  const controller = new AbortController()
  let deadlineExceeded = false
  const abort = () => controller.abort(request.signal.reason)
  if (request.signal.aborted) abort()
  else request.signal.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(() => {
    deadlineExceeded = true
    controller.abort(new DOMException(`Provider timeout after ${timeoutMs}ms`, 'TimeoutError'))
  }, timeoutMs)

  try {
    const providerResult = await fetchProvider(payload, controller.signal)
    return copyProviderResponse(
      providerResult.response,
      await providerResult.response.arrayBuffer(),
      providerResult,
    )
  } catch (error) {
    if (deadlineExceeded) return json({ error: `Provider timeout after ${timeoutMs}ms` }, 504)
    if (request.signal.aborted) return json({ error: 'Provider request cancelled' }, 499)
    return json({ error: String(error?.message || error).slice(0, 500) }, 502)
  } finally {
    clearTimeout(timeout)
    request.signal.removeEventListener('abort', abort)
  }
}
