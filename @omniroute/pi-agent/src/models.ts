/**
 * OmniRoute `/v1/models` raw fetcher + entry typing.
 *
 * Ported faithfully from `@omniroute/opencode-plugin` (same behaviour, error
 * prefix adapted, no opencode SDK imports): baseURL `/v1` normalization,
 * Bearer auth, `{object:"list", data:[…]}` / bare-array envelope tolerance,
 * and a 30s AbortController timeout. Failure is always loud — an HTTP error
 * throws with `status` / `statusCode` attached, never a silently empty list.
 */

/**
 * Raw shape of a `/v1/models` entry from OmniRoute. STRICT source of truth:
 * every field that later lands in a Pi `ProviderModelConfig` traces back to
 * this shape — no client-side variant synthesis.
 */
export interface OmniRouteRawModelEntry {
  id: string;
  object?: string;
  owned_by?: string;
  root?: string | null;
  parent?: string | null;
  context_length?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  input_modalities?: string[];
  output_modalities?: string[];
  capabilities?: {
    tool_calling?: boolean;
    reasoning?: boolean;
    vision?: boolean;
    thinking?: boolean;
    attachment?: boolean;
    structured_output?: boolean;
    temperature?: boolean;
    /** Runtime-learned or synced reasoning tiers (server-gated, blind-mapped). */
    effort_tiers?: string[];
  };
  release_date?: string;
  last_updated?: string;
  api_format?: string;
}

/** Default `/v1/models` abort timeout. */
export const DEFAULT_MODELS_TIMEOUT_MS = 30_000;

/**
 * Fetcher contract: returns the raw `/v1/models` entry list from a running
 * OmniRoute instance. Surfaced as a dependency so unit tests can inject a
 * stub without monkey-patching global `fetch`.
 */
export type OmniRouteModelsFetcher = (
  baseURL: string,
  apiKey: string,
  timeoutMs?: number
) => Promise<OmniRouteRawModelEntry[]>;

/** Manual trim avoids polynomial-regex scanners on user-supplied baseURL strings. */
export function trimTrailingSlashes(value: string): string {
  let i = value.length;
  while (i > 0 && value.charCodeAt(i - 1) === 0x2f /* "/" */) i--;
  return i === value.length ? value : value.slice(0, i);
}

/**
 * Normalize a gateway base URL to the `/v1` API root Pi's OpenAI SDK composes
 * from. The SDK appends the resource path itself (`/chat/completions`,
 * `/responses`), so the base must carry exactly one `/v1` — never bare
 * `https://host` (Pi would hit `/chat/completions` without the version
 * prefix) and never a doubled `/v1/v1`.
 */
export function ensureV1ApiBaseUrl(baseURL: string): string {
  const trimmed = trimTrailingSlashes(baseURL);
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

/**
 * Default fetcher: `GET <baseURL>/v1/models` with Bearer auth + AbortController
 * timeout. Accepts both the `{object:"list", data:[…]}` envelope OmniRoute
 * emits today and a bare-array envelope (defensive — keeps the extension
 * working if a future OmniRoute build trims the wrapper). Anything that
 * isn't an object with a string `id` is filtered out silently. HTTP errors
 * throw with `status` / `statusCode` attached — never a silently empty list.
 */
export const defaultOmniRouteModelsFetcher: OmniRouteModelsFetcher = async (
  baseURL,
  apiKey,
  timeoutMs = DEFAULT_MODELS_TIMEOUT_MS
) => {
  if (!apiKey) throw new Error("@omniroute/pi-agent: apiKey required to fetch /v1/models");
  if (!baseURL) throw new Error("@omniroute/pi-agent: baseURL required to fetch /v1/models");

  const trimmed = trimTrailingSlashes(baseURL);
  // Tolerate both `https://host` and `https://host/v1` forms — the gateway
  // exposes /v1/models either way; we just don't want a double `/v1/v1`.
  const url = /\/v\d+$/.test(trimmed) ? `${trimmed}/models` : `${trimmed}/v1/models`;

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
      const err = new Error(
        `@omniroute/pi-agent: GET ${url} failed: ${res.status} ${res.statusText}`
      ) as Error & { statusCode: number; status: number };
      err.statusCode = res.status;
      err.status = res.status;
      throw err;
    }
    const body = (await res.json()) as unknown;
    const rawList: unknown[] = Array.isArray(body)
      ? body
      : body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data)
        ? ((body as { data: unknown[] }).data as unknown[])
        : [];
    const out: OmniRouteRawModelEntry[] = [];
    for (const r of rawList) {
      if (r && typeof r === "object" && typeof (r as { id?: unknown }).id === "string") {
        out.push(r as OmniRouteRawModelEntry);
      }
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
};
