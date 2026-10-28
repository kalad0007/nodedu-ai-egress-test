import { applySolServiceTier, normalizeGptReasoning, readServiceTierMetadata } from "../lib/sol-service-tier.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_PROVIDER = "openrouter";
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_MAX_TOKENS = 16000;
const REQUEST_CONTEXT_LIMITS = {
  purpose: 120,
  teacherId: 128,
  runId: 80,
  idempotencyKey: 160,
};

class ProviderCallError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ProviderCallError";
    this.status = options.status || 502;
    this.provider = options.provider || null;
    this.model = options.model || null;
    this.elapsedMs = options.elapsedMs ?? null;
    this.outcome = options.outcome || "error";
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

function normalizeOpenAiModelName(model) {
  return String(model || "").trim().replace(/^openai\//, "");
}

function resolveModel(body, provider, explicitModel) {
  const requested = String(explicitModel ?? body.model ?? "").trim();
  if (provider === "openai") {
    return normalizeOpenAiModelName(requested || process.env.OPENAI_MODEL || "gpt-6.1-sol");
  }

  return requested || process.env.OPENROUTER_MODEL || "openai/gpt-6.1-sol";
}

function positiveInteger(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function normalizeRequestContextValue(value, maxLength) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function createRequestContext(body) {
  return Object.fromEntries(
    Object.entries(REQUEST_CONTEXT_LIMITS).map(([field, maxLength]) => [
      field,
      normalizeRequestContextValue(body[field], maxLength),
    ]),
  );
}

function resolveTimeoutMs(body) {
  return positiveInteger(body.timeoutMs, DEFAULT_TIMEOUT_MS);
}

function resolveMaxTokens(value, fallback = DEFAULT_MAX_TOKENS) {
  return positiveInteger(value, fallback);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return "messages must be a non-empty array";
  for (const message of messages) {
    if (!isRecord(message) || !["system", "user", "assistant"].includes(message.role)) {
      return "messages contains an invalid role";
    }
    if (typeof message.content !== "string" && !Array.isArray(message.content)) {
      return "messages contains invalid content";
    }
  }
  return null;
}

function assertBody(body) {
  if (!isRecord(body)) return "Request body must be JSON";
  const hasCustomMessages = Array.isArray(body.messages) && body.messages.length > 0;
  if (!hasCustomMessages && (typeof body.system !== "string" || !body.system.trim())) return "system is required";
  if (!hasCustomMessages && (typeof body.prompt !== "string" || !body.prompt.trim())) return "prompt is required";
  if (body.aiProvider !== undefined && !normalizeProvider(body.aiProvider)) {
    return "aiProvider must be openrouter or openai";
  }
  if (body.messages !== undefined) {
    const messagesError = validateMessages(body.messages);
    if (messagesError) return messagesError;
  }
  if (body.plugins !== undefined && (!Array.isArray(body.plugins) || body.plugins.some((plugin) => !isRecord(plugin)))) {
    return "plugins must be an array of records";
  }
  if (resolveMaxTokens(body.maxTokens) === null) return "maxTokens must be a positive safe integer";
  if (resolveTimeoutMs(body) === null) return "timeoutMs must be a positive safe integer";

  if (body.fallback !== undefined) {
    if (!isRecord(body.fallback)) return "fallback must be one provider configuration";
    if (!normalizeProvider(body.fallback.aiProvider)) return "fallback.aiProvider must be openrouter or openai";
    if (typeof body.fallback.model !== "string" || !body.fallback.model.trim()) return "fallback.model is required";
    if (body.fallback.maxTokens !== undefined && resolveMaxTokens(body.fallback.maxTokens) === null) {
      return "fallback.maxTokens must be a positive safe integer";
    }
    if (body.fallback.on !== undefined
      && !["access_error", "retryable_error", "access_or_retryable_error"].includes(body.fallback.on)) {
      return "fallback.on must be access_error, retryable_error, or access_or_retryable_error";
    }
    if (body.fallback.provider !== undefined && !isRecord(body.fallback.provider)) {
      return "fallback.provider must be a record";
    }
    if (body.fallback.reasoning !== undefined && !isRecord(body.fallback.reasoning)) {
      return "fallback.reasoning must be a record";
    }
  }

  const primaryProvider = resolvePrimaryProvider(body);
  const primaryCompatibilityError = providerCompatibilityError(body, primaryProvider);
  if (primaryCompatibilityError) return `Primary provider is incompatible with this request: ${primaryCompatibilityError}`;

  if (body.fallback) {
    const fallbackProvider = normalizeProvider(body.fallback.aiProvider);
    const fallbackCompatibilityError = providerCompatibilityError(body, fallbackProvider);
    if (fallbackCompatibilityError) return `Fallback provider is incompatible with this request: ${fallbackCompatibilityError}`;
  }

  return null;
}

function resolvePrimaryProvider(body) {
  return normalizeProvider(body.aiProvider)
    || normalizeProvider(process.env.AI_EGRESS_PRIMARY_PROVIDER)
    || DEFAULT_PROVIDER;
}

function providerCompatibilityError(body, provider) {
  if (provider !== "openai") return null;
  if (Array.isArray(body.plugins) && body.plugins.length > 0) return "OpenAI chat completions do not support OpenRouter plugins";
  return null;
}

function resolveMessages(body) {
  if (Array.isArray(body.messages) && body.messages.length > 0) return body.messages;
  return [
    { role: "system", content: body.system },
    { role: "user", content: body.prompt },
  ];
}

function buildOpenRouterRequest(body, model, maxTokens, reasoning, routing) {
  const providerRequest = {
    model,
    max_tokens: maxTokens,
    messages: resolveMessages(body),
  };

  if (body.responseFormat === "json_object") {
    providerRequest.response_format = { type: "json_object" };
  }
  if (isRecord(reasoning)) providerRequest.reasoning = reasoning;
  if (isRecord(routing)) providerRequest.provider = routing;
  if (Array.isArray(body.plugins) && body.plugins.length > 0) providerRequest.plugins = body.plugins;

  return providerRequest;
}

function buildOpenAiRequest(body, model, maxTokens, reasoning) {
  const providerRequest = {
    model,
    max_completion_tokens: maxTokens,
    messages: resolveMessages(body),
  };

  if (body.responseFormat === "json_object") {
    providerRequest.response_format = { type: "json_object" };
  }
  if (isRecord(reasoning) && typeof reasoning.effort === "string") {
    providerRequest.reasoning_effort = reasoning.effort;
  }
  if (applySolServiceTier("openai", model).serviceTier === "flex") {
    providerRequest.service_tier = "flex";
  }

  return providerRequest;
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

function readFinishMetadata(payload) {
  const choice = payload?.choices?.[0];
  const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : null;
  const nativeFinishReason = typeof choice?.native_finish_reason === "string" ? choice.native_finish_reason : null;
  const truncatedReasons = new Set(["length", "max_tokens"]);
  const truncated = truncatedReasons.has(finishReason) || truncatedReasons.has(nativeFinishReason);
  const incomplete = truncated
    || finishReason === "content_filter"
    || payload?.status === "incomplete"
    || isRecord(payload?.incomplete_details);
  return { finishReason, nativeFinishReason, truncated, incomplete };
}

function createRequestAbortContext(timeoutMs, callerSignal) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => {
    controller.abort(callerSignal?.reason || new DOMException("Caller cancelled", "AbortError"));
  };

  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("Total request timeout", "TimeoutError"));
  }, timeoutMs);

  return {
    signal: controller.signal,
    wasTimedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    },
  };
}

