import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "../api/tts-synthesize.js";

function buildRequest(body, secret = "test-secret", signal) {
  return new Request("https://egress.example/api/tts-synthesize", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-nodedu-ai-egress-secret": secret,
    },
    body: JSON.stringify(body),
    signal,
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
    return new Response(JSON.stringify({
      audioContent: "YXVkaW8=",
      timepoints: [
        { markName: "lr_gap_1_start", timeSeconds: 1.2 },
        { markName: "lr_gap_1_end", timeSeconds: 1.4 },
      ],
    }), { status: 200 });
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
    apiVersion: "v1beta1",
    audioConfig: { audioEncoding: "MP3" },
    enableTimePointing: ["SSML_MARK"],
  }));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.inputType, "ssml");
  assert.deepEqual(googleBody.input, {
    ssml: '<speak>First.<break time="400ms"/>Second.</speak>',
  });
  assert.deepEqual(googleBody.enableTimePointing, ["SSML_MARK"]);
  assert.deepEqual(payload.timepoints, [
    { markName: "lr_gap_1_start", timeSeconds: 1.2 },
    { markName: "lr_gap_1_end", timeSeconds: 1.4 },
  ]);
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

test("prefers a dedicated TTS secret without changing the shared AI secret", async (t) => {
  const originalTtsSecret = process.env.TTS_EGRESS_SHARED_SECRET;
  const originalAiSecret = process.env.AI_EGRESS_SHARED_SECRET;
  const originalApiKey = process.env.GOOGLE_TTS_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.TTS_EGRESS_SHARED_SECRET = "tts-only-secret";
  process.env.AI_EGRESS_SHARED_SECRET = "shared-ai-secret";
  process.env.GOOGLE_TTS_API_KEY = "test-key";
  globalThis.fetch = async () => new Response(JSON.stringify({ audioContent: "YXVkaW8=" }), { status: 200 });

  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalTtsSecret === undefined) delete process.env.TTS_EGRESS_SHARED_SECRET;
    else process.env.TTS_EGRESS_SHARED_SECRET = originalTtsSecret;
    if (originalAiSecret === undefined) delete process.env.AI_EGRESS_SHARED_SECRET;
    else process.env.AI_EGRESS_SHARED_SECRET = originalAiSecret;
    if (originalApiKey === undefined) delete process.env.GOOGLE_TTS_API_KEY;
    else process.env.GOOGLE_TTS_API_KEY = originalApiKey;
  });

  const body = {
    text: "Hello.",
    voiceName: "en-US-Neural2-F",
    languageCode: "en-US",
    apiVersion: "v1",
    audioConfig: { audioEncoding: "MP3" },
  };
  const accepted = await POST(buildRequest(body, "tts-only-secret"));
  const rejected = await POST(buildRequest(body, "shared-ai-secret"));

  assert.equal(accepted.status, 200);
  assert.equal(rejected.status, 401);
});

test("runs the requested voice fallback inside one egress request", async (t) => {
  const originalSecret = process.env.AI_EGRESS_SHARED_SECRET;
  const originalApiKey = process.env.GOOGLE_TTS_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.AI_EGRESS_SHARED_SECRET = "test-secret";
  process.env.GOOGLE_TTS_API_KEY = "test-key";

  const googleBodies = [];
  const googleSignals = [];
  globalThis.fetch = async (_url, init) => {
    googleBodies.push(JSON.parse(String(init.body)));
    googleSignals.push(init.signal);
    if (googleBodies.length === 1) {
      return new Response(JSON.stringify({ error: { code: 400, message: "voice unavailable" } }), { status: 400 });
    }
    return new Response(JSON.stringify({ audioContent: "ZmFsbGJhY2s=" }), { status: 200 });
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
    voiceName: "en-US-Chirp3-HD-Aoede",
    languageCode: "en-US",
    apiVersion: "v1beta1",
    audioConfig: { audioEncoding: "MP3", speakingRate: 0.95 },
    fallback: {
      text: "Hello.",
      inputType: "text",
      voiceName: "en-US-Neural2-F",
      languageCode: "en-US",
      apiVersion: "v1",
      audioConfig: { audioEncoding: "MP3", speakingRate: 0.95, pitch: 0 },
    },
  }));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.fallbackUsed, true);
  assert.equal(payload.voiceName, "en-US-Neural2-F");
  assert.equal(googleBodies.length, 2);
  assert.equal(googleSignals[0], googleSignals[1]);
  assert.deepEqual(googleBodies[1].voice, {
    languageCode: "en-US",
    name: "en-US-Neural2-F",
  });
});

