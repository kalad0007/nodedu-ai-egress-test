import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "../api/tts-synthesize.js";

function buildRequest(body) {
  return new Request("https://egress.example/api/tts-synthesize", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-nodedu-ai-egress-secret": "test-secret",
    },
    body: JSON.stringify(body),
  });
}

test("forwards SSML to Google and confirms the input type", async (t) => {
  const originalSecret = process.env.AI_EGRESS_SHARED_SECRET;
  const originalApiKey = process.env.GOOGLE_TTS_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.AI_EGRESS_SHARED_SECRET = "test-secret";
  process.env.GOOGLE_TTS_API_KEY = "test-key";

  let googleBody;
  globalThis.fetch = async (_url, init) => {
    googleBody = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ audioContent: "YXVkaW8=" }), { status: 200 });
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalSecret === undefined) delete process.env.AI_EGRESS_SHARED_SECRET;
    else process.env.AI_EGRESS_SHARED_SECRET = originalSecret;
    if (originalApiKey === undefined) delete process.env.GOOGLE_TTS_API_KEY;
    else process.env.GOOGLE_TTS_API_KEY = originalApiKey;
  });

  const response = await POST(buildRequest({
    inputType: "ssml",
    ssml: '<speak>First.<break time="400ms"/>Second.</speak>',
    voiceName: "en-US-Neural2-F",
    languageCode: "en-US",
    apiVersion: "v1",
    audioConfig: { audioEncoding: "MP3" },
  }));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.inputType, "ssml");
  assert.deepEqual(googleBody.input, {
    ssml: '<speak>First.<break time="400ms"/>Second.</speak>',
  });
});

test("keeps the version-one text contract compatible", async (t) => {
  const originalSecret = process.env.AI_EGRESS_SHARED_SECRET;
  const originalApiKey = process.env.GOOGLE_TTS_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.AI_EGRESS_SHARED_SECRET = "test-secret";
  process.env.GOOGLE_TTS_API_KEY = "test-key";

  let googleBody;
  globalThis.fetch = async (_url, init) => {
    googleBody = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ audioContent: "YXVkaW8=" }), { status: 200 });
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalSecret === undefined) delete process.env.AI_EGRESS_SHARED_SECRET;
    else process.env.AI_EGRESS_SHARED_SECRET = originalSecret;
    if (originalApiKey === undefined) delete process.env.GOOGLE_TTS_API_KEY;
    else process.env.GOOGLE_TTS_API_KEY = originalApiKey;
  });

  const response = await POST(buildRequest({
    text: "Hello.",
    voiceName: "en-US-Neural2-F",
    languageCode: "en-US",
    apiVersion: "v1",
    audioConfig: { audioEncoding: "MP3" },
  }));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.inputType, "text");
  assert.deepEqual(googleBody.input, { text: "Hello." });
});
