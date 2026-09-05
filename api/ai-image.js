const OPENROUTER_IMAGE_URL = "https://openrouter.ai/api/v1/images";
const DEFAULT_MODEL = "google/gemini-3.1-flash-image";
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_PROMPT_CHARS = 20000;

class ImageProviderError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ImageProviderError";
    this.status = options.status || 502;
    this.body = options.body || "";
    this.elapsedMs = options.elapsedMs || null;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
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

function resolveModel() {
  return String(process.env.OPENROUTER_BLOG_IMAGE_MODEL || "").trim() || DEFAULT_MODEL;
}

function assertBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "Request body must be JSON";
  if (typeof body.prompt !== "string" || !body.prompt.trim()) return "prompt is required";
  if (body.prompt.length > MAX_PROMPT_CHARS) return `prompt must be at most ${MAX_PROMPT_CHARS} characters`;
  if (body.model !== undefined && body.model !== resolveModel()) return "model is not allowed";
  if (body.n !== undefined && body.n !== 1) return "n must be 1";
  if (body.resolution !== undefined && body.resolution !== "1K") return "resolution must be 1K";
  if (body.aspectRatio !== undefined && body.aspectRatio !== "16:9") return "aspectRatio must be 16:9";
  return null;
}

function extractProviderErrorMessage(payload, bodyText) {
  if (typeof payload?.error === "string") return payload.error;
  if (typeof payload?.error?.message === "string") return payload.error.message;
  if (typeof payload?.message === "string") return payload.message;
  return bodyText.slice(0, 500) || "OpenRouter image request failed";
}

function inferProviderStatus(payload, fallbackStatus) {
  const code = payload?.error?.code;
  if (typeof code === "number" && code >= 400 && code <= 599) return code;
  if (typeof code === "string") {
    const parsed = Number(code);
    if (Number.isInteger(parsed) && parsed >= 400 && parsed <= 599) return parsed;
  }
  return fallbackStatus >= 400 ? fallbackStatus : 502;
}

async function generateImage(body) {
  const model = resolveModel();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const response = await fetch(OPENROUTER_IMAGE_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "content-type": "application/json",
        "http-referer": process.env.OPENROUTER_SITE_URL || "https://nodedu.net",
        "x-title": process.env.OPENROUTER_APP_NAME || "nodedu-ai-egress",
      },
      body: JSON.stringify({
        model,
        prompt: body.prompt,
        n: 1,
        resolution: "1K",
        aspect_ratio: "16:9",
      }),
    });

    const elapsedMs = Date.now() - startedAt;
    const bodyText = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      throw new ImageProviderError(`OpenRouter returned non-JSON response: ${bodyText.slice(0, 500)}`, {
        status: response.ok ? 502 : response.status,
        body: bodyText.slice(0, 1000),
        elapsedMs,
      });
    }

    if (!response.ok || payload?.error) {
      throw new ImageProviderError(extractProviderErrorMessage(payload, bodyText), {
        status: inferProviderStatus(payload, response.status),
        body: bodyText.slice(0, 1000),
        elapsedMs,
      });
    }

    const image = Array.isArray(payload?.data) ? payload.data[0] : null;
    if (typeof image?.b64_json !== "string" || !image.b64_json.trim()) {
      throw new ImageProviderError("OpenRouter response did not include image data", {
        status: 502,
        body: bodyText.slice(0, 1000),
        elapsedMs,
      });
    }

    return {
      model,
      base64: image.b64_json,
      mimeType: typeof image.media_type === "string" ? image.media_type : "image/png",
      usage: payload.usage || null,
      elapsedMs,
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new ImageProviderError(`OpenRouter image timeout after ${DEFAULT_TIMEOUT_MS}ms`, {
        status: 504,
        elapsedMs: Date.now() - startedAt,
      });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function serializeProviderError(error) {
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

  if (!process.env.OPENROUTER_API_KEY) {
    return json({
      ok: false,
      error: "OPENROUTER_API_KEY is not configured",
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
    const result = await generateImage(body);
    console.log("[ai-image]", JSON.stringify({
      provider: "openrouter",
      model: result.model,
      purpose: body.purpose || null,
      elapsedMs: result.elapsedMs,
      ts: Date.now(),
    }));

    return json({
      ok: true,
      provider: "openrouter",
      model: result.model,
      base64: result.base64,
      mimeType: result.mimeType,
      usage: result.usage,
      elapsedMs: result.elapsedMs,
      vercel: vercelContext(request),
    });
  } catch (error) {
    const providerError = error instanceof ImageProviderError
      ? error
      : new ImageProviderError(String(error?.message || error));
    return json({
      ok: false,
      provider: "openrouter",
      model: resolveModel(),
      error: serializeProviderError(providerError),
      vercel: vercelContext(request),
    }, providerError.status === 504 ? 504 : providerError.status >= 400 && providerError.status < 500 ? providerError.status : 502);
  }
}