test("does not fallback for a transient provider error", async (t) => {
  const originalSecret = process.env.AI_EGRESS_SHARED_SECRET;
  const originalApiKey = process.env.GOOGLE_TTS_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.AI_EGRESS_SHARED_SECRET = "test-secret";
  process.env.GOOGLE_TTS_API_KEY = "test-key";
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { code: 503, message: "service unavailable" } }), { status: 503 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalSecret === undefined) delete process.env.AI_EGRESS_SHARED_SECRET;
    else process.env.AI_EGRESS_SHARED_SECRET = originalSecret;
    if (originalApiKey === undefined) delete process.env.GOOGLE_TTS_API_KEY;
    else process.env.GOOGLE_TTS_API_KEY = originalApiKey;
  });

  const response = await POST(buildRequest(fallbackBody()));
  assert.equal(response.status, 502);
  assert.equal(calls, 1);
});

test("does not fallback for rate limiting", async (t) => {
  const originalSecret = process.env.AI_EGRESS_SHARED_SECRET;
  const originalApiKey = process.env.GOOGLE_TTS_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.AI_EGRESS_SHARED_SECRET = "test-secret";
  process.env.GOOGLE_TTS_API_KEY = "test-key";
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { code: 429, message: "rate limited" } }), { status: 429 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalSecret === undefined) delete process.env.AI_EGRESS_SHARED_SECRET;
    else process.env.AI_EGRESS_SHARED_SECRET = originalSecret;
    if (originalApiKey === undefined) delete process.env.GOOGLE_TTS_API_KEY;
    else process.env.GOOGLE_TTS_API_KEY = originalApiKey;
  });

  const response = await POST(buildRequest(fallbackBody()));
  assert.equal(response.status, 502);
  assert.equal(calls, 1);
});

test("does not fallback for a non-voice client error", async (t) => {
  const originalSecret = process.env.AI_EGRESS_SHARED_SECRET;
  const originalApiKey = process.env.GOOGLE_TTS_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.AI_EGRESS_SHARED_SECRET = "test-secret";
  process.env.GOOGLE_TTS_API_KEY = "test-key";
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { code: 400, message: "invalid SSML markup" } }), { status: 400 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalSecret === undefined) delete process.env.AI_EGRESS_SHARED_SECRET;
    else process.env.AI_EGRESS_SHARED_SECRET = originalSecret;
    if (originalApiKey === undefined) delete process.env.GOOGLE_TTS_API_KEY;
    else process.env.GOOGLE_TTS_API_KEY = originalApiKey;
  });

  const response = await POST(buildRequest(fallbackBody()));
  assert.equal(response.status, 502);
  assert.equal(calls, 1);
});

test("does not fallback after an ambiguous network failure", async (t) => {
  const originalSecret = process.env.AI_EGRESS_SHARED_SECRET;
  const originalApiKey = process.env.GOOGLE_TTS_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.AI_EGRESS_SHARED_SECRET = "test-secret";
  process.env.GOOGLE_TTS_API_KEY = "test-key";
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new TypeError("socket closed");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalSecret === undefined) delete process.env.AI_EGRESS_SHARED_SECRET;
    else process.env.AI_EGRESS_SHARED_SECRET = originalSecret;
    if (originalApiKey === undefined) delete process.env.GOOGLE_TTS_API_KEY;
    else process.env.GOOGLE_TTS_API_KEY = originalApiKey;
  });

  const response = await POST(buildRequest(fallbackBody()));
  assert.equal(response.status, 502);
  assert.equal(calls, 1);
});

