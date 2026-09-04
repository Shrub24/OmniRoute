import test from "node:test";
import assert from "node:assert/strict";

import { OpencodeExecutor } from "../../open-sse/executors/opencode.ts";
import { CheaperInferenceExecutor } from "../../open-sse/executors/cheaperinference.ts";
import { XaiExecutor } from "../../open-sse/executors/xai.ts";
import { GheCopilotExecutor } from "../../open-sse/executors/ghe-copilot.ts";
import { DefaultExecutor } from "../../open-sse/executors/default.ts";
import { GithubExecutor } from "../../open-sse/executors/github.ts";

// chatCore resolves the authoritative upstream wire format (DB apiFormat override
// included) and hands it to executors via ExecuteInput.upstreamRequestFormat.
// Executors must prefer it over their static-registry re-resolution, which cannot
// see UI/DB overrides. Static registry stays the fallback when nothing is passed.

test("opencode execute() routes a static-chat model to /responses on upstream override", async () => {
  const executor = new OpencodeExecutor("opencode-zen");
  const originalFetch = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (url: unknown) => {
    seen.push(String(url));
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const result = await executor.execute({
      model: "deepseek-v4-flash-free",
      body: { model: "deepseek-v4-flash-free" },
      stream: false,
      credentials: { apiKey: "test-key" } as never,
      upstreamRequestFormat: "openai-responses",
    });
    assert.equal((result as { url?: string }).url, "https://opencode.ai/zen/v1/responses");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("opencode execute() routes a static-responses model to chat on upstream override", async () => {
  const executor = new OpencodeExecutor("opencode-zen");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  try {
    const result = await executor.execute({
      model: "muse-spark-1.2",
      body: { model: "muse-spark-1.2" },
      stream: false,
      credentials: { apiKey: "test-key" } as never,
      upstreamRequestFormat: "openai",
    });
    assert.equal((result as { url?: string }).url, "https://opencode.ai/zen/v1/chat/completions");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cheaperinference buildUrl() prefers upstreamRequestFormat both ways", () => {
  const executor = new CheaperInferenceExecutor();
  assert.equal(
    executor.buildUrl("grok-4.5", true, 0, null, "openai-responses"),
    "https://api.cheaperinference.com/v1/responses"
  );
  assert.equal(
    executor.buildUrl("gpt-5.4", true, 0, null, "openai"),
    "https://api.cheaperinference.com/v1/chat/completions"
  );
});

test("cheaperinference transformRequest() injects store:false under upstream override", () => {
  const executor = new CheaperInferenceExecutor();
  const out = executor.transformRequest(
    "grok-4.5",
    { model: "grok-4.5" },
    false,
    {} as never,
    "openai-responses"
  ) as Record<string, unknown>;
  assert.equal(out.store, false);
});

test("xai buildUrl()/transformRequest() prefer upstreamRequestFormat both ways", () => {
  const executor = new XaiExecutor("xai-oauth");
  assert.equal(
    executor.buildUrl("grok-3", true, 0, null, "openai-responses"),
    "https://api.x.ai/v1/responses"
  );
  assert.equal(
    executor.buildUrl("grok-4.5", true, 0, null, "openai"),
    "https://api.x.ai/v1/chat/completions"
  );
  const out = executor.transformRequest(
    "grok-3",
    { model: "grok-3", messages: [{ role: "user", content: "hi" }], max_tokens: 16 },
    false,
    { accessToken: "test" } as never,
    "openai-responses"
  ) as Record<string, unknown>;
  assert.ok(Array.isArray(out.input), "messages must become input under override");
});

test("ghe-copilot buildUrl() prefers upstreamRequestFormat both ways", () => {
  const executor = new GheCopilotExecutor({
    gheUrl: "https://ghe.company.com",
    clientId: "test-client",
    clientSecret: "test-secret",
  });
  const credentials = {
    providerSpecificData: { gheUrl: "https://ghe.company.com" },
  } as never;
  assert.equal(
    executor.buildUrl("gpt-4o", true, 0, credentials, "openai-responses"),
    "https://ghe.company.com/responses"
  );
  assert.equal(
    executor.buildUrl("gpt-5.4-mini", true, 0, credentials, "openai"),
    "https://ghe.company.com/chat/completions"
  );
});

test("default(openai) buildUrl() prefers upstreamRequestFormat both ways", () => {
  const executor = new DefaultExecutor("openai");
  assert.equal(
    executor.buildUrl("gpt-4o", true, 0, null, "openai-responses"),
    "https://api.openai.com/v1/responses"
  );
  assert.equal(
    executor.buildUrl("o1-pro", true, 0, null, "openai"),
    "https://api.openai.com/v1/chat/completions"
  );
});

test("default(poe) buildUrl() prefers upstreamRequestFormat both ways", () => {
  const executor = new DefaultExecutor("poe");
  assert.equal(
    executor.buildUrl("gemini-3.0-pro", true, 0, null, "openai-responses"),
    "https://api.poe.com/v1/responses"
  );
  assert.equal(
    executor.buildUrl("claude-opus-4.8", true, 0, null, "openai"),
    "https://api.poe.com/v1/chat/completions"
  );
});

test("github buildUrl() prefers upstreamRequestFormat both ways", () => {
  const executor = new GithubExecutor();
  assert.equal(
    executor.buildUrl("gpt-4o-mini", true, 0, null, "openai-responses"),
    "https://api.githubcopilot.com/responses"
  );
  assert.equal(
    executor.buildUrl("gpt-5.6-sol", true, 0, null, "openai"),
    "https://api.githubcopilot.com/chat/completions"
  );
});
