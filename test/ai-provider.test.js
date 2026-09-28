import assert from 'node:assert/strict'
import test from 'node:test'
import { POST } from '../api/ai-provider.js'

const ENV_KEYS = [
  'AI_EGRESS_SHARED_SECRET',
  'AI_PROVIDER_GEMINI_MODELS',
  'AI_PROVIDER_OPENROUTER_SPEAKING_MODELS',
  'GEMINI_API_KEY',
  'REPLICATE_API_TOKEN',
  'OPENROUTER_API_KEY',
]

function request(body, secret = 'test-secret', signal) {
  return new Request('https://egress.example/api/ai-provider', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-nodedu-ai-egress-secret': secret },
    body: JSON.stringify(body),
    signal,
  })
}

function setup(t) {
  const originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
  const originalFetch = globalThis.fetch
  process.env.AI_EGRESS_SHARED_SECRET = 'test-secret'
  process.env.GEMINI_API_KEY = 'gemini-secret'
  process.env.REPLICATE_API_TOKEN = 'replicate-secret'
  process.env.OPENROUTER_API_KEY = 'openrouter-secret'
  delete process.env.AI_PROVIDER_GEMINI_MODELS
  delete process.env.AI_PROVIDER_OPENROUTER_SPEAKING_MODELS
  t.after(() => {
    globalThis.fetch = originalFetch
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

test('requires authenticated Egress access before provider dispatch', async (t) => {
  setup(t)
  let calls = 0
  globalThis.fetch = async () => { calls += 1; return new Response('{}') }
  const response = await POST(request({ operation: 'gemini-generate' }, 'wrong'))
  assert.equal(response.status, 401)
  assert.equal(calls, 0)
})

test('forwards a Gemini request and preserves raw provider status and body', async (t) => {
  setup(t)
  let call
  globalThis.fetch = async (url, init) => {
    call = { url: String(url), init }
    return new Response('rate limited', {
      status: 429,
      headers: { 'retry-after': '30', 'content-encoding': 'gzip', 'content-length': '999' },
    })
  }
  const body = { contents: [{ parts: [{ text: 'grade this' }] }] }
  const response = await POST(request({
    operation: 'gemini-generate', model: 'gemini-3.5-flash', body, timeoutMs: 45_000,
  }))
  assert.equal(call.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=gemini-secret')
  assert.equal(call.init.method, 'POST')
  assert.equal(call.init.headers.authorization, undefined)
  assert.deepEqual(JSON.parse(call.init.body), body)
  assert.equal(response.status, 429)
  assert.equal(response.headers.get('retry-after'), '30')
  assert.equal(response.headers.get('content-encoding'), null)
  assert.notEqual(response.headers.get('content-length'), '999')
  assert.equal(await response.text(), 'rate limited')
})

test('runs a bounded Gemini fallback model chain inside Egress', async (t) => {
  setup(t)
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    if (calls.length === 1) return new Response('primary unavailable', { status: 503 })
    return new Response('{"candidates":[]}', { status: 200 })
  }
  const response = await POST(request({
    operation: 'gemini-generate',
    model: 'gemini-3.5-flash',
    fallbackModel: 'gemini-2.5-flash-lite',
    body: { contents: [{ parts: [{ text: 'grade this' }] }] },
  }))
  assert.equal(response.status, 200)
  assert.equal(calls.length, 2)
  assert.match(calls[0], /gemini-3\.5-flash/)
  assert.match(calls[1], /gemini-2\.5-flash-lite/)
})

test('rejects arbitrary models, fields, and prediction identifiers without fetching', async (t) => {
  setup(t)
  let calls = 0
  globalThis.fetch = async () => { calls += 1; return new Response('{}') }
  const responses = await Promise.all([
    POST(request({ operation: 'gemini-generate', model: 'attacker/model', body: {}, url: 'https://evil.test' })),
    POST(request({ operation: 'replicate-create', model: 'attacker/model', body: {} })),
    POST(request({ operation: 'replicate-status', predictionId: 'https://evil.test/x' })),
  ])
  assert.deepEqual(responses.map(response => response.status), [400, 400, 400])
  assert.equal(calls, 0)
})

test('creates one allowlisted Replicate prediction without automatic retries', async (t) => {
  setup(t)
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return new Response('{"id":"prediction_123","status":"starting"}', { status: 201 })
  }
  const body = { input: { prompt: 'portrait' } }
  const response = await POST(request({
    operation: 'replicate-create', model: 'black-forest-labs/flux-2-klein-9b', body,
  }))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.replicate.com/v1/models/black-forest-labs/flux-2-klein-9b/predictions')
  assert.equal(calls[0].init.headers.authorization, 'Bearer replicate-secret')
  assert.equal(calls[0].init.headers.prefer, 'wait')
  assert.deepEqual(JSON.parse(calls[0].init.body), body)
  assert.equal(response.status, 201)
})

test('constructs Replicate status URLs only from validated prediction IDs', async (t) => {
  setup(t)
  let call
  globalThis.fetch = async (url, init) => {
    call = { url: String(url), init }
    return new Response('{"id":"prediction_123","status":"succeeded"}')
  }
  const response = await POST(request({ operation: 'replicate-status', predictionId: 'prediction_123' }))
  assert.equal(response.status, 200)
  assert.equal(call.url, 'https://api.replicate.com/v1/predictions/prediction_123')
  assert.equal(call.init.method, 'GET')
  assert.equal(call.init.headers.authorization, 'Bearer replicate-secret')
})

function speakingBody() {
  return {
    openRouter: {
      model: 'google/gemini-3.5-flash-lite',
      messages: [
        { role: 'system', content: 'Return JSON.' },
        { role: 'user', content: [
          { type: 'text', text: 'Grade this.' },
          { type: 'input_audio', input_audio: { data: 'YXVkaW8=', format: 'webm' } },
        ] },
      ],
      maxTokens: 2_000,
      responseFormat: 'json_object',
    },
    gemini: {
      model: 'gemini-3.5-flash',
      fallbackModel: 'gemini-3.1-flash-lite',
      body: { contents: [{ parts: [
        { text: 'Grade this.' },
        { inlineData: { mimeType: 'audio/webm', data: 'YXVkaW8=' } },
      ] }] },
    },
  }
}

test('keeps the speaking provider chain inside one Egress request', async (t) => {
  setup(t)
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    if (calls.length === 1) return new Response('region denied', { status: 403 })
    if (calls.length === 2) return new Response('rate limited', { status: 429 })
    return new Response('{"candidates":[]}', { status: 200 })
  }
  const response = await POST(request({ operation: 'speaking-generate', body: speakingBody(), timeoutMs: 45_000 }))
  assert.equal(response.status, 200)
  assert.deepEqual(calls.map(url => new URL(url).hostname), [
    'openrouter.ai',
    'generativelanguage.googleapis.com',
    'generativelanguage.googleapis.com',
  ])
  assert.equal(response.headers.get('x-nodedu-ai-provider'), 'gemini')
  assert.equal(response.headers.get('x-nodedu-ai-model'), 'gemini-3.1-flash-lite')
})

test('routes env-allowlisted Sol speaking models through floor and preserves actual tier and raw bytes', async (t) => {
  setup(t)
  for (const model of ['openai/gpt-6-sol', 'openai/gpt-6-sol:floor', 'openai/gpt-6-sol-20260922:nitro']) {
    process.env.AI_PROVIDER_OPENROUTER_SPEAKING_MODELS = model.replace(/:.*$/, '')
    const expectedModel = `${model.replace(/:.*$/, '')}:floor`
    const body = speakingBody()
    body.openRouter.model = model
    for (const tier of ['flex', 'default', null]) {
      const raw = JSON.stringify({ choices: [], ...(tier ? { service_tier: tier, usage: { service_tier: tier } } : {}) })
      let sent
      globalThis.fetch = async (_url, init) => { sent = JSON.parse(init.body); return new Response(raw) }
      const response = await POST(request({ operation: 'speaking-generate', body }))
      assert.equal(response.status, 200)
      assert.equal(sent.model, expectedModel)
      assert.deepEqual(sent.provider, { sort: 'price' })
      assert.equal(response.headers.get('x-nodedu-ai-model'), expectedModel)
      assert.equal(response.headers.get('x-nodedu-ai-service-tier'), tier)
      assert.equal(await response.text(), raw)
    }
  }
})

test('does not fallback speaking requests after a 400, 504, or transport failure', async (t) => {
  setup(t)
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return new Response('invalid input', { status: 400 })
  }
  const response = await POST(request({ operation: 'speaking-generate', body: speakingBody() }))
  assert.equal(response.status, 400)
  assert.equal(calls, 1)

  globalThis.fetch = async () => {
    calls += 1
    return new Response('upstream timeout', { status: 504 })
  }
  const timedOutResponse = await POST(request({ operation: 'speaking-generate', body: speakingBody() }))
  assert.equal(timedOutResponse.status, 504)
  assert.equal(calls, 2)

  globalThis.fetch = async () => {
    calls += 1
    throw new Error('connection lost')
  }
  const failedResponse = await POST(request({ operation: 'speaking-generate', body: speakingBody() }))
  assert.equal(failedResponse.status, 502)
  assert.equal(calls, 3)
})

test('distinguishes caller cancellation from the shared provider deadline', async (t) => {
  setup(t)
  const cancellation = new AbortController()
  let started
  const fetchStarted = new Promise(resolve => { started = resolve })
  globalThis.fetch = async (_url, init) => {
    started()
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
    })
  }
  const cancelled = POST(request(
    { operation: 'speaking-generate', body: speakingBody() },
    'test-secret',
    cancellation.signal,
  ))
  await fetchStarted
  cancellation.abort(new DOMException('caller cancelled', 'AbortError'))
  assert.equal((await cancelled).status, 499)

  const originalSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = callback => {
    queueMicrotask(callback)
    return 1
  }
  t.after(() => { globalThis.setTimeout = originalSetTimeout })
  const deadlineResponse = await POST(request({
    operation: 'speaking-generate', body: speakingBody(), timeoutMs: 1_000,
  }))
  assert.equal(deadlineResponse.status, 504)
})
