import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { POST } from "../api/ai-image.js";

const originalFetch = globalThis.fetch;
const originalSecret = process.env.AI_EGRESS_SHARED_SECRET;
const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv("AI_EGRESS_SHARED_SECRET", originalSecret);
  restoreEnv("OPENROUTER_API_KEY", originalOpenRouterKey);
});

test("rejects requests without the shared egress secret", async () => {
  process.env.AI_EGRESS_SHARED_SECRET = "expected-secret";
  process.env.OPENROUTER_API_KEY = "openrouter-key";
  const response = await POST(new Request("https://egress.example/api/ai-image", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "thumbnail" }),
  }));

  assert.equal(response.status, 401);
  assert.equal((await response.json()).ok, false);
});

test("generates one fixed-contract 16:9 image through OpenRouter", async () => {
  process.env.AI_EGRESS_SHARED_SECRET = "expected-secret";
  process.env.OPENROUTER_API_KEY = "openrouter-key";
  let providerUrl = "";
  let providerBody = null;
  let providerHeaders = null;
  globalThis.fetch = async (url, init) => {
    providerUrl = String(url);
    providerBody = JSON.parse(String(init.body));
    providerHeaders = new Headers(init.headers);
    return new Response(JSON.stringify({
      data: [{ b64_json: "base64-image", media_type: "image/png" }],
      usage: { cost: 0.04 },
    }), { status: 200 });
  };

  const response = await POST(new Request("https://egress.example/api/ai-image", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-nodedu-ai-egress-secret": "expected-secret",
    },
    body: JSON.stringify({
      model: "google/gemini-3.1-flash-image",
      prompt: "Create a vocabulary thumbnail.",
      n: 1,
      resolution: "1K",
      aspectRatio: "16:9",
      purpose: "blog_image",
    }),
  }));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.base64, "base64-image");
  assert.equal(providerUrl, "https://openrouter.ai/api/v1/images");
  assert.equal(providerHeaders.get("authorization"), "Bearer openrouter-key");
  assert.deepEqual(providerBody, {
    model: "google/gemini-3.1-flash-image",
    prompt: "Create a vocabulary thumbnail.",
    n: 1,
    resolution: "1K",
    aspect_ratio: "16:9",
  });
});

test("rejects a caller-selected model", async () => {
  process.env.AI_EGRESS_SHARED_SECRET = "expected-secret";
  process.env.OPENROUTER_API_KEY = "openrouter-key";
  globalThis.fetch = async () => {
    throw new Error("provider must not be called");
  };

  const response = await POST(new Request("https://egress.example/api/ai-image", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-nodedu-ai-egress-secret": "expected-secret",
    },
    body: JSON.stringify({ prompt: "thumbnail", model: "unapproved/model" }),
  }));

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "model is not allowed");
});

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
