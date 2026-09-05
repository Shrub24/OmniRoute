/**
 * Criteria proof for milestone 4.1 (regression hardening of the mapping +
 * registration surface):
 *
 *   - Pi dependency versions are PINNED: the installed `pi-coding-agent` /
 *     `pi-server` versions must equal the exact devDependency pins in
 *     `package.json`. Pi is pre-1.0 with weekly API churn, so a drifted
 *     `node_modules` would silently test against a different surface than the
 *     extension targets — this guard fails loudly instead.
 *   - No-synthesis: across EVERY entry the factory registers (models, combos,
 *     auto combos), only the server-declared-tiered model carries a
 *     `thinkingLevelMap`; tierless / metadata-missing / responses / combo /
 *     auto entries expose NO mapping key.
 *   - Registration shape: every registered entry has a valid Pi `api` wire
 *     protocol and a base URL normalized to exactly one `/v1` (anti
 *     `/v1/v1` regression); registered ids are unique; combo-derived ids never
 *     shadow a genuine model id (a combo named like a real model would
 *     silently replace it via the id-keyed map).
 *   - The re-sync entry point (`resyncOmniRouteProvider`) and the env-ref
 *     constant (`PROVIDER_API_KEY_ENV_REF`) are exported and stable.
 *
 * All tests are stub-local (loopback HTTP, no external network).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  buildOmniRouteProviderConfigFromCatalog,
  resyncOmniRouteProvider,
  PROVIDER_API_KEY_ENV_REF,
} from "../src/index.js";
import { CHAT_API, RESPONSES_API, GAP_SUFFIX } from "../src/map.js";
import { startStubModelsServer, STUB_CATALOG } from "./stub-server.js";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(pkgRoot, rel), "utf8")) as Record<string, unknown>;
}

// ── 4.1: Pi version pins ─────────────────────────────────────────────────────

test("Pi dependency versions are pinned: installed === package.json devDependency pins", () => {
  const devDeps = (readJson("package.json").devDependencies ?? {}) as Record<string, string>;
  const pins: Record<string, string> = {
    "@earendil-works/pi-coding-agent": devDeps["@earendil-works/pi-coding-agent"],
    "@earendil-works/pi-server": devDeps["@earendil-works/pi-server"],
  };

  for (const [name, pin] of Object.entries(pins)) {
    assert.ok(pin, `${name} must be pinned (exact) in package.json devDependencies`);
    assert.ok(/^\d+\.\d+\.\d+$/.test(pin), `${name} pin must be exact (no range): ${pin}`);
    const installed = readJson(`node_modules/${name}/package.json`).version;
    assert.equal(
      installed,
      pin,
      `${name} installed version ${String(installed)} drifted from package.json pin ${pin} — ` +
        "re-pin and re-verify the mapping/boot against the new Pi API surface"
    );
  }
});

// ── 4.1: no-synthesis across the full registered catalog ────────────────────

test("no-synthesis: only the tiered model carries thinkingLevelMap across every registered entry", async (t) => {
  const server = await startStubModelsServer();
  t.after(() => server.close());

  const config = await buildOmniRouteProviderConfigFromCatalog(server.baseURL, "test-key");

  const withMap = config.models!.filter((m) =>
    Object.prototype.hasOwnProperty.call(m, "thinkingLevelMap")
  );
  assert.deepEqual(
    withMap.map((m) => m.id),
    ["tiered-model"]
  );

  const tiered = config.models!.find((m) => m.id === "tiered-model")!;
  assert.deepEqual(tiered.thinkingLevelMap, {
    off: "none",
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: null,
    max: null,
  });

  // Every non-tiered entry — tierless, metadata-missing, responses, combo,
  // auto combo — exposes NO mapping key (never a synthesized one).
  for (const m of config.models!) {
    if (m.id === "tiered-model") continue;
    assert.equal(
      Object.prototype.hasOwnProperty.call(m, "thinkingLevelMap"),
      false,
      `${m.id} must not carry a synthesized thinkingLevelMap`
    );
  }
});

// ── 4.1: registration shape ─────────────────────────────────────────────────

test("registration shape: every entry has a valid api and exactly-one-/v1 baseUrl; ids are unique", async (t) => {
  const server = await startStubModelsServer();
  t.after(() => server.close());

  const config = await buildOmniRouteProviderConfigFromCatalog(server.baseURL, "test-key");

  // Provider-level base URL is the /v1 API root.
  assert.equal(new URL(config.baseUrl).pathname, "/v1");

  const ids = config.models!.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, "registered ids must be unique");

  for (const m of config.models!) {
    assert.ok(
      m.api === CHAT_API || m.api === RESPONSES_API,
      `${m.id}: api must be a Pi wire protocol, got ${String(m.api)}`
    );
    const path = new URL(m.baseUrl).pathname;
    assert.equal(path, "/v1", `${m.id}: baseUrl must be exactly one /v1, got ${m.baseUrl}`);
    assert.equal(m.baseUrl.includes("/v1/v1"), false, `${m.id}: /v1/v1 doubling`);
  }
});

test("combo ids never shadow genuine model ids (no silent replacement)", async (t) => {
  const server = await startStubModelsServer();
  t.after(() => server.close());

  const config = await buildOmniRouteProviderConfigFromCatalog(server.baseURL, "test-key", {
    includeAutoCombos: true,
  });
  const byId = new Map(config.models!.map((m) => [m.id, m]));

  const genuineIds = STUB_CATALOG.filter((m) => m.owned_by !== "combo").map((m) => m.id);
  const comboIds = ["Combo Mixed", "auto"];

  // Combo-derived ids are not genuine model ids.
  for (const id of comboIds) {
    assert.equal(
      genuineIds.includes(id),
      false,
      `${id} is a combo id and must not collide with a genuine model id`
    );
  }

  // Every genuine model is still registered under its own identity (name ===
  // id, or id + gap suffix) — a combo with the same id would have silently
  // replaced it via the id-keyed map.
  for (const id of genuineIds) {
    const entry = byId.get(id);
    assert.ok(entry, `genuine model ${id} must be registered`);
    assert.ok(
      entry!.name === id || entry!.name === `${id}${GAP_SUFFIX}`,
      `genuine model ${id} was shadowed — name is ${entry!.name}`
    );
  }

  // The combo entries are present as plain model entries under the single provider.
  assert.equal(byId.get("Combo Mixed")!.name, "Combo Mixed");
  assert.equal(byId.has("auto"), true);
});

// ── 4.1: re-sync export + env-ref constant ──────────────────────────────────

test("re-sync entry point and env-ref constant are exported and stable", async (t) => {
  const server = await startStubModelsServer();
  t.after(() => server.close());

  // Direct export-surface assertions (regression: someone renames/removes the
  // re-sync hook or the env-ref form).
  assert.equal(typeof resyncOmniRouteProvider, "function");
  assert.equal(PROVIDER_API_KEY_ENV_REF, "$OMNIROUTE_API_KEY");

  // The full-catalog config carries the env-ref apiKey form (/login-visible).
  const config = await buildOmniRouteProviderConfigFromCatalog(server.baseURL, "test-key");
  assert.equal(config.apiKey, PROVIDER_API_KEY_ENV_REF);
});
