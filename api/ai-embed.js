const GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODEL = "gemini-embedding-001";
const DEFAULT_OUTPUT_DIMENSIONALITY = 768;
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 120000;
const MAX_TEXT_CHARS = 100000;

class GeminiEmbeddingError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "GeminiEmbeddingError";
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

function assertBody(body) {
  if (!body || typeof body !== "object") return "Request body must be JSON";
  if (typeof body.text !== "string" || !body.text.trim()) return "text is required";
  if (body.text.length > MAX_TEXT_CHARS) return `text must be at most ${MAX_TEXT_CHARS} characters`;
  if (
    body.outputDimensionality !== undefined &&
    Number(body.outputDimensionality) !== DEFAULT_OUTPUT_DIMENSIONALITY
  ) {
    return `outputDimensionality must be ${DEFAULT_OUTPUT_DIMENSIONALITY}`;
  }
  return null;
}

function resolveModel() {
  const configured = String(process.env.GEMINI_EMBEDDING_MODEL || "").trim();
  return configured || DEFAULT_MODEL;
}

function extractGoogleErrorMessage(payload, bodyText) {
  if (typeof payload?.error === "string") return payload.error;
  if (typeof payload?.error?.message === "string") return payload.error.message;
  if (typeof payload?.message === "string") return payload.message;
  return bodyText.slice(0, 500) || "Gemini embedding request failed";
}

function inferGoogleStatus(payload, fallbackStatus) {
  const code = payload?.error?.code;
  if (typeof code === "number" && code >= 400 && code <= 599) return code;
  return fallbackStatus >= 400 ? fallbackStatus : 502;
}

async function generateGeminiEmbedding(body) {
  const model = resolveModel();
  const timeoutMs = resolveTimeoutMs(body);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch(
      `${GEMINI_API_BASE_URL}/${encodeURIComponent(model)}:embedContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,
      {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: { parts: [{ text: body.text }] },
          output_dimensionality: DEFAULT_OUTPUT_DIMENSIONALITY,
        }),
      },
    );

    const elapsedMs = Date.now() - startedAt;
    const bodyText = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      throw new GeminiEmbeddingError(`Gemini returned non-JSON response: ${bodyText.slice(0, 500)}`, {
        status: response.ok ? 502 : response.status,
        body: bodyText.slice(0, 1000),
        elapsedMs,
      });
    }

    if (!response.ok || payload?.error) {
      throw new GeminiEmbeddingError(extractGoogleErrorMessage(payload, bodyText), {
        status: inferGoogleStatus(payload, response.status),
        body: bodyText.slice(0, 1000),
        elapsedMs,
      });
    }

    const values = payload?.embedding?.values;
    if (
      !Array.isArray(values) ||
      values.length !== DEFAULT_OUTPUT_DIMENSIONALITY ||
      values.some((value) => typeof value !== "number" || !Number.isFinite(value))
    ) {
      throw new GeminiEmbeddingError(
        `Gemini response did not include a valid ${DEFAULT_OUTPUT_DIMENSIONALITY}-dimension embedding`,
        { status: 502, body: bodyText.slice(0, 1000), elapsedMs },
      );
    }

    return { model, values, elapsedMs };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new GeminiEmbeddingError(`Gemini embedding timeout after ${timeoutMs}ms`, {
        status: 504,
        elapsedMs: Date.now() - startedAt,
      });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function serializeGeminiError(error) {
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

  if (!process.env.GEMINI_API_KEY) {
    return json({
      ok: false,
      error: "GEMINI_API_KEY is not configured",
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
    const result = await generateGeminiEmbedding(body);
    console.log("[ai-embed]", JSON.stringify({
      provider: "google-gemini",
      model: result.model,
      purpose: body.purpose || null,
      textChars: body.text.length,
      dimensions: result.values.length,
      elapsedMs: result.elapsedMs,
      ts: Date.now(),
    }));

    return json({
      ok: true,
      provider: "google-gemini",
      model: result.model,
      embedding: result.values,
      dimensions: result.values.length,
      elapsedMs: result.elapsedMs,
      vercel: vercelContext(request),
    });
  } catch (error) {
    const geminiError = error instanceof GeminiEmbeddingError
      ? error
      : new GeminiEmbeddingError(String(error?.message || error));
    return json({
      ok: false,
      provider: "google-gemini",
      model: resolveModel(),
      error: serializeGeminiError(geminiError),
      vercel: vercelContext(request),
    }, geminiError.status === 504 ? 504 : geminiError.status >= 400 && geminiError.status < 500 ? geminiError.status : 502);
  }
}
