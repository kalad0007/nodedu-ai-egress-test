const DEFAULT_TIMEOUT_MS = 60000;
const MAX_TIMEOUT_MS = 120000;

class GoogleTtsError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "GoogleTtsError";
    this.status = options.status || 502;
    this.body = options.body || "";
    this.elapsedMs = options.elapsedMs || null;
    this.fallbackEligible = options.fallbackEligible === true;
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
  const expected = process.env.TTS_EGRESS_SHARED_SECRET || process.env.AI_EGRESS_SHARED_SECRET;
  if (!expected) {
    return { ok: false, status: 500, error: "TTS_EGRESS_SHARED_SECRET or AI_EGRESS_SHARED_SECRET is not configured" };
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

function resolveTtsInput(body) {
  const inputType = body?.inputType === "ssml" ? "ssml" : "text";
  const value = inputType === "ssml" ? body?.ssml : body?.text;
  return {
    inputType,
    value,
    googleInput: inputType === "ssml" ? { ssml: value } : { text: value },
  };
}

function assertSynthesisRequest(body) {
  if (!body || typeof body !== "object") return "Request body must be JSON";
  if (body.inputType !== undefined && body.inputType !== "text" && body.inputType !== "ssml") {
    return "inputType must be text or ssml";
  }
  const input = resolveTtsInput(body);
  if (typeof input.value !== "string" || !input.value.trim()) return `${input.inputType} is required`;
  if (typeof body.voiceName !== "string" || !body.voiceName.trim()) return "voiceName is required";
  if (typeof body.languageCode !== "string" || !body.languageCode.trim()) return "languageCode is required";
  if (body.apiVersion !== "v1" && body.apiVersion !== "v1beta1") return "apiVersion must be v1 or v1beta1";
  if (!isPlainObject(body.audioConfig)) return "audioConfig is required";
  if (body.enableTimePointing !== undefined) {
    if (
      input.inputType !== "ssml"
      || !Array.isArray(body.enableTimePointing)
      || body.enableTimePointing.length !== 1
      || body.enableTimePointing[0] !== "SSML_MARK"
      || body.apiVersion !== "v1beta1"
    ) {
      return "enableTimePointing must be [SSML_MARK] for v1beta1 SSML input";
    }
  }
  return null;
}

function assertBody(body) {
  const primaryError = assertSynthesisRequest(body);
  if (primaryError) return primaryError;
  if (body.fallback !== undefined) {
    if (!isPlainObject(body.fallback)) return "fallback must be an object";
    const fallbackError = assertSynthesisRequest(body.fallback);
    if (fallbackError) return `fallback.${fallbackError}`;
  }
  return null;
}

function parseTimepoints(payload) {
  if (!Array.isArray(payload?.timepoints)) return [];
  return payload.timepoints.flatMap((timepoint) => {
    const markName = typeof timepoint?.markName === "string" ? timepoint.markName.trim() : "";
    const timeSeconds = Number(timepoint?.timeSeconds);
    return markName && Number.isFinite(timeSeconds) && timeSeconds >= 0
      ? [{ markName, timeSeconds }]
      : [];
  });
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

function isFallbackEligibleProviderError(status, message) {
  if (status !== 400 && status !== 404) return false;
  return /(?:voice[^.]{0,120}(?:unavailable|not available|not found|does not exist|unsupported|incompatible|invalid)|(?:unavailable|not available|not found|does not exist|unsupported|incompatible|invalid)[^.]{0,120}voice)/i.test(message);
}

function createAbortError(signal) {
  const timedOut = signal.reason?.name === "TimeoutError";
  return new GoogleTtsError(timedOut ? "Google TTS request timeout" : "Google TTS request cancelled", {
    status: timedOut ? 504 : 499,
  });
}

async function synthesizeGoogleTts(body, signal) {
  const input = resolveTtsInput(body);
  const startedAt = Date.now();

  try {
    if (signal.aborted) throw createAbortError(signal);
    const response = await fetch(
      `https://texttospeech.googleapis.com/${body.apiVersion}/text:synthesize?key=${process.env.GOOGLE_TTS_API_KEY}`,
      {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          input: input.googleInput,
          voice: { languageCode: body.languageCode, name: body.voiceName },
          audioConfig: body.audioConfig,
          ...(body.enableTimePointing ? { enableTimePointing: body.enableTimePointing } : {}),
        }),
      },
    );

    const elapsedMs = Date.now() - startedAt;
    const bodyText = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      const status = response.ok ? 502 : response.status;
      const message = `Google TTS returned non-JSON response: ${bodyText.slice(0, 500)}`;
      throw new GoogleTtsError(`Google TTS returned non-JSON response: ${bodyText.slice(0, 500)}`, {
        status,
        body: bodyText.slice(0, 1000),
        elapsedMs,
        fallbackEligible: !response.ok && isFallbackEligibleProviderError(status, message),
      });
    }

    if (!response.ok || payload?.error) {
      const message = extractGoogleErrorMessage(payload, bodyText);
      const status = inferGoogleStatus(payload, response.status);
      throw new GoogleTtsError(message, {
        status,
        body: bodyText.slice(0, 1000),
        elapsedMs,
        fallbackEligible: !response.ok && isFallbackEligibleProviderError(status, message),
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
      timepoints: parseTimepoints(payload),
      elapsedMs,
    };
  } catch (error) {
    if (signal.aborted) {
      const abortError = createAbortError(signal);
      abortError.elapsedMs = Date.now() - startedAt;
      throw abortError;
    }
    throw error;
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

  const timeoutMs = resolveTimeoutMs(body);
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(new DOMException("Caller cancelled", "AbortError"));
  if (request.signal.aborted) abortFromCaller();
  else request.signal.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new DOMException(`Google TTS timeout after ${timeoutMs}ms`, "TimeoutError")),
    timeoutMs,
  );

  try {
    let synthesisBody = body;
    let fallbackUsed = false;
    let result;
    try {
      result = await synthesizeGoogleTts(body, controller.signal);
    } catch (primaryError) {
      if (
        !(primaryError instanceof GoogleTtsError)
        || !primaryError.fallbackEligible
        || !body.fallback
        || controller.signal.aborted
      ) throw primaryError;
      synthesisBody = body.fallback;
      fallbackUsed = true;
      result = await synthesizeGoogleTts(synthesisBody, controller.signal);
    }
    const input = resolveTtsInput(synthesisBody);
    console.log("[tts-synthesize]", JSON.stringify({
      voiceName: synthesisBody.voiceName,
      languageCode: synthesisBody.languageCode,
      apiVersion: synthesisBody.apiVersion,
      purpose: body.purpose || null,
      inputType: input.inputType,
      inputChars: input.value.length,
      timepointCount: result.timepoints.length,
      fallbackUsed,
      elapsedMs: result.elapsedMs,
      ts: Date.now(),
    }));

    return json({
      ok: true,
      provider: "google-tts",
      voiceName: synthesisBody.voiceName,
      languageCode: synthesisBody.languageCode,
      apiVersion: synthesisBody.apiVersion,
      inputType: input.inputType,
      audioBase64: result.audioBase64,
      timepoints: result.timepoints,
      fallbackUsed,
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
    }, googleError.status === 499 || googleError.status === 504 ? googleError.status : 502);
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", abortFromCaller);
  }
}
