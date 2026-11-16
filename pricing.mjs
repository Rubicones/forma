// What each step would cost at public API list prices, whatever was actually used (subscription or key).
// USD per 1M tokens. Checked 2026-11-16 against platform.claude.com/docs pricing and developers.openai.com.
// Override or add models with PRICING_JSON='{"custom":{"input":3,"output":15,"cacheRead":0.3}}'.
const base = {
  'claude-opus-5-5':   {input:4,   output:20, cacheRead:0.20, cacheWrite:5},
  'claude-sonnet-5-5': {input:2,   output:10, cacheRead:0.10, cacheWrite:2.5},
  'claude-sonnet-4-6': {input:3,   output:15, cacheRead:0.30, cacheWrite:3.75},
  'claude-haiku-5-5':  {input:0.1, output:0.5, cacheRead:0.01, cacheWrite:0.125},
  'gpt-5.4':           {input:2.5, output:15, cacheRead:0.25},
  'gpt-6.1-sol':       {input:2, output:10, cacheRead:0.10, cacheWrite:2.50},
  'gpt-6-astra':       {input:10, output:50, cacheRead:1, cacheWrite:12.50},
};
let override = {};
try { override = JSON.parse(process.env.PRICING_JSON || '{}'); } catch { console.warn('PRICING_JSON is not valid JSON'); }
export const prices = {...base, ...override};

// Model ids may carry suffixes (dates, [1m]); match the longest known prefix.
function keyFor(model) {
  if (!model) return null;
  const id = String(model).toLowerCase();
  if (Object.hasOwn(prices, id)) return id;
  const family = id.replace(/(?:-\d{4}-\d{2}-\d{2})?(?:\[1m\])?$/, '');
  return Object.hasOwn(prices, family) ? family : null;
}

export function priceFor(model) {
  return prices[keyFor(model)] ?? null;
}

// usage: {input, output, cacheRead, cacheWrite} in tokens (input excludes cached tokens). Returns USD or null if unknown.
export function tokenCost(model, usage = {}) {
  const p = priceFor(model);
  if (!p) return null;
  const per = (tokens, rate) => (Number(tokens) || 0) * (rate ?? p.input) / 1e6;
  return per(usage.input, p.input) + per(usage.output, p.output) + per(usage.cacheRead, p.cacheRead) + per(usage.cacheWrite, p.cacheWrite);
}

// Claude Agent SDK result: modelUsage per model (preferred) or the aggregate usage.
export function claudeCost(result, fallbackModel) {
  const rows = Object.entries(result.modelUsage || {});
  if (rows.length) {
    let total = 0;
    for (const [rawModel, u] of rows) {
      const model = keyFor(rawModel) || u.canonicalModel;
      const custom = override[keyFor(model)];
      if (!custom && u.costBasis !== 'unknown' && Number.isFinite(u.costUSD)) {
        total += u.costUSD;
        continue;
      }
      const cost = claudeTokenCost(model, u.inputTokens, u.outputTokens, u.cacheReadInputTokens,
        u.cacheCreationInputTokens, u.cacheCreationEphemeral1hInputTokens);
      if (cost === null) return null;
      total += cost;
    }
    return total;
  }
  if (!override[keyFor(fallbackModel)] && Number.isFinite(result.total_cost_usd) && result.total_cost_usd > 0) {
    return result.total_cost_usd;
  }
  const u = result.usage;
  return u ? claudeTokenCost(fallbackModel, u.input_tokens, u.output_tokens, u.cache_read_input_tokens,
    u.cache_creation_input_tokens, u.cache_creation?.ephemeral_1h_input_tokens) : null;
}

function claudeTokenCost(model, input, output, cacheRead, cacheWrite = 0, hour = 0) {
  if (!Number.isFinite(input) || !Number.isFinite(output) || hour > cacheWrite) return null;
  const cost = tokenCost(model, {input, output, cacheRead, cacheWrite:cacheWrite - hour});
  const p = priceFor(model);
  if (cost === null) return null;
  const hourRate = p.cacheWrite1h ?? (override[keyFor(model)] ? p.cacheWrite ?? p.input : 2 * p.input);
  return cost + hour * hourRate / 1e6;
}

// turn.completed aggregates model requests. The long-context threshold is per request.
export function codexCost(model, u = {}) {
  const {input_tokens:input, output_tokens:output, cached_input_tokens:cached = 0,
    cache_write_input_tokens:writes = 0} = u;
  if (![input, output, cached, writes].every(n => Number.isSafeInteger(n) && n >= 0) ||
      cached + writes > input || input > 272000) return null;
  return tokenCost(model, {input:input - cached - writes, cacheRead:cached, cacheWrite:writes, output});
}

export const usd = value => typeof value === 'number' ? '$' + (value < 0.01 ? value.toFixed(4) : value.toFixed(3)) : '—';