test("does not fallback after a successful malformed provider response", async (t) => {
  const originalSecret = process.env.AI_EGRESS_SHARED_SECRET;
  const originalApiKey = process.env.GOOGLE_TTS_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.AI_EGRESS_SHARED_SECRET = "test-secret";
  process.env.GOOGLE_TTS_API_KEY = "test-key";
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("not-json", { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalSecret === undefined) delete process.env.AI_EGRESS_SHARED_SECRET;
    else process.env.AI_EGRESS_SHARED_SECRET = originalSecret;
    if (originalApiKey === undefined) delete process.env.GOOGLE_TTS_API_KEY;
    else process.env.GOOGLE_TTS_API_KEY = originalApiKey;
  });

  const response = await POST(buildRequest(fallbackBody()));
  assert.equal(response.status, 502);
  assert.equal(calls, 1);
});

test("does not fallback after the shared request budget aborts", async (t) => {
  const originalSecret = process.env.AI_EGRESS_SHARED_SECRET;
  const originalApiKey = process.env.GOOGLE_TTS_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.AI_EGRESS_SHARED_SECRET = "test-secret";
  process.env.GOOGLE_TTS_API_KEY = "test-key";
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls += 1;
    return await new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalSecret === undefined) delete process.env.AI_EGRESS_SHARED_SECRET;
    else process.env.AI_EGRESS_SHARED_SECRET = originalSecret;
    if (originalApiKey === undefined) delete process.env.GOOGLE_TTS_API_KEY;
    else process.env.GOOGLE_TTS_API_KEY = originalApiKey;
  });

  const response = await POST(buildRequest({ ...fallbackBody(), timeoutMs: 1 }));
  assert.equal(response.status, 504);
  assert.equal(calls, 1);
});

test("returns 499 without a provider call when the caller is already cancelled", async (t) => {
  const originalSecret = process.env.AI_EGRESS_SHARED_SECRET;
  const originalApiKey = process.env.GOOGLE_TTS_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.AI_EGRESS_SHARED_SECRET = "test-secret";
  process.env.GOOGLE_TTS_API_KEY = "test-key";
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ audioContent: "dW5leHBlY3RlZA==" }), { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalSecret === undefined) delete process.env.AI_EGRESS_SHARED_SECRET;
    else process.env.AI_EGRESS_SHARED_SECRET = originalSecret;
    if (originalApiKey === undefined) delete process.env.GOOGLE_TTS_API_KEY;
    else process.env.GOOGLE_TTS_API_KEY = originalApiKey;
  });

  const caller = new AbortController();
  caller.abort();
  const response = await POST(buildRequest(fallbackBody(), "test-secret", caller.signal));
  const payload = await response.json();

  assert.equal(response.status, 499);
  assert.equal(payload.error.status, 499);
  assert.equal(calls, 0);
});

test("cancels an in-flight request with 499 and does not run fallback", async (t) => {
  const originalSecret = process.env.AI_EGRESS_SHARED_SECRET;
  const originalApiKey = process.env.GOOGLE_TTS_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.AI_EGRESS_SHARED_SECRET = "test-secret";
  process.env.GOOGLE_TTS_API_KEY = "test-key";
  let calls = 0;
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  globalThis.fetch = async (_url, init) => {
    calls += 1;
    markStarted();
    return await new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalSecret === undefined) delete process.env.AI_EGRESS_SHARED_SECRET;
    else process.env.AI_EGRESS_SHARED_SECRET = originalSecret;
    if (originalApiKey === undefined) delete process.env.GOOGLE_TTS_API_KEY;
    else process.env.GOOGLE_TTS_API_KEY = originalApiKey;
  });

  const caller = new AbortController();
  const pending = POST(buildRequest(fallbackBody(), "test-secret", caller.signal));
  await started;
  caller.abort();
  const response = await pending;
  const payload = await response.json();

  assert.equal(response.status, 499);
  assert.equal(payload.error.status, 499);
  assert.equal(calls, 1);
});

function fallbackBody() {
  return {
    text: "Hello.",
    voiceName: "en-US-Chirp3-HD-Aoede",
    languageCode: "en-US",
    apiVersion: "v1beta1",
    audioConfig: { audioEncoding: "MP3" },
    fallback: {
      text: "Hello.",
      inputType: "text",
      voiceName: "en-US-Neural2-F",
      languageCode: "en-US",
      apiVersion: "v1",
      audioConfig: { audioEncoding: "MP3" },
    },
  };
}
