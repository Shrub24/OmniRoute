/**
 * Stub OmniRoute catalog server for tests + the live-boot check.
 *
 * Serves the catalog shape this milestone targets:
 *   - one full-metadata chat-format entry
 *   - one metadata-missing entry (worst case for defaults + visible gaps)
 *   - one responses-format entry (wire-protocol decision)
 *   - one tiered entry (server-declared `effort_tiers` → `thinkingLevelMap`)
 *   - one tierless entry (no mapping key)
 *   - `/api/combos` + `/api/combos/auto` (LCD roll-up + auto-combo entries)
 */

import { createServer, type Server } from "node:http";

import type { OmniRouteRawCombo, OmniRouteRawAutoCombo } from "../src/combos.js";
import type { OmniRouteRawModelEntry } from "../src/models.js";

export interface StubModelsServer {
  baseURL: string;
  close(): Promise<void>;
  /** Last `/v1/chat/completions` request body (for wire-protocol assertions). */
  lastChatBody(): Record<string, unknown> | null;
  /** All `/v1/chat/completions` request bodies in arrival order (multi-turn wire assertions). */
  chatBodies(): Array<Record<string, unknown>>;
  /** Last `/v1/chat/completions` Authorization header (for auth-flow assertions). */
  lastAuthHeader(): string | null;
  /** Replace the served `/v1/models` catalog (simulates the server's model list changing). */
  setCatalog(catalog: OmniRouteRawModelEntry[]): void;
}

export const STUB_CATALOG: OmniRouteRawModelEntry[] = [
  {
    id: "chat-full",
    owned_by: "test",
    context_length: 200_000,
    max_input_tokens: 190_000,
    max_output_tokens: 16_384,
    input_modalities: ["text", "image"],
    output_modalities: ["text"],
    capabilities: {
      tool_calling: true,
      reasoning: true,
      vision: true,
      thinking: false,
    },
    api_format: "chat",
  },
  {
    id: "meta-missing",
    owned_by: "test",
    capabilities: { thinking: true },
    api_format: "chat",
  },
  {
    id: "resp-full",
    owned_by: "test",
    context_length: 1_000_000,
    max_input_tokens: 900_000,
    max_output_tokens: 32_768,
    input_modalities: ["text"],
    output_modalities: ["text"],
    capabilities: {
      tool_calling: false,
      reasoning: false,
      vision: false,
      thinking: false,
    },
    api_format: "responses",
  },
  {
    id: "tiered-model",
    owned_by: "test",
    context_length: 128_000,
    max_input_tokens: 128_000,
    max_output_tokens: 16_384,
    input_modalities: ["text"],
    output_modalities: ["text"],
    capabilities: {
      tool_calling: true,
      reasoning: true,
      thinking: true,
      effort_tiers: ["none", "low", "medium", "high"],
    },
    api_format: "chat",
  },
  {
    id: "tierless-model",
    owned_by: "test",
    context_length: 64_000,
    max_input_tokens: 64_000,
    max_output_tokens: 8_192,
    input_modalities: ["text"],
    output_modalities: ["text"],
    capabilities: {
      tool_calling: true,
      reasoning: true,
      thinking: true,
    },
    api_format: "chat",
  },
  {
    // Pre-mirrored combo entry: `/v1/models` advertises combos as raw entries
    // keyed by the combo's NAME (`owned_by: "combo"`, no `effort_tiers`). The
    // `/api/combos` entry — whose `id` is an opaque UUID — must still WIN over
    // this mirror via its name-derived id (richer LCD roll-up + unioned
    // thinkingLevelMap).
    id: "Combo Mixed",
    owned_by: "combo",
    context_length: 50_000,
    max_input_tokens: 50_000,
    max_output_tokens: 4_096,
    input_modalities: ["text", "image"],
    output_modalities: ["text"],
    capabilities: {
      tool_calling: true,
      reasoning: true,
      vision: true,
      thinking: false,
    },
    api_format: "chat",
  },
];

