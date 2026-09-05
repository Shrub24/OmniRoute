import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import {
  defaultOmniRouteAutoCombosFetcher,
  defaultOmniRouteCombosFetcher,
  mapAutoComboToProviderModel,
  mapComboToProviderModel,
  resolveComboMembers,
  type OmniRouteAutoCombosFetcher,
  type OmniRouteCombosFetcher,
  type OmniRouteRawAutoCombo,
  type OmniRouteRawCombo,
} from "./combos.js";
import { buildOmniRouteProviderConfig, PROVIDER_API_KEY_ENV_REF } from "./map.js";
import {
  defaultOmniRouteModelsFetcher,
  type OmniRouteModelsFetcher,
  type OmniRouteRawModelEntry,
} from "./models.js";

export { defaultOmniRouteModelsFetcher } from "./models.js";
export type { OmniRouteModelsFetcher, OmniRouteRawModelEntry } from "./models.js";

/**
 * Emit a notice ONLY when stdout is not a TTY (headless `pi -p` keeps full
 * observability). Pi's fullscreen TUI shares the stdout/stderr stream, so any
 * extension `console.*` output glitches into it — under a TTY we emit zero
 * bytes. Loud thrown errors are unchanged (Pi renders those through its own
 * UI). `registerCommand` handlers return void, so there is no Pi-native
 * message channel to use instead — TTY-gating is the sanctioned fix.
 */
export function notify(level: "info" | "warn", message: string): void {
  if (process.stdout.isTTY) return;
  if (level === "warn") console.warn(message);
  else console.info(message);
}
export {
  buildOmniRouteProviderConfig,
  buildThinkingLevelMap,
  declaredEffortTiers,
  mapRawEntryToProviderModel,
  resolveApiFormat,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  GAP_SUFFIX,
  CHAT_API,
  RESPONSES_API,
  PI_THINKING_LEVELS,
  PROVIDER_API_KEY_ENV_REF,
  ZERO_COST,
} from "./map.js";
export {
  defaultOmniRouteAutoCombosFetcher,
  defaultOmniRouteCombosFetcher,
  comboProviderModelId,
  mapAutoComboToProviderModel,
  mapComboToProviderModel,
  resolveComboMembers,
  AUTO_COMBO_FALLBACK_CONTEXT,
  AUTO_COMBO_FALLBACK_OUTPUT,
  DEFAULT_COMBOS_TIMEOUT_MS,
  DEFAULT_AUTO_COMBOS_TIMEOUT_MS,
} from "./combos.js";
export type {
  OmniRouteAutoCombosFetcher,
  OmniRouteCombosFetcher,
  OmniRouteRawAutoCombo,
  OmniRouteRawCombo,
  OmniRouteRawComboMemberRef,
} from "./combos.js";

/** Injectable fetchers + catalog switches for the orchestrator (unit-test seam). */
export interface OmniRoutePiAgentCatalogOptions {
  models?: OmniRouteModelsFetcher;
  combos?: OmniRouteCombosFetcher;
  autoCombos?: OmniRouteAutoCombosFetcher;
  /**
   * Register OmniRoute's auto combos — the `/api/combos/auto` entries AND the
   * `auto/*` entries `/v1/models` mirrors for them.
   *
   * Default `false` (DROP): auto combos are a large family of routing presets
   * that duplicate what the combo picker already covers, and each one registers
   * without a `thinkingLevelMap` (their routing target is chosen at request
   * time), so Pi caps them at `high`. Dropping them also skips the
   * `/api/combos/auto` fetch, which is awaited at startup and takes seconds.
   * Opt in with `OMNIROUTE_AUTO_COMBOS=on`.
   */
  includeAutoCombos?: boolean;
}

/**
 * `/v1/models` mirrors every auto combo as a raw entry named `auto/...`
 * (`owned_by: "combo"`) — the same mirroring rule as named combos, which the
 * extension replaces by name via `comboProviderModelId`.
 */
function isAutoComboMirror(model: OmniRouteRawModelEntry): boolean {
  return model.owned_by === "combo" && model.id.startsWith("auto/");
}

/**
 * `OMNIROUTE_AUTO_COMBOS` — `on` / `true` / `1` / `yes` (case-insensitive)
 * enables auto combos. Anything else, including unset, drops them.
 */
export function autoCombosEnabled(raw: string | undefined): boolean {
  return /^(on|true|1|yes)$/i.test((raw ?? "").trim());
}

