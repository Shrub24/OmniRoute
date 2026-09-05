/**
 * Criteria proof for milestone 3.1 (auth via Pi's `registerProvider` apiKey
 * form + mid-session re-sync):
 *
 *   - registration carries the apiKey form (`$OMNIROUTE_API_KEY` env ref —
 *     Pi resolves it at request time and surfaces the "API key" login in
 *     `/login`), with catalog-fetch credentials kept on the separate env var
 *   - `buildOmniRouteProviderConfig` plumbs a caller-supplied apiKey through
 *     and omits the key when none is given
 *   - the re-sync entry point applies a server-side catalog change (v1 → v2)
 *     mid-session via `unregisterProvider()` + `registerProvider()` — the
 *     provider's model list reflects the fresh catalog without a restart
 *   - a failed re-sync never unregisters the previously registered provider
 *     (safe ordering: fetch before unregister)
 *
 * `/login` visibility itself is exercised live against the pinned Pi 0.85.0
 * binary in `boot-auth.mts` (env-resolved `$OMNIROUTE_API_KEY` reaches the
 * gateway as `Authorization: Bearer …` with no CLI flag involved); these unit
 * tests pin the config shape the boot depends on.
 */

import test from "node:test";
import assert from "node:assert/strict";

import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { buildOmniRouteProviderConfig } from "../src/map.js";
import { PROVIDER_API_KEY_ENV_REF } from "../src/map.js";
import { buildOmniRouteProviderConfigFromCatalog, resyncOmniRouteProvider } from "../src/index.js";
import type { OmniRoutePiAgentResyncDeps } from "../src/index.js";
import { startStubModelsServer, STUB_CATALOG, STUB_CATALOG_V2 } from "./stub-server.js";

const BASE = "http://gateway.example";

/** Records `registerProvider` / `unregisterProvider` calls like Pi's runner would. */
function makePiRecorder(): {
  calls: Array<{ kind: "register" | "unregister"; name: string; config?: ProviderConfig }>;
  pi: OmniRoutePiAgentResyncDeps["pi"];
} {
  const calls: Array<{ kind: "register" | "unregister"; name: string; config?: ProviderConfig }> =
    [];
  return {
    calls,
    pi: {
      registerProvider: (name: string, config: ProviderConfig) => {
        calls.push({ kind: "register", name, config });
      },
      unregisterProvider: (name: string) => {
        calls.push({ kind: "unregister", name });
      },
    },
  };
}

// ── 3.1: registration carries the apiKey form ──────────────────────────────

test("registration carries the apiKey form ($OMNIROUTE_API_KEY env ref, /login-visible)", async (t) => {
  const server = await startStubModelsServer();
  t.after(() => server.close());

  const config = await buildOmniRouteProviderConfigFromCatalog(server.baseURL, "test-key");
  // Pi apiKey form = `$ENV_VAR` env interpolation: Pi resolves it at request
  // time and surfaces the provider's "API key" login in `/login`.
  assert.equal(config.apiKey, PROVIDER_API_KEY_ENV_REF);
  assert.equal(config.apiKey, "$OMNIROUTE_API_KEY");
  assert.equal(config.apiKey?.startsWith("$"), true);
});

test("buildOmniRouteProviderConfig plumbs a supplied apiKey and omits the key otherwise", () => {
  const withKey = buildOmniRouteProviderConfig(BASE, STUB_CATALOG, [], "custom-key");
  assert.equal(withKey.apiKey, "custom-key");

  const bare = buildOmniRouteProviderConfig(BASE, STUB_CATALOG);
  assert.equal(bare.apiKey, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(bare, "apiKey"), false);
});

// ── 3.1: mid-session re-sync applies a changed catalog ─────────────────────

test("re-sync applies a changed catalog mid-session (v1 → v2) without restart", async (t) => {
  const server = await startStubModelsServer();
  t.after(() => server.close());

  // Initial registration reflects v1.
  const initial = await buildOmniRouteProviderConfigFromCatalog(server.baseURL, "test-key");
  const initialById = new Map(initial.models!.map((m) => [m.id, m]));
  assert.equal(initialById.has("v2-only-model"), false);
  assert.equal(initialById.get("chat-full")!.contextWindow, 200_000);

  // The server's catalog changes (no Pi restart, no /reload).
  server.setCatalog(STUB_CATALOG_V2);

  // Re-sync applies it via unregister + re-register, immediately.
  const recorder = makePiRecorder();
  const fresh = await resyncOmniRouteProvider({
    pi: recorder.pi,
    baseURL: server.baseURL,
    apiKey: "test-key",
  });

  assert.deepEqual(
    recorder.calls.map((c) => c.kind),
    ["unregister", "register"]
  );
  assert.equal(recorder.calls[0]!.name, "omniroute");
  assert.equal(recorder.calls[1]!.name, "omniroute");

  const registered = recorder.calls[1]!.config!;
  assert.equal(registered, fresh);
  // The provider's model list reflects the fresh catalog in the same session.
  const byId = new Map(registered.models!.map((m) => [m.id, m]));
  assert.equal(byId.size, initialById.size + 1);
  assert.equal(byId.has("v2-only-model"), true);
  assert.equal(byId.get("v2-only-model")!.contextWindow, 32_000);
  // Changed metadata is re-mapped too, not just added ids.
  assert.equal(byId.get("chat-full")!.contextWindow, 250_000);
  // Re-registration keeps the apiKey form.
  assert.equal(registered.apiKey, PROVIDER_API_KEY_ENV_REF);
});

test("re-sync failure leaves the previous provider intact (no unregister)", async (t) => {
  const server = await startStubModelsServer();
  t.after(() => server.close());

  const recorder = makePiRecorder();
  await assert.rejects(
    resyncOmniRouteProvider({
      pi: recorder.pi,
      baseURL: server.baseURL,
      apiKey: "test-key",
      options: {
        models: async () => {
          const err = new Error("models down") as Error & { status: number };
          err.status = 500;
          throw err;
        },
      },
    }),
    /models down/
  );

  // Fetch happens before unregister: a failed re-sync must never tear down
  // the currently registered provider.
  assert.deepEqual(recorder.calls, []);
});
