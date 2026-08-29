/**
 * CheaperInference live text-model catalogue
 * (openspec change: cheaperinference-live-model-catalogue, task 2.1).
 *
 * Locks the four spec scenarios on the REAL chain — no stubbed metadata:
 *   live /v1/models payload → parseCheaperInferenceTextModels → persistDiscoveredModels
 *   (synced metadata) → getModelInfo → chatCore target-format resolution →
 *   resolveExecutionCredentials → CheaperInferenceExecutor (URL + store:false).
 *
 * DB harness mirrors tests/unit/synced-effort-suffix-learned-validation.test.ts
 * (temp DATA_DIR + createProviderConnection + persistDiscoveredModels + getModelInfo).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-cinf-live-catalogue-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "cinf-live-test-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const modelsDb = await import("../../src/lib/db/models.ts");
const modelDiscovery = await import("../../src/lib/providerModels/modelDiscovery.ts");
const { getModelInfo } = await import("../../src/sse/services/model.ts");
const { PROVIDER_MODELS_CONFIG, parseCheaperInferenceTextModels } =
  await import("../../src/app/api/providers/[id]/models/discovery/providerModelsConfig.ts");
const { resolveChatCoreTargetFormat } =
  await import("../../open-sse/handlers/chatCore/targetFormat.ts");
const { resolveExecutionCredentials } =
  await import("../../open-sse/handlers/chatCore/executionCredentials.ts");
const { CheaperInferenceExecutor } = await import("../../open-sse/executors/cheaperinference.ts");

const PROVIDER = "cheaperinference";
const RESPONSES = "openai-responses";
const CHAT = "openai";
const CHAT_URL = "https://api.cheaperinference.com/v1/chat/completions";
const RESPONSES_URL = "https://api.cheaperinference.com/v1/responses";

const executor = new CheaperInferenceExecutor();

/** One entry of the gateway's `GET /v1/models?type=text` payload. */
function liveModel(
  id: string,
  endpoint: string,
  capabilities: Record<string, boolean> = { vision: true, reasoning: true, tools: true }
) {
  return {
    id,
    object: "model",
    owned_by: "cheaperinference",
    type: "text",
    endpoint,
    capabilities,
  };
}

/**
 * Replay chatCore's order for one model: resolve the wire format from the runtime
 * metadata, build the execution credentials from it, then ask the executor what it
 * would actually send. Asserting the outcome (not the context key) keeps this test
 * valid however the execution context carries the resolved format.
 */
function route(model: string, modelInfo: Record<string, unknown>) {
  const { targetFormat } = resolveChatCoreTargetFormat({
    provider: PROVIDER,
    resolvedModel: model,
    apiFormat: typeof modelInfo.apiFormat === "string" ? modelInfo.apiFormat : undefined,
    customModelTargetFormat:
      typeof modelInfo.targetFormat === "string" ? modelInfo.targetFormat : undefined,
    providerSpecificData: {},
  });
  const credentials = resolveExecutionCredentials({
    credentials: { apiKey: "ir_live_test", providerSpecificData: {} },
    nativeCodexPassthrough: false,
    endpointPath: targetFormat === RESPONSES ? "/v1/responses" : "/v1/chat/completions",
    targetFormat,
    provider: PROVIDER,
    ccSessionId: null,
    modelInfo: { model, ...modelInfo },
  }) as never;
  return {
    targetFormat,
    url: executor.buildUrl(model, false, 0, credentials),
    body: executor.transformRequest(
      model,
      { model, messages: [{ role: "user", content: "hi" }] },
      false,
      credentials
    ) as Record<string, unknown>,
  };
}

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

let connectionId = "";

async function seedSynced(models: unknown[]) {
  const parsed = PROVIDER_MODELS_CONFIG[PROVIDER].parseResponse?.({ data: models }) ?? [];
  await modelDiscovery.persistDiscoveredModels(PROVIDER, connectionId, parsed);
}

