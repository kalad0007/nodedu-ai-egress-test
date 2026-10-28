import assert from 'node:assert/strict'
import test from 'node:test'
import { GET } from '../api/ai-ping.js'

test('ping routes URL and env Sol through floor without changing Luna and reports only actual tier', async (t) => {
  const originalFetch = globalThis.fetch
  const saved = { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY, PING_MODELS: process.env.PING_MODELS }
  t.after(() => {
    globalThis.fetch = originalFetch
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  process.env.OPENROUTER_API_KEY = 'test-key'
  process.env.PING_MODELS = 'openai/gpt-6-sol-20260922'
  for (const url of ['https://egress.example/api/ai-ping?models=openai/gpt-6-sol:nitro,openai/gpt-6-luna', 'https://egress.example/api/ai-ping']) {
    const calls = []
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body)
      calls.push(body)
      return new Response(JSON.stringify({ choices: [{ message: { content: 'pong' } }], ...(body.model.includes('sol') ? { service_tier: 'default', usage: { total_tokens: 4 } } : {}) }))
    }
    const result = await (await GET(new Request(url))).json()
    assert.equal(result.ok, true)
    assert.equal(calls[0].model, 'openai/gpt-6.1-sol:floor')
    assert.deepEqual(calls[0].provider, { sort: 'price' })
    assert.equal(result.results[0].serviceTier, 'default')
    assert.equal(result.results[0].usage.service_tier, 'default')
    if (calls.length === 2) {
      assert.equal(calls[1].model, 'openai/gpt-6-luna')
      assert.equal(calls[1].provider, undefined)
      assert.equal(result.results[1].serviceTier, null)
    }
  }
})

test('default ping requests only Sol 6.1 and retained Luna once each', async (t) => {
  const originalFetch = globalThis.fetch;
  const saved = { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY, PING_MODELS: process.env.PING_MODELS };
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  process.env.OPENROUTER_API_KEY = 'test-key';
  delete process.env.PING_MODELS;
  const models = [];
  globalThis.fetch = async (_url, init) => {
    models.push(JSON.parse(init.body).model);
    return Response.json({ choices: [{ message: { content: 'pong' } }] });
  };
  const response = await GET(new Request('https://egress.example/api/ai-ping'));
  assert.equal(response.status, 200);
  assert.deepEqual(models, ['openai/gpt-6.1-sol:floor', 'openai/gpt-6-luna']);
});
