/**
 * Criteria proof for milestone 2.2 (raw entry → `ProviderModelConfig` mapping
 * + per-model wire protocol) and 2.3 (`effort_tiers` → `thinkingLevelMap` +
 * combos → plain entries with LCD roll-up):
 *
 *   - full-metadata entry maps exactly (no Pi defaults, no gap flag)
 *   - missing-metadata entry falls back to Pi defaults AND flags the gap in
 *     the model name — never silently misreported as measured
 *   - responses-format entry lands on the responses surface
 *   - base URL is normalized to a single `/v1` (no `/v1/v1/…` doubling)
 *   - tiered entry → exact `thinkingLevelMap` with `null` holes
 *   - tierless entry → NO `thinkingLevelMap` key (no synthesis)
 *   - combo entries → plain model entries with LCD roll-up, combos win over
 *     the pre-mirrored raw entry, hidden/unresolvable combos skipped
 *   - combo-fetch failure degrades gracefully (models still register)
 *
 * The stub-catalog test runs the real fetch → map → build pipeline against a
 * local HTTP server.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildOmniRouteProviderConfig,
  buildThinkingLevelMap,
  mapRawEntryToProviderModel,
  resolveApiFormat,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  GAP_SUFFIX,
  CHAT_API,
  RESPONSES_API,
} from "../src/map.js";
import { buildOmniRouteProviderConfigFromCatalog, autoCombosEnabled } from "../src/index.js";
import {
  mapComboToProviderModel,
  mapAutoComboToProviderModel,
  resolveComboMembers,
  comboProviderModelId,
  AUTO_COMBO_FALLBACK_CONTEXT,
  AUTO_COMBO_FALLBACK_OUTPUT,
} from "../src/combos.js";
import { defaultOmniRouteModelsFetcher, ensureV1ApiBaseUrl } from "../src/models.js";
import {
  startStubModelsServer,
  STUB_CATALOG,
  STUB_COMBOS,
  STUB_AUTO_COMBOS,
} from "./stub-server.js";

const [chatFull, metaMissing, respFull] = STUB_CATALOG;
const tiered = STUB_CATALOG.find((m) => m.id === "tiered-model")!;
const tierless = STUB_CATALOG.find((m) => m.id === "tierless-model")!;
const comboMirror = STUB_CATALOG.find((m) => m.id === "Combo Mixed")!;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const BASE = "http://gateway.example";

test("resolveApiFormat: responses→openai-responses, everything else→openai-completions", () => {
  assert.equal(resolveApiFormat("responses"), RESPONSES_API);
  assert.equal(resolveApiFormat("chat"), CHAT_API);
  assert.equal(resolveApiFormat(undefined), CHAT_API);
  assert.equal(resolveApiFormat("some-future-format"), CHAT_API);
});

test("full-metadata chat entry maps exactly (no gaps, no defaults)", () => {
  const model = mapRawEntryToProviderModel(chatFull, BASE);
  assert.equal(model.reasoning, true);
  assert.deepEqual(model.input, ["text", "image"]);
  assert.equal(model.contextWindow, 200_000);
  assert.equal(model.maxTokens, 16_384);
  assert.deepEqual(model.cost, ZERO_COST);
  assert.equal(model.api, CHAT_API);
  assert.equal(model.baseUrl, `${BASE}/v1`);
  assert.equal(model.name, "chat-full");
});

test("missing-metadata entry falls back to Pi defaults with a visible gap flag", () => {
  const model = mapRawEntryToProviderModel(metaMissing, BASE);
  // thinking capability still maps reasoning — capabilities are never defaulted.
  assert.equal(model.reasoning, true);
  assert.deepEqual(model.input, ["text"]);
  assert.equal(model.contextWindow, DEFAULT_CONTEXT_WINDOW);
  assert.equal(model.maxTokens, DEFAULT_MAX_TOKENS);
  assert.equal(model.api, CHAT_API);
  assert.equal(model.name, `meta-missing${GAP_SUFFIX}`);
});

test("responses-format entry hits the responses surface without a gap", () => {
  const model = mapRawEntryToProviderModel(respFull, BASE);
  assert.equal(model.api, RESPONSES_API);
  assert.equal(model.reasoning, false);
  assert.deepEqual(model.input, ["text"]);
  assert.equal(model.contextWindow, 1_000_000);
  assert.equal(model.maxTokens, 32_768);
  assert.equal(model.name, "resp-full");
});

test("baseUrl normalization never doubles /v1", () => {
  assert.equal(ensureV1ApiBaseUrl("http://host"), "http://host/v1");
  assert.equal(ensureV1ApiBaseUrl("http://host/v1"), "http://host/v1");
  assert.equal(ensureV1ApiBaseUrl("http://host/v1/"), "http://host/v1");
  assert.equal(ensureV1ApiBaseUrl("https://host/v2////"), "https://host/v2");
});

// ── 2.3: effort_tiers → thinkingLevelMap ───────────────────────────────────

test("buildThinkingLevelMap: declared tiers map, undeclared levels are null holes", () => {
  assert.deepEqual(buildThinkingLevelMap(["none", "low", "medium", "high"]), {
    off: "none",
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: null,
    max: null,
  });
});

test("buildThinkingLevelMap: full canonical vocabulary maps every level", () => {
  assert.deepEqual(buildThinkingLevelMap(["none", "low", "medium", "high", "xhigh", "max"]), {
    off: "none",
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
  });
});

test("tiered entry carries an exact thinkingLevelMap with null holes", () => {
  const model = mapRawEntryToProviderModel(tiered, BASE);
  assert.deepEqual(model.thinkingLevelMap, {
    off: "none",
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: null,
    max: null,
  });
});

test("tierless entry exposes NO thinkingLevelMap key (no synthesis)", () => {
  const model = mapRawEntryToProviderModel(tierless, BASE);
  assert.equal(model.thinkingLevelMap, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(model, "thinkingLevelMap"), false);
});

test("missing-metadata entry (no effort_tiers) exposes NO thinkingLevelMap key", () => {
  const model = mapRawEntryToProviderModel(metaMissing, BASE);
  assert.equal(model.thinkingLevelMap, undefined);
});

// ── 2.3: combos → plain entries with LCD roll-up ──────────────────────────

test("combo picker id is the NAME, never the opaque UUID /api/combos returns", async (t) => {
  // `/api/combos` reports an opaque UUID in `id`; `/v1/models` mirrors the
  // combo as a raw entry keyed by its NAME (`owned_by: "combo"`, no
  // `effort_tiers`). Keying the mapped entry by UUID would leave that map-less
  // mirror in the picker, and Pi's getSupportedThinkingLevels drops `xhigh` and
  // `max` for any model without an explicit thinkingLevelMap entry.
  assert.notEqual(STUB_COMBOS[0].id, STUB_COMBOS[0].name);
  assert.equal(comboProviderModelId(STUB_COMBOS[0]), "Combo Mixed");
  // Falls back to the id only when the server sends a blank/absent name.
  assert.equal(comboProviderModelId({ id: "uuid-only", name: "   " }), "uuid-only");

  const server = await startStubModelsServer();
  t.after(() => server.close());
  const config = await buildOmniRouteProviderConfigFromCatalog(server.baseURL, "test-key");
  const byId = new Map(config.models!.map((m) => [m.id, m]));

  // The name-keyed entry IS the rolled-up combo, and the UUID never becomes a
  // model id of its own (that would double-list the combo in the picker).
  assert.equal(byId.get("Combo Mixed")!.contextWindow, 64_000);
  assert.equal(byId.has(STUB_COMBOS[0].id), false);
});

test("combo LCD: mixed members advertise only what every member supports", () => {
  const members = resolveComboMembers(STUB_COMBOS[0], new Map(STUB_CATALOG.map((m) => [m.id, m])));
  // chat-full (reasoning, text+image) + tierless-model (reasoning, text)
  assert.deepEqual(
    members.map((m) => m.id),
    ["chat-full", "tierless-model"]
  );

  const combo = mapComboToProviderModel(STUB_COMBOS[0], members, BASE);
  // Pickable id = the combo NAME (what /v1/models mirrors), never the UUID.
  assert.equal(combo.id, "Combo Mixed");
  assert.equal(combo.name, "Combo Mixed");
  // reasoning: both members reason → true; image: only chat-full → dropped
  assert.equal(combo.reasoning, true);
  assert.deepEqual(combo.input, ["text"]);
  // LCD context/output: min across members
  assert.equal(combo.contextWindow, 64_000);
  assert.equal(combo.maxTokens, 8_192);
  // wire: both members are chat → chat surface
  assert.equal(combo.api, CHAT_API);
  assert.equal(combo.baseUrl, `${BASE}/v1`);
  // combos expose no thinking-level mapping
  assert.equal(combo.thinkingLevelMap, undefined);
});

test("combo union: a single non-reasoning member no longer strips reasoning (union, not LCD)", () => {
  const members = [chatFull, respFull]; // resp-full has reasoning: false
  const combo = mapComboToProviderModel(
    {
      id: "c",
      name: "C",
      models: [
        { kind: "model", model: "chat-full" },
        { kind: "model", model: "resp-full" },
      ],
    },
    members,
    BASE
  );
  // chat-full reasons → the combo reasons (ANY member).
  assert.equal(combo.reasoning, true);
  // resp-full is responses-format → not all members are → chat surface
  assert.equal(combo.api, CHAT_API);
  // LCD context: min(200_000, 1_000_000)
  assert.equal(combo.contextWindow, 200_000);
});

test("combo LCD: computed_context_length wins over member aggregation", () => {
  const combo = mapComboToProviderModel(
    {
      id: "c",
      name: "C",
      computed_context_length: 300_000,
      models: [{ kind: "model", model: "chat-full" }],
    },
    [chatFull],
    BASE
  );
  assert.equal(combo.contextWindow, 300_000);
});

// ── 6.1: combo thinking levels are UNIONED, not LCDed ──────────────────────

test("combo union: tiered + tierless member → reasoning true + union thinkingLevelMap", () => {
  // tiered-model (effort_tiers: none/low/medium/high) + tierless-model (no tiers).
  const members = [tiered, tierless];
  const combo = mapComboToProviderModel(
    {
      id: "c",
      name: "C",
      models: [
        { kind: "model", model: "tiered-model" },
        { kind: "model", model: "tierless-model" },
      ],
    },
    members,
    BASE
  );
  // reasoning: ANY member reasons → true (tierless member does not veto).
  assert.equal(combo.reasoning, true);
  // union map: only the tiered member's declared tiers, no null holes on the
  // union (tierless contributes nothing).
  assert.deepEqual(combo.thinkingLevelMap, {
    off: "none",
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: null,
    max: null,
  });
  // static caps stay LCD: min context/output across members.
  assert.equal(combo.contextWindow, 64_000);
  assert.equal(combo.maxTokens, 8_192);
});

test("combo union: all-tierless members → reasoning false + NO thinkingLevelMap key", () => {
  // resp-full: no effort_tiers AND no reasoning capability — a combo of
  // non-reasoning, tierless members exposes neither reasoning nor a map.
  const combo = mapComboToProviderModel(
    {
      id: "c",
      name: "C",
      models: [
        { kind: "model", model: "resp-full" },
        { kind: "model", model: "resp-full" },
      ],
    },
    [respFull, respFull],
    BASE
  );
  assert.equal(combo.reasoning, false);
  assert.equal(combo.thinkingLevelMap, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(combo, "thinkingLevelMap"), false);
});

test("combo union: empty members → unchanged (all-false, no map key)", () => {
  const combo = mapComboToProviderModel({ id: "c", name: "C", models: [] }, [], BASE);
  assert.equal(combo.reasoning, false);
  assert.equal(combo.thinkingLevelMap, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(combo, "thinkingLevelMap"), false);
  assert.deepEqual(combo.input, ["text"]);
});

test("combo member resolution drops unknown ids and combo-ref steps", () => {
  const byId = new Map(STUB_CATALOG.map((m) => [m.id, m]));
  assert.deepEqual(
    resolveComboMembers(
      {
        id: "x",
        models: [
          { kind: "model", model: "chat-full" },
          { kind: "model", model: "nope" },
        ],
      },
      byId
    ).map((m) => m.id),
    ["chat-full"]
  );
  assert.deepEqual(
    resolveComboMembers(
      {
        id: "x",
        models: [
          { kind: "combo-ref", comboName: "other" },
          { kind: "model", model: "resp-full" },
        ],
      },
      byId
    ).map((m) => m.id),
    ["resp-full"]
  );
});

test("auto combo: server limits used when present, positive fallbacks otherwise", () => {
  const withLimits = mapAutoComboToProviderModel(
    { id: "auto", name: "Auto", context_length: 1_000_000, max_output_tokens: 32_768 },
    BASE
  );
  assert.equal(withLimits.id, "auto");
  assert.equal(withLimits.contextWindow, 1_000_000);
  assert.equal(withLimits.maxTokens, 32_768);
  assert.equal(withLimits.reasoning, true);
  assert.equal(withLimits.api, CHAT_API);

  const bare = mapAutoComboToProviderModel({ id: "auto", name: "Auto" }, BASE);
  assert.equal(bare.contextWindow, AUTO_COMBO_FALLBACK_CONTEXT);
  assert.equal(bare.maxTokens, AUTO_COMBO_FALLBACK_OUTPUT);
});

// ── stub-catalog pipeline: fetch → map → build ────────────────────────────

test("stub-catalog pipeline: fetch → map → build composes correct surfaces", async (t) => {
  const server = await startStubModelsServer();
  t.after(() => server.close());

  const fetched = await defaultOmniRouteModelsFetcher(server.baseURL, "test-key");
  assert.equal(fetched.length, STUB_CATALOG.length);

  const config = buildOmniRouteProviderConfig(server.baseURL, fetched);
  assert.equal(config.baseUrl, `${server.baseURL}/v1`);
  assert.equal(config.baseUrl.includes("/v1/v1"), false);

  const byId = new Map(config.models!.map((m) => [m.id, m]));
  assert.equal(byId.size, STUB_CATALOG.length);

  const chat = byId.get("chat-full")!;
  assert.equal(chat.api, CHAT_API);
  assert.equal(chat.name, "chat-full");
  assert.equal(new URL(`${chat.baseUrl}/chat/completions`).pathname, "/v1/chat/completions");

  const missing = byId.get("meta-missing")!;
  assert.equal(missing.api, CHAT_API);
  assert.equal(missing.name, `meta-missing${GAP_SUFFIX}`);
  assert.equal(new URL(`${missing.baseUrl}/chat/completions`).pathname, "/v1/chat/completions");

  const resp = byId.get("resp-full")!;
  assert.equal(resp.api, RESPONSES_API);
  assert.equal(resp.name, "resp-full");
  assert.equal(new URL(`${resp.baseUrl}/responses`).pathname, "/v1/responses");
  assert.equal(new URL(`${resp.baseUrl}/chat/completions`).pathname, "/v1/chat/completions");

  for (const m of config.models!) assert.equal(m.baseUrl.includes("/v1/v1"), false);
});

test("orchestrator: full catalog — models + combos (LCD, wins over mirror) + auto combos", async (t) => {
  const server = await startStubModelsServer();
  t.after(() => server.close());

  const config = await buildOmniRouteProviderConfigFromCatalog(server.baseURL, "test-key", {
    includeAutoCombos: true,
  });
  const byId = new Map(config.models!.map((m) => [m.id, m]));

  // 6 raw models + "Combo Mixed" (replaces its pre-mirror) + auto = 7 entries.
  assert.equal(byId.size, STUB_CATALOG.length + 1);

  // combo wins over the pre-mirrored raw entry: LCD context (64k) not mirror (50k).
  const combo = byId.get("Combo Mixed")!;
  assert.equal(combo.name, "Combo Mixed");
  assert.equal(combo.contextWindow, 64_000);
  assert.equal(combo.reasoning, true);
  assert.deepEqual(combo.input, ["text"]);

  // auto combo present with server limits.
  const auto = byId.get("auto")!;
  assert.equal(auto.contextWindow, 1_000_000);
  assert.equal(auto.maxTokens, 32_768);
  assert.equal(auto.reasoning, true);

  // hidden + unresolvable combos are skipped.
  assert.equal(byId.has("combo-hidden"), false);
  assert.equal(byId.has("combo-unresolvable"), false);
  assert.equal(byId.has("auto/coding"), false);
});

test("orchestrator: auto combos are DROPPED by default — no fetch, mirrors filtered", async (t) => {
  const server = await startStubModelsServer();
  t.after(() => server.close());

  let autoFetches = 0;
  const autoMirror = {
    id: "auto/coding",
    owned_by: "combo",
    context_length: 400_000,
    max_output_tokens: 8_192,
    capabilities: { tool_calling: true, reasoning: true, thinking: true },
    api_format: "chat",
  };

  const config = await buildOmniRouteProviderConfigFromCatalog(server.baseURL, "test-key", {
    models: async () => [...STUB_CATALOG, autoMirror],
    autoCombos: async () => {
      autoFetches += 1;
      return STUB_AUTO_COMBOS;
    },
  });
  const byId = new Map(config.models!.map((m) => [m.id, m]));

  // The startup fetch is skipped outright — not merely discarded. That matters:
  // /api/combos/auto is awaited during Pi boot and takes seconds to answer.
  assert.equal(autoFetches, 0);
  // Neither the auto combo nor its /v1/models mirror survives the drop...
  assert.equal(byId.has("auto"), false);
  assert.equal(byId.has("auto/coding"), false);
  // ...while named combos are untouched.
  assert.equal(byId.get("Combo Mixed")!.contextWindow, 64_000);
  assert.equal(byId.get("chat-full")!.name, "chat-full");
});

test("orchestrator: includeAutoCombos registers them and keeps their mirrors", async (t) => {
  const server = await startStubModelsServer();
  t.after(() => server.close());

  const autoMirror = {
    id: "auto/coding",
    owned_by: "combo",
    context_length: 400_000,
    max_output_tokens: 8_192,
    capabilities: { tool_calling: true, reasoning: true, thinking: true },
    api_format: "chat",
  };

  const config = await buildOmniRouteProviderConfigFromCatalog(server.baseURL, "test-key", {
    models: async () => [...STUB_CATALOG, autoMirror],
    includeAutoCombos: true,
  });
  const byId = new Map(config.models!.map((m) => [m.id, m]));

  assert.equal(byId.has("auto"), true);
  // `auto/coding` is hidden in /api/combos/auto, so its raw mirror is what
  // remains registered for that id.
  assert.equal(byId.get("auto/coding")!.contextWindow, 400_000);
});

test("autoCombosEnabled: only on/true/1/yes opt in — unset drops them", () => {
  for (const raw of [undefined, "", "   ", "off", "false", "0", "no", "nope"]) {
    assert.equal(autoCombosEnabled(raw), false, `${JSON.stringify(raw)} must not enable auto combos`);
  }
  for (const raw of ["on", "ON", " true ", "1", "yes"]) {
    assert.equal(autoCombosEnabled(raw), true, `${JSON.stringify(raw)} must enable auto combos`);
  }
});

test("orchestrator: combo-fetch failure degrades gracefully — models still register", async (t) => {
  const server = await startStubModelsServer();
  t.after(() => server.close());

  const config = await buildOmniRouteProviderConfigFromCatalog(server.baseURL, "test-key", {
    combos: async () => {
      throw new Error("boom");
    },
  });
  const byId = new Map(config.models!.map((m) => [m.id, m]));

  // All raw models register; no combo entries (the pre-mirror stays as-is).
  assert.equal(byId.size, STUB_CATALOG.length);
  assert.equal(byId.get("chat-full")!.name, "chat-full");
  assert.equal(byId.get("tiered-model")!.reasoning, true);
  // "Combo Mixed" remains the raw mirror (no LCD roll-up overlay).
  assert.equal(byId.get("Combo Mixed")!.name, "Combo Mixed");
  assert.equal(byId.get("Combo Mixed")!.contextWindow, 50_000);
  assert.equal(byId.get("Combo Mixed")!.thinkingLevelMap, undefined);
  assert.equal(byId.has("auto"), false);
});

test("orchestrator: models fetch failure is LOUD (never a silent empty list)", async (t) => {
  const server = await startStubModelsServer();
  t.after(() => server.close());

  await assert.rejects(
    buildOmniRouteProviderConfigFromCatalog(server.baseURL, "test-key", {
      models: async () => {
        const err = new Error("models down") as Error & { status: number };
        err.status = 500;
        throw err;
      },
    }),
    /models down/
  );
});

test("compat: every mapped entry sends the pin-readable session header", async (t) => {
  // `sessionAffinityFormat: "openrouter"` is load-bearing, not decorative:
  // Pi's openai-completions path only emits `x-session-id` — the ONE header
  // OmniRoute's extractSessionAffinityKey actually reads for account pinning —
  // under the "openrouter" format. The default "openai" format emits
  // `x-session-affinity` / `x-client-request-id` / `session_id`, which
  // OmniRoute ignores for pinning (the first only feeds the opencode executor
  // synthesis), so "on" without "openrouter" still falls back to hashing the
  // first input text.
  // OmniRoute derives its session-affinity key from client session headers;
  // without the flag Pi sends none and OmniRoute falls back to hashing the
  // first input text — a key that changes every turn and defeats account
  // pinning. Only Pi's openai-completions path reads the flag, which is the
  // api every OmniRoute model resolves to (the other option, openai-responses,
  // has no affinity headers).
  const server = await startStubModelsServer();
  t.after(() => server.close());

  const config = await buildOmniRouteProviderConfigFromCatalog(server.baseURL, "test-key");
  const without = config.models!.filter(
    (m) => m.compat?.sendSessionAffinityHeaders !== true || m.compat?.sessionAffinityFormat !== "openrouter"
  );
  assert.deepEqual(
    without.map((m) => m.id),
    [],
    `every registered model must carry sendSessionAffinityHeaders + openrouter format; missing: ${without.map((m) => m.id).join(", ")}`
  );

  // Raw mapping path too (a bare entry, not just orchestrator output).
  const mapped = mapRawEntryToProviderModel(STUB_CATALOG[0], BASE).compat;
  assert.equal(mapped?.sendSessionAffinityHeaders, true);
  assert.equal(mapped?.sessionAffinityFormat, "openrouter");
  const comboMapped = mapComboToProviderModel(STUB_COMBOS[0], [chatFull, tierless], BASE).compat;
  assert.equal(comboMapped?.sendSessionAffinityHeaders, true);
  assert.equal(comboMapped?.sessionAffinityFormat, "openrouter");
});
