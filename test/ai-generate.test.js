import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "../api/ai-generate.js";

const ENV_KEYS = [
  "AI_EGRESS_SHARED_SECRET",
  "AI_EGRESS_PRIMARY_PROVIDER",
  "AI_EGRESS_ALLOW_PROVIDER_FALLBACK",
  "OPENROUTER_API_KEY",
  "OPENROUTER_MODEL",
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
];

function buildRequest(body, options = {}) {
  return new Request("https://egress.example/api/ai-generate", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-nodedu-ai-egress-secret": options.secret ?? "test-secret",
    },
    body: JSON.stringify(body),
    signal: options.signal,
  });
}

function installTestEnvironment(t) {
  const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;

  process.env.AI_EGRESS_SHARED_SECRET = "test-secret";
  process.env.OPENROUTER_API_KEY = "openrouter-key";
  process.env.OPENAI_API_KEY = "openai-key";
  delete process.env.AI_EGRESS_PRIMARY_PROVIDER;
  delete process.env.AI_EGRESS_ALLOW_PROVIDER_FALLBACK;
  delete process.env.OPENROUTER_MODEL;
  delete process.env.OPENAI_MODEL;
  console.log = () => {};

  t.after(() => {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function providerResponse({
  text = "generated text",
  id = "generation-1",
  finishReason = "stop",
  nativeFinishReason,
  usage = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
} = {}) {
  return new Response(JSON.stringify({
    id,
    choices: [{
      message: { content: text },
      finish_reason: finishReason,
      ...(nativeFinishReason === undefined ? {} : { native_finish_reason: nativeFinishReason }),
    }],
    usage,
  }), { status: 200 });
}

function providerError(status, message = "provider failed") {
  return new Response(JSON.stringify({ error: { message } }), { status });
}

test("preserves an explicit OpenRouter multimodal request and reports upstream completion metadata", async (t) => {
  installTestEnvironment(t);
  process.env.AI_EGRESS_PRIMARY_PROVIDER = "openai";

  const messages = [
    { role: "system", content: "Inspect the source." },
    {
      role: "user",
      content: [
        { type: "text", text: "Summarize this recording and document." },
        { type: "input_audio", input_audio: { data: "YXVkaW8=", format: "mp3" } },
        { type: "file", file: { filename: "source.pdf", file_data: "data:application/pdf;base64,JVBERg==" } },
      ],
    },
  ];
  const plugins = [{ id: "file-parser", pdf: { engine: "native" } }];
  let providerUrl;
  let providerBody;
  globalThis.fetch = async (url, init) => {
    providerUrl = String(url);
    providerBody = JSON.parse(String(init.body));
    return providerResponse({
      text: "partial but usable",
      id: "or-generation-123",
      finishReason: "length",
      nativeFinishReason: "max_tokens",
    });
  };

  const response = await POST(buildRequest({
    aiProvider: "openrouter",
    model: "anthropic/claude-sonnet-4.5",
    system: "legacy system",
    prompt: "legacy prompt",
    messages,
    plugins,
    maxTokens: 65536,
    responseFormat: "json_object",
    reasoning: { effort: "high", exclude: false },
    provider: { order: ["Anthropic"], allow_fallbacks: false },
    purpose: `purpose-${"p".repeat(150)}`,
    teacherId: `teacher-${"t".repeat(150)}`,
    runId: `run-${"r".repeat(100)}`,
    idempotencyKey: `request-${"i".repeat(200)}`,
  }));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(providerUrl, "https://openrouter.ai/api/v1/chat/completions");
  assert.deepEqual(providerBody, {
    model: "anthropic/claude-sonnet-4.5",
    max_tokens: 65536,
    messages,
    response_format: { type: "json_object" },
    reasoning: { effort: "high", exclude: false },
    provider: { order: ["Anthropic"], allow_fallbacks: false },
    plugins,
  });
  assert.equal(payload.provider, "openrouter");
  assert.equal(payload.model, "anthropic/claude-sonnet-4.5");
  assert.equal(payload.text, "partial but usable");
  assert.equal(payload.providerGenerationId, "or-generation-123");
  assert.equal(payload.finishReason, "length");
  assert.equal(payload.nativeFinishReason, "max_tokens");
  assert.equal(payload.truncated, true);
  assert.equal(payload.incomplete, true);
  assert.deepEqual(payload.requestContext, {
    purpose: `purpose-${"p".repeat(112)}`,
    teacherId: `teacher-${"t".repeat(120)}`,
    runId: `run-${"r".repeat(76)}`,
    idempotencyKey: `request-${"i".repeat(152)}`,
  });
  assert.deepEqual(payload.providerAttempts, [{
    provider: "openrouter",
    model: "anthropic/claude-sonnet-4.5",
    status: 200,
    outcome: "success",
    elapsedMs: payload.providerAttempts[0].elapsedMs,
    providerGenerationId: "or-generation-123",
    finishReason: "length",
    serviceTier: null,
  }]);
  assert.equal("idempotent" in payload, false);
  assert.equal("idempotency" in payload, false);
});

test("routes Sol aliases and dated versions through Flex across primary, env, and fallback", async (t) => {
  installTestEnvironment(t);
  const routing = { order: ["OpenAI"], sort: "throughput", only: ["OpenAI"], ignore: ["Other"], allow_fallbacks: false };
  for (const provider of ["openrouter", "openai"]) {
    for (const model of ["gpt-6-sol", "openai/gpt-6-sol:floor", "openai/gpt-6-sol-20260922:nitro", "gpt-6-sol-2026-09-22", "OPENAI/GPT-6-SOL:NITRO"]) {
      for (const source of ["primary", "env", "fallback"]) {
        const calls = [];
        globalThis.fetch = async (url, init) => {
          calls.push({ url: String(url), body: JSON.parse(init.body) });
          if (source === "fallback" && calls.length === 1) return providerError(403);
          return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], service_tier: "default", usage: { total_tokens: 5 } }));
        };
        const body = { aiProvider: provider, system: "system", prompt: "prompt", model, provider: routing };
        if (source === "env") {
          delete body.model;
          delete body.aiProvider;
          process.env.AI_EGRESS_PRIMARY_PROVIDER = provider;
          process.env[provider === "openrouter" ? "OPENROUTER_MODEL" : "OPENAI_MODEL"] = model;
        }
        if (source === "fallback") {
          body.model = "gpt-6-luna";
          body.fallback = { aiProvider: provider, model, provider: routing };
        }
        const response = await POST(buildRequest(body));
        const result = await response.json();
        assert.equal(response.status, 200, `${provider}/${model}/${source}`);
        const sent = calls.at(-1).body;
        const bare = model.toLowerCase().replace(/^openai\//, "").replace(/:.*$/, "");
        assert.equal(sent.model, provider === "openrouter" ? `openai/${bare}:floor` : bare);
        if (provider === "openrouter") {
          assert.deepEqual(sent.provider, { sort: "price", only: ["OpenAI"], ignore: ["Other"], allow_fallbacks: false });
          assert.equal(sent.service_tier, undefined);
        } else {
          assert.equal(sent.service_tier, "flex");
          assert.equal(sent.provider, undefined);
        }
        assert.equal(result.model, sent.model);
        assert.equal(result.serviceTier, "default");
        assert.equal(result.usage.service_tier, "default");
        assert.equal(result.providerAttempts.at(-1).serviceTier, "default");
        assert.deepEqual(routing.order, ["OpenAI"]);
      }
    }
  }
});

