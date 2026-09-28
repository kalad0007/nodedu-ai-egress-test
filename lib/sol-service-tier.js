// Only price/speed routing variants may be replaced; preserve other suffix semantics.
function solBaseModel(model) {
  return String(model || "").trim().match(
    /^(?:openai\/)?(gpt-6-sol(?:-(?:\d{8}|\d{4}-\d{2}-\d{2}))?)(?::(?:floor|nitro))?$/i,
  )?.[1]?.toLowerCase() || null;
}

export function isSolModel(model) {
  return solBaseModel(model) !== null;
}

export function applySolServiceTier(provider, model, routing) {
  const base = solBaseModel(model);
  if (!base) return { model, routing };
  if (provider === "openai") return { model: base, routing, serviceTier: "flex" };
  if (provider !== "openrouter") return { model, routing };

  // Explicit order takes precedence over :floor; retain eligibility constraints.
  const nextRouting = routing && typeof routing === "object" && !Array.isArray(routing)
    ? { ...routing } : {};
  delete nextRouting.order;
  nextRouting.sort = "price";
  return { model: `openai/${base}:floor`, routing: nextRouting };
}

export function readServiceTierMetadata(payload) {
  const tier = [payload?.service_tier, payload?.usage?.service_tier]
    .find(value => typeof value === "string" && value.trim());
  const serviceTier = tier?.trim() || null;
  const usage = payload?.usage || null;
  return {
    serviceTier,
    usage: serviceTier ? { ...usage, service_tier: serviceTier } : usage,
  };
}
