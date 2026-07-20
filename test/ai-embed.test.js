import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { POST } from "../api/ai-embed.js";

const originalFetch = globalThis.fetch;
const originalSecret = process.env.AI_EGRESS_SHARED_SECRET;
const originalGeminiKey = process.env.GEMINI_API_KEY;

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv("AI_EGRESS_SHARED_SECRET", originalSecret);
  restoreEnv("GEMINI_API_KEY", originalGeminiKey);
});

test("rejects requests without the shared egress secret", async () => {
  process.env.AI_EGRESS_SHARED_SECRET = "expected-secret";
  process.env.GEMINI_API_KEY = "gemini-key";
  const response = await POST(new Request("https://egress.example/api/ai-embed", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "hello" }),
  }));

  assert.equal(response.status, 401);
  assert.equal((await response.json()).ok, false);
});

test("returns a validated 768-dimension Gemini embedding", async () => {
  process.env.AI_EGRESS_SHARED_SECRET = "expected-secret";
  process.env.GEMINI_API_KEY = "gemini-key";
  const vector = Array.from({ length: 768 }, (_, index) => index / 1000);
  let providerUrl = "";
  let providerBody = null;
  globalThis.fetch = async (url, init) => {
    providerUrl = String(url);
    providerBody = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ embedding: { values: vector } }), { status: 200 });
  };

  const response = await POST(new Request("https://egress.example/api/ai-embed", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-nodedu-ai-egress-secret": "expected-secret",
    },
    body: JSON.stringify({ text: "semantic input", outputDimensionality: 768 }),
  }));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.model, "gemini-embedding-001");
  assert.equal(payload.embedding.length, 768);
  assert.match(providerUrl, /gemini-embedding-001:embedContent\?key=gemini-key$/);
  assert.deepEqual(providerBody, {
    content: { parts: [{ text: "semantic input" }] },
    output_dimensionality: 768,
  });
});

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