export const STUB_COMBOS: OmniRouteRawCombo[] = [
  {
    // Real `/api/combos` shape: opaque UUID id, human name — and the name is
    // what `/v1/models` mirrors the combo under.
    id: "3d1f0b7a-9c2e-4a55-8f3b-2b6f0c9a1e77",
    name: "Combo Mixed",
    strategy: "priority",
    models: [
      { kind: "model", model: "chat-full", weight: 50 },
      { kind: "model", model: "tierless-model", weight: 50 },
    ],
  },
  {
    id: "combo-hidden",
    name: "Combo Hidden",
    isHidden: true,
    models: [{ kind: "model", model: "chat-full" }],
  },
  {
    id: "combo-unresolvable",
    name: "Combo Unresolvable",
    models: [{ kind: "model", model: "no-such-model" }],
  },
];

export const STUB_AUTO_COMBOS: OmniRouteRawAutoCombo[] = [
  { id: "auto", name: "Auto", context_length: 1_000_000, max_output_tokens: 32_768 },
  { id: "auto/coding", name: "Auto Coding", isHidden: true },
];

/**
 * Catalog v2 for the mid-session re-sync test: a server-side change that a
 * re-sync must pick up without a restart. Adds a brand-new model and bumps an
 * existing one's context window (so the test can assert both an added id and a
 * changed value, not just a count).
 */
export const STUB_CATALOG_V2: OmniRouteRawModelEntry[] = [
  ...STUB_CATALOG.map((m) => (m.id === "chat-full" ? { ...m, context_length: 250_000 } : m)),
  {
    id: "v2-only-model",
    owned_by: "test",
    context_length: 32_000,
    max_input_tokens: 32_000,
    max_output_tokens: 4_096,
    input_modalities: ["text"],
    output_modalities: ["text"],
    capabilities: { tool_calling: false, reasoning: false, vision: false, thinking: false },
    api_format: "chat",
  },
];

/** Boot an HTTP server on an ephemeral loopback port serving the catalog. */
export function startStubModelsServer(
  catalog: OmniRouteRawModelEntry[] = STUB_CATALOG,
  combos: OmniRouteRawCombo[] = STUB_COMBOS,
  autoCombos: OmniRouteRawAutoCombo[] = STUB_AUTO_COMBOS
): Promise<StubModelsServer> {
  let currentCatalog = catalog;
  let lastChatBody: Record<string, unknown> | null = null;
  const chatBodies: Array<Record<string, unknown>> = [];
  let lastAuthHeader: string | null = null;
  const server: Server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: currentCatalog }));
      return;
    }
    if (req.method === "GET" && req.url === "/api/combos") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ combos }));
      return;
    }
    if (req.method === "GET" && req.url === "/api/combos/auto") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ combos: autoCombos }));
      return;
    }
    // Minimal SSE chat-completion so a real `pi --print` turn can complete
    // against the stub (proves the chat wire protocol end-to-end). Emits a
    // content delta, then a proper `finish_reason: "stop"` chunk, then [DONE].
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      console.error(`[stub] POST ${req.url}`);
      lastAuthHeader = req.headers.authorization ?? null;
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        try {
          lastChatBody = JSON.parse(body) as Record<string, unknown>;
          chatBodies.push(lastChatBody);
        } catch {
          lastChatBody = null;
        }
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(
          'data: {"id":"stub-1","object":"chat.completion.chunk","created":1,"model":"chat-full","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}\n\n'
        );
        res.write(
          'data: {"id":"stub-1","object":"chat.completion.chunk","created":1,"model":"chat-full","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
        );
        res.end("data: [DONE]\n\n");
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr !== "object" || addr === null) {
        reject(new Error("stub server: no address"));
        return;
      }
      resolve({
        baseURL: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((done) => server.close(() => done())),
        lastChatBody: () => lastChatBody,
        chatBodies: () => chatBodies,
        lastAuthHeader: () => lastAuthHeader,
        setCatalog: (next) => {
          currentCatalog = next;
        },
      });
    });
  });
}