test("keeps Luna and other models unchanged and never infers returned Flex", async (t) => {
  installTestEnvironment(t);
  for (const provider of ["openrouter", "openai"]) {
    for (const model of ["openai/gpt-6-luna", "openai/gpt-5.6-sol", "openai/gpt-6-sol:online", "openai/gpt-6-sol:free", "openai/gpt-6-sol:floor:online", "openai/gpt-6-sol:nitro:floor", "openai/gpt-6-sol"]) {
      let sent;
      globalThis.fetch = async (_url, init) => { sent = JSON.parse(init.body); return providerResponse(); };
      const result = await (await POST(buildRequest({ aiProvider: provider, model, system: "s", prompt: "p", provider: { order: ["OpenAI"] } }))).json();
      assert.equal(result.serviceTier, null);
      assert.equal(result.usage.service_tier, undefined);
      if (model === "openai/gpt-6-sol") continue;
      assert.equal(sent.model, provider === "openai" ? model.replace(/^openai\//, "") : model);
      assert.equal(sent.service_tier, undefined);
      if (provider === "openrouter") assert.deepEqual(sent.provider, { order: ["OpenAI"] });
    }
  }
});

test("preserves response usage tier when top-level tier is absent", async (t) => {
  installTestEnvironment(t);
  globalThis.fetch = async () => providerResponse({ usage: { total_tokens: 3, service_tier: "flex" } });
  const result = await (await POST(buildRequest({ model: "openai/gpt-6-sol", system: "s", prompt: "p" }))).json();
  assert.equal(result.serviceTier, "flex");
  assert.deepEqual(result.usage, { total_tokens: 3, service_tier: "flex" });
});

test("does not use hidden cross-provider fallback for a legacy request", async (t) => {
  installTestEnvironment(t);
  process.env.AI_EGRESS_ALLOW_PROVIDER_FALLBACK = "true";
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return providerError(403, "not available in your region");
  };

  const response = await POST(buildRequest({
    aiProvider: "openrouter",
    model: "openai/gpt-5.4",
    system: "system",
    prompt: "prompt",
    maxTokens: 1024,
    purpose: "legacy_generation",
    teacherId: "teacher-legacy",
    runId: "run-legacy",
    idempotencyKey: "request-legacy",
  }));
  const payload = await response.json();

  assert.equal(response.status, 403);
  assert.equal(calls, 1);
  assert.equal(payload.providerAttempts.length, 1);
  assert.equal(payload.providerAttempts[0].provider, "openrouter");
  assert.equal(payload.providerAttempts[0].status, 403);
  assert.deepEqual(payload.requestContext, {
    purpose: "legacy_generation",
    teacherId: "teacher-legacy",
    runId: "run-legacy",
    idempotencyKey: "request-legacy",
  });
});

test("uses one explicit access-error fallback with its exact provider, model, and token budget", async (t) => {
  installTestEnvironment(t);
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    if (calls.length === 1) return providerError(403, "region blocked");
    return providerResponse({ id: "oa-generation-456" });
  };

  const response = await POST(buildRequest({
    aiProvider: "openrouter",
    model: "anthropic/claude-sonnet-4.5",
    system: "system",
    prompt: "prompt",
    maxTokens: 65536,
    fallback: {
      aiProvider: "openai",
      model: "openai/gpt-5.4",
      maxTokens: 32768,
      on: "access_error",
    },
  }));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(calls.map((call) => call.url), [
    "https://openrouter.ai/api/v1/chat/completions",
    "https://api.openai.com/v1/chat/completions",
  ]);
  assert.equal(calls[0].body.model, "anthropic/claude-sonnet-4.5");
  assert.equal(calls[0].body.max_tokens, 65536);
  assert.equal(calls[1].body.model, "gpt-5.4");
  assert.equal(calls[1].body.max_completion_tokens, 32768);
  assert.equal(payload.provider, "openai");
  assert.equal(payload.model, "gpt-5.4");
  assert.equal(payload.providerGenerationId, "oa-generation-456");
  assert.deepEqual(payload.providerAttempts.map(({ provider, model, status, outcome }) => ({ provider, model, status, outcome })), [
    { provider: "openrouter", model: "anthropic/claude-sonnet-4.5", status: 403, outcome: "error" },
    { provider: "openai", model: "gpt-5.4", status: 200, outcome: "success" },
  ]);
});