async function postProvider({ provider, model, maxTokens, reasoning, routing, body, abortContext }) {
  const startedAt = Date.now();
  const isOpenAi = provider === "openai";
  const url = isOpenAi ? OPENAI_URL : OPENROUTER_URL;
  const apiKey = isOpenAi ? process.env.OPENAI_API_KEY : process.env.OPENROUTER_API_KEY;
  const requestBody = isOpenAi
    ? buildOpenAiRequest(body, model, maxTokens, reasoning)
    : buildOpenRouterRequest(body, model, maxTokens, reasoning, routing);

  try {
    const response = await fetch(url, {
      method: "POST",
      signal: abortContext.signal,
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
        elapsedMs,
        outcome: response.ok ? "ambiguous" : "error",
      });
    }

    if (!response.ok) {
      throw new ProviderCallError(extractProviderErrorMessage(payload, bodyText), {
        status: response.status,
        provider,
        model,
        elapsedMs,
      });
    }

    if (payload?.error) {
      throw new ProviderCallError(extractProviderErrorMessage(payload, bodyText), {
        status: inferEmbeddedErrorStatus(payload),
        provider,
        model,
        elapsedMs,
      });
    }

    const text = extractText(payload);
    if (!text.trim()) {
      throw new ProviderCallError("Provider response did not include generated text", {
        status: 502,
        provider,
        model,
        elapsedMs,
        outcome: "ambiguous",
      });
    }

    return {
      provider,
      model,
      text,
      elapsedMs,
      ...readServiceTierMetadata(payload),
      providerGenerationId: typeof payload?.id === "string" && payload.id.trim() ? payload.id : null,
      ...readFinishMetadata(payload),
    };
  } catch (error) {
    if (abortContext.signal.aborted) {
      const outcome = abortContext.wasTimedOut() ? "timeout" : "cancelled";
      const status = outcome === "timeout" ? 504 : 499;
      const message = outcome === "timeout" ? "Total AI request budget exhausted" : "AI request cancelled by caller";
      throw new ProviderCallError(message, {
        status,
        provider,
        model,
        elapsedMs: Date.now() - startedAt,
        outcome,
      });
    }
    if (error instanceof ProviderCallError) throw error;
    throw new ProviderCallError(String(error?.message || error), {
      status: 502,
      provider,
      model,
      elapsedMs: Date.now() - startedAt,
      outcome: "ambiguous",
    });
  }
}

