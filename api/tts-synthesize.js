const DEFAULT_TIMEOUT_MS = 60000;
const MAX_TIMEOUT_MS = 120000;

class GoogleTtsError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "GoogleTtsError";
    this.status = options.status || 502;
    this.body = options.body || "";
    this.elapsedMs = options.elapsedMs || null;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function vercelContext(request) {
  return {
    region: process.env.VERCEL_REGION || null,
    id: request.headers.get("x-vercel-id"),
    country: request.headers.get("x-vercel-ip-country"),
    city: request.headers.get("x-vercel-ip-city"),
  };
}

function authorize(request) {
  const expected = process.env.AI_EGRESS_SHARED_SECRET;
  if (!expected) {
    return { ok: false, status: 500, error: "AI_EGRESS_SHARED_SECRET is not configured" };
  }

  const actual = request.headers.get("x-nodedu-ai-egress-secret");
  if (!actual || actual !== expected) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }

  return { ok: true };
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function resolveTimeoutMs(body) {
  return clampInteger(body.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, MAX_TIMEOUT_MS);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertBody(body) {
  if (!body || typeof body !== "object") return "Request body must be JSON";
  if (typeof body.text !== "string" || !body.text.trim()) return "text is required";
  if (typeof body.voiceName !== "string" || !body.voiceName.trim()) return "voiceName is required";
  if (typeof body.languageCode !== "string" || !body.languageCode.trim()) return "languageCode is required";
  if (body.apiVersion !== "v1" && body.apiVersion !== "v1beta1") return "apiVersion must be v1 or v1beta1";
  if (!isPlainObject(body.audioConfig)) return "audioConfig is required";
  return null;
}

function extractGoogleErrorMessage(payload, bodyText) {
  if (typeof payload?.error === "string") return payload.error;
  if (typeof payload?.error?.message === "string") return payload.error.message;
  if (typeof payload?.message === "string") return payload.message;
  return bodyText.slice(0, 500) || "Google TTS request failed";
}

function inferGoogleStatus(payload, fallbackStatus) {
  const code = payload?.error?.code;
  if (typeof code === "number" && code >= 400 && code <= 599) return code;
  return fallbackStatus >= 400 ? fallbackStatus : 502;
}

async function synthesizeGoogleTts(body) {
  const timeoutMs = resolveTimeoutMs(body);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch(
      `https://texttospeech.googleapis.com/${body.apiVersion}/text:synthesize?key=${process.env.GOOGLE_TTS_API_KEY}`,
      {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          input: { text: body.text },
          voice: { languageCode: body.languageCode, name: body.voiceName },
          audioConfig: body.audioConfig,
        }),
      },
    );

    const elapsedMs = Date.now() - startedAt;
    const bodyText = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      throw new GoogleTtsError(`Google TTS returned non-JSON response: ${bodyText.slice(0, 500)}`, {
        status: response.ok ? 502 : response.status,
        body: bodyText.slice(0, 1000),
        elapsedMs,
      });
    }

    if (!response.ok || payload?.error) {
      throw new GoogleTtsError(extractGoogleErrorMessage(payload, bodyText), {
        status: inferGoogleStatus(payload, response.status),
        body: bodyText.slice(0, 1000),
        elapsedMs,
      });
    }

    if (typeof payload?.audioContent !== "string" || !payload.audioContent.trim()) {
      throw new GoogleTtsError("Google TTS response did not include audio content", {
        status: 502,
        body: bodyText.slice(0, 1000),
        elapsedMs,
      });
    }

    return {
      audioBase64: payload.audioContent,
      elapsedMs,
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new GoogleTtsError(`Google TTS timeout after ${timeoutMs}ms`, {
        status: 504,
        elapsedMs: Date.now() - startedAt,
      });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function serializeGoogleTtsError(error) {
  return {
    status: error.status || null,
    elapsedMs: error.elapsedMs || null,
    message: String(error.message || error).slice(0, 500),
  };
}

export async function POST(request) {
  const auth = authorize(request);
  if (!auth.ok) {
    return json({ ok: false, error: auth.error, vercel: vercelContext(request) }, auth.status);
  }

  if (!process.env.GOOGLE_TTS_API_KEY) {
    return json({
      ok: false,
      error: "GOOGLE_TTS_API_KEY is not configured",
      vercel: vercelContext(request),
    }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body", vercel: vercelContext(request) }, 400);
  }

  const bodyError = assertBody(body);
  if (bodyError) {
    return json({ ok: false, error: bodyError, vercel: vercelContext(request) }, 400);
  }

  try {
    const result = await synthesizeGoogleTts(body);
    console.log("[tts-synthesize]", JSON.stringify({
      voiceName: body.voiceName,
      languageCode: body.languageCode,
      apiVersion: body.apiVersion,
      purpose: body.purpose || null,
      textChars: body.text.length,
      elapsedMs: result.elapsedMs,
      ts: Date.now(),
    }));

    return json({
      ok: true,
      provider: "google-tts",
      voiceName: body.voiceName,
      languageCode: body.languageCode,
      apiVersion: body.apiVersion,
      audioBase64: result.audioBase64,
      elapsedMs: result.elapsedMs,
      vercel: vercelContext(request),
    });
  } catch (error) {
    const googleError = error instanceof GoogleTtsError
      ? error
      : new GoogleTtsError(String(error?.message || error));
    const serialized = serializeGoogleTtsError(googleError);
    return json({
      ok: false,
      provider: "google-tts",
      error: serialized,
      vercel: vercelContext(request),
    }, googleError.status === 504 ? 504 : 502);
  }
}