test("keeps custom messages usable with empty legacy prompts and transforms compatible OpenAI fallback options", async (t) => {
  installTestEnvironment(t);
  const messages = [{
    role: "user",
    content: [
      { type: "text", text: "Review these sources." },
      { type: "input_audio", input_audio: { data: "YXVkaW8=", format: "mp3" } },
      { type: "file", file: { filename: "source.pdf", file_data: "data:application/pdf;base64,JVBERg==" } },
    ],
  }];
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    if (calls.length === 1) return providerError(403, "region blocked");
    return providerResponse();
  };

  const response = await POST(buildRequest({
    aiProvider: "openrouter",
    model: "model-a",
    system: "",
    prompt: "",
    messages,
    maxTokens: 4096,
    reasoning: { effort: "high", exclude: true },
    provider: { allow_fallbacks: false },
    fallback: { aiProvider: "openai", model: "openai/model-b", on: "access_error" },
  }));

  assert.equal(response.status, 200);
  assert.deepEqual(calls[1].body.messages, messages);
  assert.equal(calls[1].body.reasoning_effort, "high");
  assert.equal("reasoning" in calls[1].body, false);
  assert.equal("provider" in calls[1].body, false);
});

test("keeps access-error and retryable-error fallback conditions separate", async (t) => {
  installTestEnvironment(t);
  let accessCalls = 0;
  globalThis.fetch = async () => {
    accessCalls += 1;
    return providerError(429, "rate limited");
  };

  const accessResponse = await POST(buildRequest({
    aiProvider: "openrouter",
    model: "model-a",
    system: "system",
    prompt: "prompt",
    maxTokens: 1024,
    fallback: { aiProvider: "openai", model: "model-b", on: "access_error" },
  }));
  assert.equal(accessResponse.status, 429);
  assert.equal(accessCalls, 1);

  let retryableCalls = 0;
  globalThis.fetch = async () => {
    retryableCalls += 1;
    if (retryableCalls === 1) return providerError(503, "temporarily unavailable");
    return providerResponse();
  };
  const retryableResponse = await POST(buildRequest({
    aiProvider: "openrouter",
    model: "model-a",
    system: "system",
    prompt: "prompt",
    maxTokens: 1024,
    fallback: { aiProvider: "openai", model: "model-b", on: "retryable_error" },
  }));
  assert.equal(retryableResponse.status, 200);
  assert.equal(retryableCalls, 2);
});

