const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_PROVIDER = "openrouter";
const DEFAULT_TIMEOUT_MS = 60000;
const MAX_TIMEOUT_MS = 120000;
const MIN_MAX_TOKENS = 16;
const MAX_MAX_TOKENS = 20000;

class ProviderCallError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ProviderCallError";
    this.status = options.status || 502;
    this.provider = options.provider || null;
    this.model = options.model || null;
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

function normalizeProvider(value) {
  const provider = String(value || "").trim().toLowerCase();
  return provider === "openrouter" || provider === "openai" ? provider : null;
}

function hasProviderKey(provider) {
  if (provider === "openrouter") return !!process.env.OPENROUTER_API_KEY;
  if (provider === "openai") return !!process.env.OPENAI_API_KEY;
  return false;
}

function resolveProviderOrder(body) {
  const primary =
    normalizeProvider(process.env.AI_EGRESS_PRIMARY_PROVIDER) ||
    normalizeProvider(body.aiProvider) ||
    DEFAULT_PROVIDER;
  const allowFallback = String(process.env.AI_EGRESS_ALLOW_PROVIDER_FALLBACK || "true").toLowerCase() !== "false";
  const candidates = [primary];

  if (allowFallback) {
    if (primary !== "openai") candidates.push("openai");
    if (primary !== "openrouter") candidates.push("openrouter");
  }

  return [...new Set(candidates)].filter(hasProviderKey);
}

function normalizeOpenAiModelName(model) {
  return String(model || "").trim().replace(/^openai\//, "");
}

function resolveModel(body, provider) {
  const requested = String(body.model || "").trim();
  if (provider === "openai") {
    return normalizeOpenAiModelName(requested || process.env.OPENAI_MODEL || "gpt-5.4");
  }

  return requested || process.env.OPENROUTER_MODEL || "openai/gpt-5.4";
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function resolveTimeoutMs(body) {
  return clampInteger(body.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, MAX_TIMEOUT_MS);
}

function resolveMaxTokens(body) {
  return clampInteger(body.maxTokens, 16000, MIN_MAX_TOKENS, MAX_MAX_TOKENS);
}

function assertBody(body) {
  if (!body || typeof body !== "object") return "Request body must be JSON";
  if (typeof body.system !== "string" || !body.system.trim()) return "system is required";
  if (typeof body.prompt !== "string" || !body.prompt.trim()) return "prompt is required";
  return null;
}

function buildOpenRouterRequest(body, model) {
  const request = {
    model,
    max_tokens: resolveMaxTokens(body),
    messages: [
      { role: "system", content: body.system },
      { role: "user", content: body.prompt },
    ],
  };

  if (body.responseFormat === "json_object") {
    request.response_format = { type: "json_object" };
  }

  if (body.provider && typeof body.provider === "object" && !Array.isArray(body.provider)) {
    request.provider = body.provider;
  }

  return request;
}

function buildOpenAiRequest(body, model) {
  const request = {
    model,
    max_completion_tokens: resolveMaxTokens(body),
    messages: [
      { role: "system", content: body.system },
      { role: "user", content: body.prompt },
    ],
  };

  if (body.responseFormat === "json_object") {
    request.response_format = { type: "json_object" };
  }

  return request;
}

function extractText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n");
  }

  return "";
}

function extractProviderErrorMessage(payload, bodyText) {
  if (typeof payload?.error === "string") return payload.error;
  if (typeof payload?.error?.message === "string") return payload.error.message;
  if (typeof payload?.message === "string") return payload.message;
  return bodyText.slice(0, 500) || "Provider request failed";
}

function inferEmbeddedErrorStatus(payload) {
  const code = payload?.error?.code;
  if (typeof code === "number" && code >= 400 && code <= 599) return code;
  if (typeof code === "string") {
    const parsed = Number(code);
    if (Number.isInteger(parsed) && parsed >= 400 && parsed <= 599) return parsed;
  }

  const message = String(payload?.error?.message || "").toLowerCase();
  if (message.includes("rate limit") || message.includes("too many requests")) return 429;
  if (message.includes("region") || message.includes("access") || message.includes("not allowed")) return 403;
  return 502;
}

