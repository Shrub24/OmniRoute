/**
 * OmniRoute combo discovery + combo → Pi `ProviderModelConfig` mapping.
 *
 * Combos live on the management plane (`/api/combos`, `/api/combos/auto`) —
 * NOT under `/v1/...`. Each usable combo becomes a PLAIN model entry under the
 * single `omniroute` provider (never a second provider), with capabilities
 * rolled up across members by lowest-common-denominator (LCD): if any member
 * lacks a capability, the combo as a whole cannot guarantee it.
 *
 * Ported faithfully from `@omniroute/opencode-plugin` (same behaviour, Pi
 * `ProviderModelConfig` shape, no opencode SDK imports). Guards reused:
 *   - usable-combo: hidden combos are skipped; combos with zero resolvable
 *     members are skipped (the catalog IS the routing universe for Pi — an
 *     unresolvable combo is provably unroutable, so advertising it with
 *     all-false LCD would mislead).
 *   - bare-combo-ids: combo entries are keyed by their display NAME (Pi stamps
 *     the `provider` field separately); that is the id `/v1/models` mirrors the
 *     combo under, so `buildOmniRouteProviderConfig` lets the combo win over
 *     the pre-mirrored raw entry it already advertises. See
 *     `comboProviderModelId`.
 *   - auto-combo-context: virtual auto combos get POSITIVE context/output
 *     fallbacks so Pi's overflow guard never treats 0 as "never overflow".
 *
 * Reasoning and thinking levels are UNIONED across members, not LCDed:
 * `reasoning` is true when ANY member reasons, and `thinkingLevelMap` is built
 * from the union of member `effort_tiers` — tierless members contribute
 * nothing and never veto (model identity already varies per request for a
 * combo, so reasoning depth varying with it is the same semantic, and LCD
 * would let one tierless member strip thinking levels from the whole combo).
 * All-tierless combos expose NO mapping key.
 */

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import {
  CHAT_API,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  RESPONSES_API,
  ZERO_COST,
  buildThinkingLevelMap,
  declaredEffortTiers,
  resolveApiFormat,
} from "./map.js";
import { ensureV1ApiBaseUrl, trimTrailingSlashes, type OmniRouteRawModelEntry } from "./models.js";

/** Raw shape of one member step inside an `/api/combos` entry. */
export interface OmniRouteRawComboMemberRef {
  /** Step kind: "model" references a raw model id; "combo-ref" nests another combo. */
  kind?: "model" | "combo-ref";
  /** Full model id referenced by this step (when kind === "model"). */
  model?: string;
  /** Nested combo name (when kind === "combo-ref"). */
  comboName?: string;
  /** Routing weight inside the combo (0–100, advisory at LCD time). */
  weight?: number;
  /** Step-local label, distinct from the parent combo's display name. */
  label?: string;
}

/** Raw shape of a single `/api/combos` entry. */
export interface OmniRouteRawCombo {
  id: string;
  name?: string;
  /** Routing strategy. Surfaced for forward-compat but not consumed by LCD. */
  strategy?: string;
  /** Member step list. Only `kind: "model"` steps participate in LCD. */
  models?: OmniRouteRawComboMemberRef[];
  /** Hidden combos are excluded from the Pi model picker. */
  isHidden?: boolean;
  release_date?: string;
  /**
   * Server-computed context window for this combo (aggregated from member
   * models using the same logic as /v1/models). When present, the client uses
   * this value directly instead of re-aggregating from member models.
   */
  computed_context_length?: number;
}

/** Raw shape of a single `/api/combos/auto` entry (virtual, server-side). */
export interface OmniRouteRawAutoCombo {
  /** Stable id (e.g. "auto", "auto/coding"). */
  id: string;
  /** Human-readable name (e.g. "Auto", "Auto Coding"). */
  name?: string;
  /** Whether this auto combo should be hidden from the picker. */
  isHidden?: boolean;
  /** MAX of candidates' context windows, served by newer OmniRoute builds. */
  context_length?: number;
  /** MAX of candidates' max output tokens (same provenance as context_length). */
  max_output_tokens?: number;
}

/**
 * Fetcher contract for `/api/combos`. Same DI shape as `OmniRouteModelsFetcher`
 * so unit tests can inject a stub instead of monkey-patching global `fetch`.
 */