test.beforeEach(async () => {
  await resetStorage();
  const connection = await providersDb.createProviderConnection({
    provider: PROVIDER,
    authType: "apikey",
    name: "cinf-live-catalogue",
    apiKey: "ir_live_test",
    isActive: true,
    testStatus: "active",
  });
  connectionId = connection.id;
});

test.after(async () => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// --- Requirement: Discover CheaperInference text models -----------------------

test("parses the authenticated live text catalogue", () => {
  const config = PROVIDER_MODELS_CONFIG[PROVIDER];
  assert.equal(config.url, "https://api.cheaperinference.com/v1/models?type=text");
  assert.equal(config.authHeader, "Authorization");
  assert.equal(config.authPrefix, "Bearer ");
  assert.equal(typeof config.parseResponse, "function");
  const parsed = config.parseResponse?.({
    data: [
      liveModel("r1", "responses"),
      liveModel("c1", "chat/completions"),
      { id: "i1", type: "image", endpoint: "images/generations" },
    ],
  });

  assert.deepEqual(
    parsed.map((m) => m.id),
    ["r1", "c1"],
    "text models only — image entries and blank ids are not part of the text catalogue"
  );
  assert.equal(parsed[0].targetFormat, RESPONSES);
  assert.equal(
    parsed[1].targetFormat,
    undefined,
    "chat must stay untagged — never infer a protocol the provider did not declare"
  );
  // Capabilities are mirrored onto the fields normalizeDiscoveredModels persists.
  assert.equal(parsed[0].supportsVision, true);
  assert.equal(parsed[0].supportsThinking, true);
  assert.equal(parsed[0].supportsTools, true);
  assert.equal(parsed[0].name, "r1", "name defaults to the id when upstream sends none");
});

test("live-only Responses model uses the Responses execution path with store:false", async () => {
  await seedSynced([liveModel("live-only-responses-x", "responses")]);
  const info = await getModelInfo(`${PROVIDER}/live-only-responses-x`);

  const routed = route("live-only-responses-x", info);
  assert.equal(routed.targetFormat, RESPONSES);
  assert.equal(routed.url, RESPONSES_URL);
  assert.equal(routed.body.store, false, "stateless endpoint 400s without store:false");
});

test("live-only Chat model uses the Chat Completions execution path", async () => {
  await seedSynced([liveModel("live-only-chat-y", "chat/completions")]);
  const info = await getModelInfo(`${PROVIDER}/live-only-chat-y`);

  const routed = route("live-only-chat-y", info);
  assert.equal(routed.targetFormat, CHAT);
  assert.equal(routed.url, CHAT_URL);
  assert.ok(!("store" in routed.body), "chat/completions rejects unknown params");
});

test("discovery failure keeps the static registry snapshot as the fallback", async () => {
  // No synced rows at all == live catalogue unavailable. Routing must fall back to
  // the static registry tags (models route exposes the same snapshot).
  const responses = route("gpt-5.5", await getModelInfo(`${PROVIDER}/gpt-5.5`));
  assert.equal(responses.targetFormat, RESPONSES);
  assert.equal(responses.url, RESPONSES_URL);
  assert.equal(responses.body.store, false);

  const chat = route("deepseek-v4-flash", await getModelInfo(`${PROVIDER}/deepseek-v4-flash`));
  assert.equal(chat.url, CHAT_URL);
  assert.ok(!("store" in chat.body));
});

// --- Requirement: Preserve operator model precedence ------------------------

test("custom model metadata wins over the synced record for the same id", async () => {
  await seedSynced([liveModel("live-only-responses-x", "responses")]);
  await modelsDb.addCustomModel(
    PROVIDER,
    "live-only-responses-x",
    "Manual override",
    "manual",
    "chat-completions",
    ["chat"],
    CHAT
  );

  const info = await getModelInfo(`${PROVIDER}/live-only-responses-x`);
  assert.equal(info.targetFormat, CHAT, "operator metadata must win over discovery");

  const routed = route("live-only-responses-x", info);
  assert.equal(routed.url, CHAT_URL);
  assert.ok(!("store" in routed.body));
});
