// Retire known GPT text defaults without changing Luna or custom suffix semantics.
export function migrateLegacyGptModel(model) {
  const value = String(model || "").trim();
  const oldGeneral = value.match(/^(openai\/)?gpt-5\.[45](?:-\d{8}|-\d{4}-\d{2}-\d{2})?(:(?:floor|nitro))?$/i);
  if (oldGeneral) return `${oldGeneral[1] ? 'openai/' : ''}gpt-6.1-sol${oldGeneral[2]?.toLowerCase() ?? ''}`;
  const legacy = value.match(/^(openai\/)?gpt-5\.6-(terra|sol|luna)(?:-\d{8}|-\d{4}-\d{2}-\d{2})?$/i);
  if (legacy) return `${legacy[1] ? 'openai/' : ''}${legacy[2].toLowerCase() === 'luna' ? 'gpt-6-luna' : 'gpt-6.1-sol'}`;
  const sol = value.match(/^(openai\/)?gpt-6-sol(?:-\d{8}|-\d{4}-\d{2}-\d{2})?(:(?:floor|nitro))?$/i);
  return sol ? `${sol[1] ? 'openai/' : ''}gpt-6.1-sol${sol[2]?.toLowerCase() ?? ''}` : value;
}

export function normalizeGptReasoning(model, reasoning) {
  if (!reasoning || !isSolModel(model) || !['minimal', 'none'].includes(reasoning.effort)) return reasoning;
  return { ...reasoning, effort: 'low' };
}

// Only price/speed routing variants may be replaced; preserve other suffix semantics.
function solBaseModel(model) {
  return migrateLegacyGptModel(model).match(
    /^(?:openai\/)?(gpt-6\.1-sol(?:-(?:\d{8}|\d{4}-\d{2}-\d{2}))?)(?::(?:floor|nitro))?$/i,
  )?.[1]?.toLowerCase() || null;
}

export function isSolModel(model) {
  return solBaseModel(model) !== null;
}

export function applySolServiceTier(provider, model, routing) {
  model = migrateLegacyGptModel(model);
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