/**
 * Fetch the full catalog and build the `omniroute` provider config.
 *
 * Failure semantics mirror the spec:
 *   - `/v1/models` is the LOUD path — a fetch failure propagates (Pi startup
 *     fails) with the HTTP status attached, never a silently empty model list.
 *   - `/api/combos` and, when opted in, `/api/combos/auto` are ADDITIVE — a
 *     combo fetch failure degrades to combos-absent (warn + continue), never
 *     blocking model registration. Auto combos are fault-tolerant by fetcher
 *     design, and are only fetched when `includeAutoCombos` is set.
 *
 * Combos become plain model entries under the single `omniroute` provider
 * (never a second provider), with LCD roll-up and combos winning over the
 * pre-mirrored raw entries `/v1/models` already advertises.
 *
 * The returned config carries the provider request key as Pi's `$ENV_VAR`
 * apiKey form (`PROVIDER_API_KEY_ENV_REF`), so it surfaces in `/login` and Pi
 * resolves it at request time — the catalog-fetch `apiKey` argument stays a
 * plain credential read from extension config, never overloaded into the
 * provider key.
 */
export async function buildOmniRouteProviderConfigFromCatalog(
  baseURL: string,
  apiKey: string,
  options: OmniRoutePiAgentCatalogOptions = {}
): Promise<ProviderConfig> {
  const modelsFetcher = options.models ?? defaultOmniRouteModelsFetcher;
  const combosFetcher = options.combos ?? defaultOmniRouteCombosFetcher;
  const includeAutoCombos = options.includeAutoCombos === true;

  const models = await modelsFetcher(baseURL, apiKey); // loud
  // Member resolution sees the UNFILTERED catalog: a named combo may legitimately
  // reference a model that is itself an auto-combo mirror.
  const rawModelById = new Map(models.map((m) => [m.id, m]));

  const comboEntries: ProviderConfig["models"] = [];

  let rawCombos: OmniRouteRawCombo[] = [];
  try {
    rawCombos = await combosFetcher(baseURL, apiKey);
  } catch (err) {
    notify(
      "warn",
      `[@omniroute/pi-agent] /api/combos fetch failed — combos absent, models still register: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  for (const combo of rawCombos) {
    if (combo.isHidden === true) continue; // usable guard: hidden combos
    const members = resolveComboMembers(combo, rawModelById);
    if (members.length === 0) continue; // usable guard: no resolvable members
    comboEntries.push(mapComboToProviderModel(combo, members, baseURL));
  }

  if (includeAutoCombos) {
    const autoCombosFetcher = options.autoCombos ?? defaultOmniRouteAutoCombosFetcher;
    const autoCombos: OmniRouteRawAutoCombo[] = await autoCombosFetcher(baseURL, apiKey);
    for (const autoCombo of autoCombos) {
      if (autoCombo.isHidden === true) continue;
      comboEntries.push(mapAutoComboToProviderModel(autoCombo, baseURL));
    }
  }

  // Dropping auto combos means dropping their mirrors too — otherwise the
  // `/v1/models` mirror (map-less, `owned_by: "combo"`) stays in the picker and
  // is the only thing the user sees for that id.
  const registered = includeAutoCombos ? models : models.filter((m) => !isAutoComboMirror(m));

  return buildOmniRouteProviderConfig(baseURL, registered, comboEntries, PROVIDER_API_KEY_ENV_REF);
}

/**
 * Minimal Pi surface the re-sync path needs (unit-test seam — a mock with
 * `registerProvider` / `unregisterProvider` is enough to drive it).
 */
export interface OmniRoutePiAgentResyncDeps {
  pi: Pick<ExtensionAPI, "registerProvider" | "unregisterProvider">;
  baseURL: string;
  apiKey: string;
  options?: OmniRoutePiAgentCatalogOptions;
}

/**
 * Re-sync the `omniroute` provider mid-session: re-fetch the catalog and
 * re-apply it via `unregisterProvider()` + `registerProvider()`.
 * Pi applies both immediately after the initial load phase, so the fresh
 * model list takes effect without a restart or `/reload`.
 *
 * Safe ordering: the catalog is fetched BEFORE unregistering, so a fetch
 * failure leaves the previously registered provider intact (the error
 * propagates to the caller, who decides how loud to be).
 *
 * Returns the fresh config so callers can log/assert the model count.
 */
export async function resyncOmniRouteProvider(
  deps: OmniRoutePiAgentResyncDeps
): Promise<ProviderConfig> {
  const config = await buildOmniRouteProviderConfigFromCatalog(
    deps.baseURL,
    deps.apiKey,
    deps.options
  );
  deps.pi.unregisterProvider("omniroute");
  deps.pi.registerProvider("omniroute", config);
  return config;
}

/**
 * OmniRoute Pi extension entry point.
 *
 * Pi loads this module at startup through jiti (no build step) and awaits the
 * default export before startup continues. Async factories are the documented
 * pattern for providers that fetch a remote model list before registering —
 * which is exactly what happens here: fetch OmniRoute `/v1/models` (loud),
 * fetch `/api/combos` (additive, graceful degradation), and — only when
 * `OMNIROUTE_AUTO_COMBOS=on` — `/api/combos/auto`,
 * map everything to Pi `ProviderModelConfig` entries (reasoning/input/
 * contextWindow/maxTokens + per-model wire protocol from `api_format` +
 * server-declared `effort_tiers` → `thinkingLevelMap`), then register the
 * single `omniroute` provider via `pi.registerProvider()`.
 *
 * Catalog credentials come from extension config (env), never hardcoded:
 *   - `OMNIROUTE_BASE_URL`    — gateway base URL (`http://host:port` or `.../v1`)
 *   - `OMNIROUTE_API_KEY`     — gateway API key (Bearer)
 *   - `OMNIROUTE_AUTO_COMBOS` — `on` registers auto combos; unset/anything else
 *     DROPS them (the default). See `OmniRoutePiAgentCatalogOptions`.
 *
 * The provider request key is carried on the config as Pi's `$OMNIROUTE_API_KEY`
 * apiKey form (`PROVIDER_API_KEY_ENV_REF`): Pi resolves it at request time and
 * surfaces the provider's "API key" login in `/login`. Catalog-fetch
 * credentials stay on the same env var read directly here — they are never
 * overloaded into the provider key, and Pi's key precedence
 * (CLI > auth.json > env > static) holds without extension interference.
 *
 * When neither is set the extension is simply not configured: it logs a notice
 * and skips the fetch. When configured, a models fetch failure is LOUD — the
 * error propagates (Pi startup fails) and carries the HTTP status when one
 * exists, never a silently empty model list.
 *
 * Mid-session re-sync (no restart, no `/reload`):
 *   - `/omniroute-sync` command — re-fetches the catalog and re-applies the
 *     provider via `unregisterProvider()` + `registerProvider()` immediately.
 *   - `session_start` refresh — same re-sync on every subsequent session start
 *     (skips the initial `startup`/`reload` reasons, which already ran the
 *     factory), so the catalog stays current even if the command is never run.
 *     A failed background refresh only warns — the previous catalog is kept.
 */
export default async function (pi: ExtensionAPI): Promise<void> {
  const baseURL = (process.env.OMNIROUTE_BASE_URL ?? "").trim();
  const apiKey = process.env.OMNIROUTE_API_KEY ?? "";

  if (!baseURL && !apiKey) {
    notify(
      "warn",
      "[@omniroute/pi-agent] OMNIROUTE_BASE_URL / OMNIROUTE_API_KEY not set — " +
        "skipping catalog fetch (omniroute provider not registered)."
    );
    return;
  }

  // Either var alone is a config error — the fetcher's own guards throw loudly.
  const includeAutoCombos = autoCombosEnabled(process.env.OMNIROUTE_AUTO_COMBOS);
  const config = await buildOmniRouteProviderConfigFromCatalog(baseURL, apiKey, {
    includeAutoCombos,
  });
  pi.registerProvider("omniroute", config);
  notify(
    "info",
    `[@omniroute/pi-agent] registered "omniroute" provider with ${config.models!.length} models ` +
      `(baseUrl ${config.baseUrl})`
  );

  const resync = () =>
    resyncOmniRouteProvider({ pi, baseURL, apiKey, options: { includeAutoCombos } });

  pi.registerCommand("omniroute-sync", {
    description:
      "Re-fetch the OmniRoute catalog and re-register the omniroute provider (applies immediately, no restart).",
    handler: async () => {
      const fresh = await resync();
      notify(
        "info",
        `[@omniroute/pi-agent] re-synced "omniroute" provider: ${fresh.models!.length} models`
      );
    },
  });

  pi.on("session_start", (event) => {
    // The factory already fetched at startup; a reload re-runs the factory.
    // Refresh on subsequent session starts so the catalog stays current
    // without a restart, even if the operator never runs /omniroute-sync.
    if (event.reason === "startup" || event.reason === "reload") return;
    void resync().catch((err) => {
      notify(
        "warn",
        `[@omniroute/pi-agent] session-start re-sync failed (previous catalog kept): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    });
  });
}