export type OmniRouteCombosFetcher = (
  baseURL: string,
  apiKey: string,
  timeoutMs?: number
) => Promise<OmniRouteRawCombo[]>;

/**
 * Fetcher contract for `/api/combos/auto`. Fault-tolerant: returns an empty
 * list on 404 / non-2xx / network error — auto combos are additive.
 */
export type OmniRouteAutoCombosFetcher = (
  baseURL: string,
  apiKey: string,
  timeoutMs?: number
) => Promise<OmniRouteRawAutoCombo[]>;

/** Default `/api/combos` abort timeout. */
export const DEFAULT_COMBOS_TIMEOUT_MS = 10_000;
/**
 * Default `/api/combos/auto` abort timeout.
 *
 * Measured 9–21 s against a live gateway: the endpoint materialises a candidate
 * pool per auto combo before responding, so it is far slower than
 * `/api/combos`. The old 5 s ceiling always aborted, and because the fetcher is
 * fault-tolerant (empty list on abort) the auto combos vanished silently.
 * Auto combos are OFF by default (`OMNIROUTE_AUTO_COMBOS`), so this timeout is
 * only ever paid at startup by an operator who explicitly opted in.
 */
export const DEFAULT_AUTO_COMBOS_TIMEOUT_MS = 30_000;

/**
 * Default `/api/combos` fetcher: `GET <root>/api/combos` with Bearer auth +
 * AbortController timeout. Accepts both the `{combos: [...]}` envelope and a
 * bare-array envelope. Anything that isn't an object with a string `id` is
 * filtered out silently. Non-2xx THROWS (like the models fetcher) — graceful
 * degradation to combos-absent is the CALLER's job (`index.ts`), so a combo
 * failure never blocks model registration.
 */