test("uses combined access-or-retryable fallback and exact OpenRouter routing overrides", async (t) => {
  installTestEnvironment(t);

  for (const primaryStatus of [403, 429]) {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      if (calls.length === 1) return providerError(primaryStatus, `primary ${primaryStatus}`);
      return providerResponse({ id: `fallback-${primaryStatus}` });
    };

    const response = await POST(buildRequest({
      aiProvider: "openai",
      model: "openai/gpt-5.4",
      system: "report system",
      prompt: "report prompt",
      maxTokens: 4096,
      reasoning: { effort: "low" },
      provider: { order: ["Primary routing must not reach OpenAI"] },
      fallback: {
        aiProvider: "openrouter",
        model: "google/gemini-2.5-pro",
        maxTokens: 8192,
        on: "access_or_retryable_error",
        reasoning: { effort: "high", exclude: false },
        provider: { order: ["Google AI Studio"], allow_fallbacks: false },
      },
    }));
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(calls, [
      {
        url: "https://api.openai.com/v1/chat/completions",
        body: {
          model: "gpt-5.4",
          max_completion_tokens: 4096,
          messages: [
            { role: "system", content: "report system" },
            { role: "user", content: "report prompt" },
          ],
          reasoning_effort: "low",
        },
      },
      {
        url: "https://openrouter.ai/api/v1/chat/completions",
        body: {
          model: "google/gemini-2.5-pro",
          max_tokens: 8192,
          messages: [
            { role: "system", content: "report system" },
            { role: "user", content: "report prompt" },
          ],
          reasoning: { effort: "high", exclude: false },
          provider: { order: ["Google AI Studio"], allow_fallbacks: false },
        },
      },
    ]);
    assert.equal(payload.providerGenerationId, `fallback-${primaryStatus}`);
    assert.deepEqual(payload.providerAttempts.map(({ provider, status, outcome }) => ({ provider, status, outcome })), [
      { provider: "openai", status: primaryStatus, outcome: "error" },
      { provider: "openrouter", status: 200, outcome: "success" },
    ]);
  }
});

