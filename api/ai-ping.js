const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODELS = ["openai/gpt-5.4", "openai/gpt-5.5"];

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function parseModels(requestUrl) {
  const url = new URL(requestUrl);
  const raw =
    url.searchParams.get("models") ||
    process.env.PING_MODELS ||
    DEFAULT_MODELS.join(",");

  return raw
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
}

function parseTimeoutMs(requestUrl) {
  const url = new URL(requestUrl);
  const value = Number(url.searchParams.get("timeoutMs") || "12000");

  if (!Number.isFinite(value)) return 12000;
  return Math.min(Math.max(value, 1000), 30000);
}

async function pingModel(model, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch(OPENROUTER_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "content-type": "application/json",
        "http-referer": "https://nodedu.net",
        "x-title": "nodedu-ai-egress-test",
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: "Reply with exactly: pong",
          },
        ],
        temperature: 0,
        max_tokens: 16,
      }),
    });

    const elapsedMs = Date.now() - startedAt;

    if (!response.ok) {
      const errorText = await response.text();
      return {
        model,
        ok: false,
        status: response.status,
        elapsedMs,
        error: errorText.slice(0, 500),
      };
    }

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content?.trim() || "";

    return {
      model,
      ok: /pong/i.test(text),
      text,
      elapsedMs,
    };
  } catch (error) {
    return {
      model,
      ok: false,
      elapsedMs: Date.now() - startedAt,
      error: error?.name === "AbortError" ? "timeout" : String(error?.message || error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function GET(request) {
  if (!process.env.OPENROUTER_API_KEY) {
    return json(
      {
        ok: false,
        error: "OPENROUTER_API_KEY is not configured",
      },
      500,
    );
  }

  const timeoutMs = parseTimeoutMs(request.url);
  const models = parseModels(request.url);
  const results = [];

  for (const model of models) {
    results.push(await pingModel(model, timeoutMs));
  }

  return json({
    ok: results.every((result) => result.ok),
    timeoutMs,
    provider: "openrouter",
    vercel: {
      region: process.env.VERCEL_REGION || null,
      id: request.headers.get("x-vercel-id"),
      country: request.headers.get("x-vercel-ip-country"),
      city: request.headers.get("x-vercel-ip-city"),
    },
    results,
  });
}