export const defaultOmniRouteCombosFetcher: OmniRouteCombosFetcher = async (
  baseURL,
  apiKey,
  timeoutMs = DEFAULT_COMBOS_TIMEOUT_MS
) => {
  if (!apiKey) throw new Error("@omniroute/pi-agent: apiKey required to fetch /api/combos");
  if (!baseURL) throw new Error("@omniroute/pi-agent: baseURL required to fetch /api/combos");

  // Strip trailing slashes, then a trailing `/v1` so we land on the management
  // plane: models live under `/v1/models`, combos under `/api/combos` from the
  // same gateway root.
  const root = trimTrailingSlashes(baseURL).replace(/\/v\d+$/, "");
  const url = `${root}/api/combos`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`@omniroute/pi-agent: GET ${url} failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as unknown;
    const rawList: unknown[] = Array.isArray(body)
      ? body
      : body && typeof body === "object" && Array.isArray((body as { combos?: unknown }).combos)
        ? ((body as { combos: unknown[] }).combos as unknown[])
        : [];
    const out: OmniRouteRawCombo[] = [];
    for (const r of rawList) {
      if (r && typeof r === "object" && typeof (r as { id?: unknown }).id === "string") {
        out.push(r as OmniRouteRawCombo);
      }
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Default `/api/combos/auto` fetcher. Fault-tolerant by design: 404 (endpoint
 * not deployed yet), any non-2xx, or a network error returns an empty list —
 * auto combos are additive and must never block model registration.
 */
export const defaultOmniRouteAutoCombosFetcher: OmniRouteAutoCombosFetcher = async (
  baseURL,
  apiKey,
  timeoutMs = DEFAULT_AUTO_COMBOS_TIMEOUT_MS
) => {
  if (!apiKey || !baseURL) return [];
  const root = trimTrailingSlashes(baseURL).replace(/\/v\d+$/, "");
  const url = `${root}/api/combos/auto`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    if (res.status === 404) return [];
    if (!res.ok) return [];
    const body = (await res.json()) as unknown;
    const rawList: unknown[] = Array.isArray(body)
      ? body
      : body && typeof body === "object" && Array.isArray((body as { combos?: unknown }).combos)
        ? ((body as { combos: unknown[] }).combos as unknown[])
        : [];
    const out: OmniRouteRawAutoCombo[] = [];
    for (const r of rawList) {
      if (r && typeof r === "object" && typeof (r as { id?: unknown }).id === "string") {
        out.push(r as OmniRouteRawAutoCombo);
      }
    }
    return out;
  } catch {
    // Network error, timeout, abort — all non-fatal.
    return [];
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Resolve a combo's member steps against the fetched catalog. `combo-ref`
 * steps (nested combos) are not resolved here — they carry no raw model id —
 * so a combo whose members are ALL combo-refs degrades to zero resolvable
 * members and is skipped by the usable guard. Unknown model ids are dropped.
 */
export function resolveComboMembers(
  combo: OmniRouteRawCombo,
  rawModelById: Map<string, OmniRouteRawModelEntry>
): OmniRouteRawModelEntry[] {
  const steps = Array.isArray(combo.models) ? combo.models : [];
  const members: OmniRouteRawModelEntry[] = [];
  for (const step of steps) {
    if (step?.kind === "combo-ref") continue;
    const modelId = typeof step?.model === "string" ? step.model : "";
    if (modelId.length === 0) continue;
    const member = rawModelById.get(modelId);
    if (member) members.push(member);
  }
  return members;
}

/**
 * Resolve the Pi model id for a combo.
 *
 * MUST be the combo's display NAME, never `combo.id`. OmniRoute's `/v1/models`
 * mirrors every combo as a raw entry keyed by its name (`owned_by: "combo"` —
 * `"coder-high"`, `"Kimi Coding"`), while `/api/combos` returns an opaque UUID
 * in `id`. `buildOmniRouteProviderConfig` gives combos precedence over the raw
 * mirror by id, so a UUID-keyed combo entry never collides with its own mirror:
 * the map-less raw entry stays in the catalog, and Pi's
 * `getSupportedThinkingLevels` drops `xhigh`/`max` because both require an
 * explicit `thinkingLevelMap` entry (`undefined` fails the gate). Keying by
 * name is what makes the richer LCD roll-up — including the unioned
 * `thinkingLevelMap` — actually reach the picker.
 *
 * Mirrors `buildComboKey` in the opencode plugin, which derives the same
 * name-based key for the same reason.
 */
export function comboProviderModelId(combo: OmniRouteRawCombo): string {
  return combo.name && combo.name.trim().length > 0 ? combo.name.trim() : combo.id;
}

/**
 * Map a raw combo entry → Pi `ProviderModelConfig` by lowest-common-denominator
 * (LCD) across its member models. The LCD policy is the only way to surface a
 * single capability vector to Pi without lying: if any member lacks a
 * capability, the combo as a whole cannot guarantee it.
 *
 * LCD rules (mirrors `mapComboToModelV2` in the opencode plugin):
 *   - `reasoning`: UNIONED — true when ANY member supports reasoning (ORing
 *     `reasoning`/`thinking` per member, then OR-ing across the combo). A
 *     single non-reasoning member no longer strips it.
 *   - `input`: flattened AND across members' input modalities (missing arrays
 *     default to `["text"]`); falls back to `["text"]` when the intersection
 *     is empty.
 *   - `contextWindow` / `maxTokens`: `computed_context_length` wins when the
 *     server provides it, else `min(...members)`; falls back to Pi defaults.
 *   - `api`: the responses wire protocol ONLY when every member is
 *     responses-format, else chat — the lowest common denominator every
 *     upstream understands.
 *   - `cost`: zeroed.
 *   - `id` / `name`: the combo's display name (`comboProviderModelId`), which is
 *     the id `/v1/models` mirrors the combo under — never the UUID in
 *     `combo.id`, or this entry could not replace that mirror.
 *   - `thinkingLevelMap`: UNIONED — built from the union of member
 *     `effort_tiers` (tierless members contribute nothing and never veto);
 *     all-tierless combos expose no mapping key.
 *
 * Defensive: empty members array → all capabilities false (an empty combo
 * cannot route). Callers should already have filtered zero-member combos via
 * the usable guard, but the mapping stays safe regardless.
 */
export function mapComboToProviderModel(
  combo: OmniRouteRawCombo,
  members: OmniRouteRawModelEntry[],
  baseURL: string
): ProviderModelConfig {
  // `every` over an empty array returns true (would lie about an empty combo's
  // capabilities) — short-circuit to all-false when no members.
  const hasMembers = members.length > 0;

  const memberInMods = members.map((m) => new Set(m.input_modalities ?? ["text"]));
  const modalityAllHave = (key: string): boolean =>
    hasMembers && memberInMods.every((s) => s.has(key));

  const input: ("text" | "image")[] = [];
  if (modalityAllHave("text")) input.push("text");
  if (modalityAllHave("image")) input.push("image");
  if (input.length === 0) input.push("text");

  const reasoning =
    hasMembers &&
    members.some((m) => Boolean(m.capabilities?.reasoning || m.capabilities?.thinking));

  // Union of member-declared effort tiers. Tierless members contribute
  // nothing and never veto; an all-tierless (or empty) combo exposes no map.
  const unionTiers = new Set<string>();
  for (const m of members) {
    const tiers = declaredEffortTiers(m.capabilities);
    if (tiers) for (const tier of tiers) unionTiers.add(tier);
  }
  const thinkingLevelMap = unionTiers.size > 0 ? buildThinkingLevelMap([...unionTiers]) : undefined;

  const api =
    hasMembers && members.every((m) => resolveApiFormat(m.api_format) === RESPONSES_API)
      ? RESPONSES_API
      : CHAT_API;

  const contextValues = members
    .map((m) => m.context_length)
    .filter((v): v is number => typeof v === "number" && v > 0);
  const outputValues = members
    .map((m) => m.max_output_tokens)
    .filter((v): v is number => typeof v === "number" && v > 0);

  const contextLength =
    typeof combo.computed_context_length === "number" && combo.computed_context_length > 0
      ? combo.computed_context_length
      : contextValues.length > 0
        ? Math.min(...contextValues)
        : undefined;
  const maxTokens = outputValues.length > 0 ? Math.min(...outputValues) : undefined;

  const modelId = comboProviderModelId(combo);

  return {
    id: modelId,
    name: modelId,
    api,
    baseUrl: ensureV1ApiBaseUrl(baseURL),
    reasoning,
    input,
    cost: { ...ZERO_COST },
    contextWindow: contextLength ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: maxTokens ?? DEFAULT_MAX_TOKENS,
    // Same rationale as mapRawEntryToProviderModel: keep Pi's session identity
    // flowing so OmniRoute's account pinning keys on the session, not on a
    // hash of the first input text.
    compat: { sendSessionAffinityHeaders: true, sessionAffinityFormat: "openrouter" },
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
  };
}

/**
 * Fallbacks when the server does not advertise auto-combo limits (older
 * OmniRoute builds). MUST be positive: Pi's overflow guard treats
 * `contextWindow === 0` as "never overflow" and silently disables smart
 * auto-compaction, letting the session grow until the gateway's destructive
 * history purge kicks in (the "agent keeps forgetting things" bug).
 */
export const AUTO_COMBO_FALLBACK_CONTEXT = 128_000;
export const AUTO_COMBO_FALLBACK_OUTPUT = 8_192;

/**
 * Convert a raw auto combo into a plain Pi model entry. Auto combos route to
 * capable models at runtime, so they advertise reasoning/tool support and text
 * input; context/output limits come from the server (MAX of the candidate
 * pool's windows) with a safe positive fallback when omitted. Never 0.
 * Exposes no `thinkingLevelMap` (no declared tiers on a virtual combo).
 */
export function mapAutoComboToProviderModel(
  autoCombo: OmniRouteRawAutoCombo,
  baseURL: string
): ProviderModelConfig {
  const context =
    typeof autoCombo.context_length === "number" && autoCombo.context_length > 0
      ? autoCombo.context_length
      : AUTO_COMBO_FALLBACK_CONTEXT;
  const output =
    typeof autoCombo.max_output_tokens === "number" && autoCombo.max_output_tokens > 0
      ? autoCombo.max_output_tokens
      : AUTO_COMBO_FALLBACK_OUTPUT;
  return {
    id: autoCombo.id,
    name: autoCombo.name && autoCombo.name.trim().length > 0 ? autoCombo.name.trim() : autoCombo.id,
    api: CHAT_API,
    baseUrl: ensureV1ApiBaseUrl(baseURL),
    reasoning: true,
    input: ["text"],
    cost: { ...ZERO_COST },
    contextWindow: context,
    maxTokens: output,
    compat: { sendSessionAffinityHeaders: true, sessionAffinityFormat: "openrouter" },
  };
}