test("allows an explicit retryable fallback when the primary provider is not configured", async (t) => {
  installTestEnvironment(t);
  delete process.env.OPENROUTER_API_KEY;
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls += 1;
    assert.equal(String(url), "https://api.openai.com/v1/chat/completions");
    return providerResponse();
  };

  const response = await POST(buildRequest({
    aiProvider: "openrouter",
    model: "model-a",
    system: "system",
    prompt: "prompt",
    maxTokens: 1024,
    fallback: { aiProvider: "openai", model: "model-b", on: "retryable_error" },
  }));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  assert.deepEqual(payload.providerAttempts.map((attempt) => attempt.outcome), ["unavailable", "success"]);
});

test("does not retry an ambiguous transport failure that may have generated billable output", async (t) => {
  installTestEnvironment(t);
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new TypeError("socket closed after upload");
  };

  const response = await POST(buildRequest({
    aiProvider: "openrouter",
    model: "model-a",
    system: "system marker prompt-must-not-be-logged",
    prompt: "prompt marker YXVkaW8=",
    maxTokens: 1024,
    fallback: { aiProvider: "openai", model: "model-b", on: "retryable_error" },
  }));
  const payload = await response.json();

  assert.equal(response.status, 502);
  assert.equal(calls, 1);
  assert.equal(payload.providerAttempts[0].outcome, "ambiguous");
});

test("rejects a cross-provider fallback that would drop OpenRouter plugins", async (t) => {
  installTestEnvironment(t);
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return providerResponse();
  };

  const response = await POST(buildRequest({
    aiProvider: "openrouter",
    model: "model-a",
    system: "system",
    prompt: "prompt",
    messages: [{
      role: "user",
      content: [{ type: "file", file: { filename: "source.pdf", file_data: "data:application/pdf;base64,JVBERg==" } }],
    }],
    plugins: [{ id: "file-parser" }],
    maxTokens: 1024,
    fallback: { aiProvider: "openai", model: "model-b", on: "access_error" },
  }));
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.equal(calls, 0);
  assert.match(payload.error, /fallback.*incompatible/i);
});

test("cancels the provider call with the caller and never falls back", async (t) => {
  installTestEnvironment(t);
  const caller = new AbortController();
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls += 1;
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
  };

  const responsePromise = POST(buildRequest({
    aiProvider: "openrouter",
    model: "model-a",
    system: "system",
    prompt: "prompt",
    maxTokens: 1024,
    timeoutMs: 5000,
    fallback: { aiProvider: "openai", model: "model-b", on: "retryable_error" },
  }, { signal: caller.signal }));
  setTimeout(() => caller.abort(new DOMException("caller cancelled", "AbortError")), 10);
  const response = await responsePromise;
  const payload = await response.json();

  assert.equal(response.status, 499);
  assert.equal(calls, 1);
  assert.equal(payload.providerAttempts[0].outcome, "cancelled");
});

test("shares one total timeout budget across primary and fallback attempts", async (t) => {
  installTestEnvironment(t);
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls += 1;
    if (calls === 1) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return providerError(429, "rate limited");
    }
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
  };

  const startedAt = Date.now();
  const response = await POST(buildRequest({
    aiProvider: "openrouter",
    model: "model-a",
    system: "system",
    prompt: "prompt",
    maxTokens: 1024,
    timeoutMs: 100,
    fallback: { aiProvider: "openai", model: "model-b", on: "retryable_error" },
  }));
  const elapsedMs = Date.now() - startedAt;
  const payload = await response.json();

  assert.equal(response.status, 504);
  assert.equal(calls, 2);
  assert.ok(elapsedMs < 300, `expected one 100ms request budget, observed ${elapsedMs}ms`);
  assert.deepEqual(payload.providerAttempts.map((attempt) => attempt.outcome), ["error", "timeout"]);
});