async function postProvider(provider, body) {
  const model = resolveModel(body, provider);
  const timeoutMs = resolveTimeoutMs(body);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  const isOpenAi = provider === "openai";
  const url = isOpenAi ? OPENAI_URL : OPENROUTER_URL;
  const apiKey = isOpenAi ? process.env.OPENAI_API_KEY : process.env.OPENROUTER_API_KEY;
  const requestBody = isOpenAi ? buildOpenAiRequest(body, model) : buildOpenRouterRequest(body, model);

  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        ...(isOpenAi
          ? {}
          : {
              "http-referer": process.env.OPENROUTER_SITE_URL || "https://nodedu.net",
              "x-title": process.env.OPENROUTER_APP_NAME || "nodedu-ai-egress",
            }),
      },
      body: JSON.stringify(requestBody),
    });

    const elapsedMs = Date.now() - startedAt;
    const bodyText = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      throw new ProviderCallError(`Provider returned non-JSON response: ${bodyText.slice(0, 500)}`, {
        status: response.ok ? 502 : response.status,
        provider,
        model,
        body: bodyText.slice(0, 1000),
        elapsedMs,
      });
    }

    if (!response.ok) {
      throw new ProviderCallError(extractProviderErrorMessage(payload, bodyText), {
        status: response.status,
        provider,
        model,
        body: bodyText.slice(0, 1000),
        elapsedMs,
      });
    }

    if (payload?.error) {
      throw new ProviderCallError(extractProviderErrorMessage(payload, bodyText), {
        status: inferEmbeddedErrorStatus(payload),
        provider,
        model,
        body: bodyText.slice(0, 1000),
        elapsedMs,
      });
    }

    const text = extractText(payload);
    if (!text.trim()) {
      throw new ProviderCallError("Provider response did not include generated text", {
        status: 502,
        provider,
        model,
        body: bodyText.slice(0, 1000),
        elapsedMs,
      });
    }

    return {
      provider,
      model,
      text,
      elapsedMs,
      usage: payload?.usage || null,
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new ProviderCallError(`Provider timeout after ${timeoutMs}ms`, {
        status: 504,
        provider,
        model,
        elapsedMs: Date.now() - startedAt,
      });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function responseStatusForProviderError(error) {
  if (error.status >= 400 && error.status < 500) return error.status;
  if (error.status === 504) return 504;
  return 502;
}

function serializeProviderError(error) {
  return {
    provider: error.provider || null,
    model: error.model || null,
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

  const providers = resolveProviderOrder(body);
  if (providers.length === 0) {
    return json({
      ok: false,
      error: "No egress provider API key is configured",
      vercel: vercelContext(request),
    }, 500);
  }

  const errors = [];
  for (const provider of providers) {
    try {
      const result = await postProvider(provider, body);
      console.log("[ai-generate]", JSON.stringify({
        provider: result.provider,
        model: result.model,
        purpose: body.purpose || null,
        elapsedMs: result.elapsedMs,
        ts: Date.now(),
      }));

      return json({
        ok: true,
        provider: result.provider,
        model: result.model,
        text: result.text,
        elapsedMs: result.elapsedMs,
        usage: result.usage,
        vercel: vercelContext(request),
      });
    } catch (error) {
      const providerError = error instanceof ProviderCallError
        ? error
        : new ProviderCallError(String(error?.message || error), { provider });
      errors.push(serializeProviderError(providerError));
    }
  }

  const lastError = errors[errors.length - 1] || { status: 502, message: "Provider request failed" };
  return json({
    ok: false,
    provider: lastError.provider || null,
    model: lastError.model || null,
    error: {
      message: lastError.message,
      status: lastError.status || null,
      previous_errors: errors,
    },
    vercel: vercelContext(request),
  }, responseStatusForProviderError(lastError));
}