function serializeProviderAttempt(error) {
  return {
    provider: error.provider || null,
    model: error.model || null,
    status: error.status || null,
    outcome: error.outcome || "error",
    elapsedMs: error.elapsedMs ?? null,
    message: String(error.message || error).slice(0, 500),
  };
}

function serializeSuccessAttempt(result) {
  return {
    provider: result.provider,
    model: result.model,
    status: 200,
    outcome: "success",
    elapsedMs: result.elapsedMs,
    providerGenerationId: result.providerGenerationId,
    finishReason: result.finishReason,
    serviceTier: result.serviceTier,
  };
}

function shouldUseFallback(error, fallback) {
  if (!fallback || !["error", "unavailable"].includes(error.outcome)) return false;
  const condition = fallback.on || "access_error";
  if (condition === "access_error") return error.status === 401 || error.status === 403;
  const retryable = error.outcome === "unavailable"
    || error.status === 429
    || (error.status >= 500 && error.status <= 599 && error.status !== 504);
  return condition === "access_or_retryable_error"
    ? error.status === 401 || error.status === 403 || retryable
    : retryable;
}

function responseStatusForProviderError(error) {
  return Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 502;
}

function attemptConfig(body, fallback = false) {
  const config = fallback ? body.fallback : null;
  const provider = fallback ? normalizeProvider(config.aiProvider) : resolvePrimaryProvider(body);
  const primaryMaxTokens = resolveMaxTokens(body.maxTokens);
  const reasoning = fallback && config.reasoning !== undefined ? config.reasoning : body.reasoning;
  const routing = fallback && config.provider !== undefined ? config.provider : body.provider;
  const solConfig = applySolServiceTier(
    provider, resolveModel(body, provider, fallback ? config.model : body.model), routing,
  );
  return {
    provider,
    model: solConfig.model,
    maxTokens: fallback ? resolveMaxTokens(config.maxTokens, primaryMaxTokens) : primaryMaxTokens,
    reasoning: normalizeGptReasoning(solConfig.model, reasoning),
    routing: solConfig.routing,
  };
}

function unavailableProviderError(config) {
  return new ProviderCallError(`The ${config.provider} provider API key is not configured`, {
    status: 503,
    provider: config.provider,
    model: config.model,
    elapsedMs: 0,
    outcome: "unavailable",
  });
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

  const requestContext = createRequestContext(body);
  const primary = attemptConfig(body);
  const fallback = body.fallback ? attemptConfig(body, true) : null;
  const abortContext = createRequestAbortContext(resolveTimeoutMs(body), request.signal);
  const requestStartedAt = Date.now();
  const providerAttempts = [];
  let lastError = null;

  try {
    for (const config of [primary, fallback]) {
      if (!config) break;
      if (config === fallback && !shouldUseFallback(lastError, body.fallback)) break;
      if (abortContext.signal.aborted) {
        const outcome = abortContext.wasTimedOut() ? "timeout" : "cancelled";
        lastError = new ProviderCallError(
          outcome === "timeout" ? "Total AI request budget exhausted" : "AI request cancelled by caller",
          { status: outcome === "timeout" ? 504 : 499, ...config, elapsedMs: 0, outcome },
        );
        providerAttempts.push(serializeProviderAttempt(lastError));
        break;
      }

      try {
        if (!hasProviderKey(config.provider)) throw unavailableProviderError(config);
        const result = await postProvider({ ...config, body, abortContext });
        providerAttempts.push(serializeSuccessAttempt(result));
        console.log("[ai-generate]", JSON.stringify({
          provider: result.provider,
          model: result.model,
          elapsedMs: Date.now() - requestStartedAt,
          attemptCount: providerAttempts.length,
          ts: Date.now(),
        }));

        return json({
          ok: true,
          provider: result.provider,
          model: result.model,
          text: result.text,
          elapsedMs: Date.now() - requestStartedAt,
          usage: result.usage,
          serviceTier: result.serviceTier,
          providerGenerationId: result.providerGenerationId,
          providerAttempts,
          requestContext,
          finishReason: result.finishReason,
          nativeFinishReason: result.nativeFinishReason,
          truncated: result.truncated,
          incomplete: result.incomplete,
          vercel: vercelContext(request),
        });
      } catch (error) {
        lastError = error instanceof ProviderCallError
          ? error
          : new ProviderCallError(String(error?.message || error), config);
        providerAttempts.push(serializeProviderAttempt(lastError));
      }
    }
  } finally {
    abortContext.cleanup();
  }

  lastError ||= new ProviderCallError("Provider request failed", primary);
  return json({
    ok: false,
    provider: lastError.provider,
    model: lastError.model,
    providerGenerationId: null,
    providerAttempts,
    requestContext,
    error: {
      message: String(lastError.message || lastError).slice(0, 500),
      status: lastError.status || null,
    },
    vercel: vercelContext(request),
  }, responseStatusForProviderError(lastError));
}
