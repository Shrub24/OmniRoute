/**
 * Raw OmniRoute `/v1/models` entry → Pi `ProviderModelConfig` mapping.
 *
 * Every value is either mapped from the raw entry or a flagged Pi default —
 * never synthesized. Missing metadata falls back to Pi's defaults AND the gap
 * is made visible in the model name/description so it is never silently
 * misreported as measured. Cost is zeroed (pricing enrichment is out of scope
 * for this milestone).
 *
 * Server-declared `capabilities.effort_tiers` map to Pi `thinkingLevelMap`
 * (declared tiers only, `null` for unsupported holes, never synthesized);
 * tierless entries expose NO mapping key. See `buildThinkingLevelMap`.
 *
 * The per-model wire protocol (`api`) is pinned from the entry's `api_format`:
 *   - `responses` → Pi `openai-responses` (hits `<server>/v1/responses`)
 *   - anything else (chat / missing) → Pi `openai-completions`
 *     (hits `<server>/v1/chat/completions`)
 * The Pi OpenAI SDK composes the resource path from the base URL, so the base
 * is normalized to exactly one `/v1` — never a doubled `/v1/v1/…`.
 */

import type { ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { ensureV1ApiBaseUrl, type OmniRouteRawModelEntry } from "./models.js";

/** Pi's default context window when the entry omits `context_length`. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;
/** Pi's default max output tokens when the entry omits `max_output_tokens`. */
export const DEFAULT_MAX_TOKENS = 16_384;

/** Zeroed cost — pricing enrichment is a later milestone, never invented here. */
export const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Visible-gap marker appended to a model name when metadata is missing. */
export const GAP_SUFFIX = " (metadata missing — Pi defaults)";

/** Pi wire protocol for chat-format entries. */
export const CHAT_API = "openai-completions";
/** Pi wire protocol for responses-format entries. */
export const RESPONSES_API = "openai-responses";

/**
 * Pi `apiKey` env-interpolation reference for the provider request key.
 *
 * Pi resolves `$ENV_VAR` at request time (never a literal copy in the config)
 * and surfaces the provider's "API key" login in `/login`. Catalog-fetch
 * credentials stay on the same env var read directly by the extension — the
 * provider key is a Pi-side reference, so Pi's documented precedence
 * (CLI flag > auth.json > env > static) holds without extension interference.
 */
export const PROVIDER_API_KEY_ENV_REF = "$OMNIROUTE_API_KEY";

/**
 * Pi's fixed thinking-level vocabulary. Order matters only for readability —
 * every level gets an explicit entry in the map (a declared tier string or
 * `null` for an unsupported hole), never an omitted key.
 */
export const PI_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/**
 * Pi level → OmniRoute server-tier correspondence. `off` maps to the server's
 * canonical `none` (the explicit "no reasoning effort" tier). Every other Pi
 * level maps to the server tier of the same name. This is a pure vocabulary
 * alias — the values that land in the map are always the server's own declared
 * tier strings, never invented.
 */
const PI_LEVEL_TO_SERVER_TIER: Record<(typeof PI_THINKING_LEVELS)[number], string> = {
  off: "none",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

/**
 * Build the Pi `thinkingLevelMap` from server-declared `effort_tiers`.
 *
 * Declared tiers only, no synthesis: each Pi level maps to the server tier it
 * corresponds to when that tier is declared, and to `null` when it is not (a
 * `null` hole marks the level unsupported — Pi's `getSupportedThinkingLevels`
 * excludes it and the request path never sends it). A tier the server declares
 * but Pi has no level for (e.g. codex `ultra`) simply never appears — Pi
 * cannot express it.
 */
export function buildThinkingLevelMap(
  declaredTiers: readonly string[]
): NonNullable<ProviderModelConfig["thinkingLevelMap"]> {
  const declared = new Set(declaredTiers);
  const map: NonNullable<ProviderModelConfig["thinkingLevelMap"]> = {};
  for (const level of PI_THINKING_LEVELS) {
    const tier = PI_LEVEL_TO_SERVER_TIER[level];
    map[level] = declared.has(tier) ? tier : null;
  }
  return map;
}

/**
 * Extract the declared, non-empty `effort_tiers` from an entry's capabilities.
 * Returns `undefined` when absent/empty/malformed so callers OMIT the
 * `thinkingLevelMap` key entirely (a tierless model/combo exposes no mapping).
 */
export function declaredEffortTiers(
  caps: { effort_tiers?: unknown } | undefined
): string[] | undefined {
  const tiers = Array.isArray(caps?.effort_tiers)
    ? caps.effort_tiers.filter((t): t is string => typeof t === "string" && t.length > 0)
    : [];
  return tiers.length > 0 ? tiers : undefined;
}

/**
 * Map a raw entry's `api_format` to the Pi wire protocol. Anything that is
 * not the responses format is treated as chat (OmniRoute's default surface).
 */
export function resolveApiFormat(
  apiFormat: string | undefined
): "openai-completions" | "openai-responses" {
  return apiFormat === "responses" ? RESPONSES_API : CHAT_API;
}

/**
 * Map a raw `/v1/models` entry to a Pi `ProviderModelConfig`.
 *
 * `baseURL` is the gateway base URL (with or without a trailing `/v1`); the
 * returned model's `baseUrl` is normalized to the `/v1` API root so Pi's SDK
 * composes the correct resource path.
 */
export function mapRawEntryToProviderModel(
  raw: OmniRouteRawModelEntry,
  baseURL: string
): ProviderModelConfig {
  const caps = raw.capabilities ?? {};
  const reasoning = Boolean(caps.reasoning || caps.thinking);

  const input: ("text" | "image")[] = [];
  for (const mod of raw.input_modalities ?? ["text"]) {
    if (mod === "text" || mod === "image") input.push(mod);
  }
  if (input.length === 0) input.push("text");

  const contextLength =
    typeof raw.context_length === "number" && raw.context_length > 0
      ? raw.context_length
      : undefined;
  const maxTokens =
    typeof raw.max_output_tokens === "number" && raw.max_output_tokens > 0
      ? raw.max_output_tokens
      : undefined;
  const gap = contextLength === undefined || maxTokens === undefined;
  const thinkingLevelMap = declaredEffortTiers(caps);

  return {
    id: raw.id,
    name: gap ? `${raw.id}${GAP_SUFFIX}` : raw.id,
    api: resolveApiFormat(raw.api_format),
    baseUrl: ensureV1ApiBaseUrl(baseURL),
    reasoning,
    input,
    cost: { ...ZERO_COST },
    contextWindow: contextLength ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: maxTokens ?? DEFAULT_MAX_TOKENS,
    // OmniRoute derives its session-affinity key (account pinning,
    // src/sse/services/sessionAffinityPin.ts) from client session headers;
    // without this flag Pi sends none and falls back to hashing the first
    // input text, which re-keys every turn. Only the openai-completions path
    // reads the flag (the responses API has no affinity headers), and every
    // OmniRoute model resolves to one of the two.
    compat: { sendSessionAffinityHeaders: true, sessionAffinityFormat: "openrouter" },
    ...(thinkingLevelMap ? { thinkingLevelMap: buildThinkingLevelMap(thinkingLevelMap) } : {}),
  };
}

/**
 * Build the Pi `ProviderConfig` passed to `registerProvider("omniroute", …)`
 * from the fetched catalog. Provider-level `baseUrl` is normalized to the
 * `/v1` API root; each model pins its own wire protocol via `api_format`.
 *
 * `apiKey` (optional) is the Pi `apiKey` form carried on the provider config —
 * `$ENV_VAR` / `${ENV_VAR}` / `!cmd` / literal. When omitted the config has no
 * `apiKey` key at all (pure mapping callers stay auth-free).
 *
 * `combos` are pre-mapped Pi `ProviderModelConfig` entries (see `combos.ts`).
 * They become plain model entries under the SAME `omniroute` provider — never a
 * second provider — and WIN over a pre-mirrored raw entry with the same id:
 * OmniRoute's `/v1/models` already advertises combos as raw entries
 * (`owned_by: "combo"`), and the combo entry carries the richer LCD roll-up.
 */
export function buildOmniRouteProviderConfig(
  baseURL: string,
  models: OmniRouteRawModelEntry[],
  combos: ProviderModelConfig[] = [],
  apiKey?: string
): ProviderConfig {
  const byId = new Map<string, ProviderModelConfig>();
  for (const raw of models) byId.set(raw.id, mapRawEntryToProviderModel(raw, baseURL));
  for (const combo of combos) byId.set(combo.id, combo);
  return {
    name: "OmniRoute",
    baseUrl: ensureV1ApiBaseUrl(baseURL),
    ...(apiKey ? { apiKey } : {}),
    models: [...byId.values()],
  };
}
