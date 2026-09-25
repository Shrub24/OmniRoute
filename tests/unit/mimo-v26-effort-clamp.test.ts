import test from "node:test";
import assert from "node:assert/strict";

const { sanitizeReasoningEffortForProvider } = await import("../../open-sse/executors/base.ts");
const { getProviderModels } = await import("../../open-sse/config/providerModels.ts");

function makeLog() {
  const messages: Array<[string, string]> = [];
  return {
    info: (tag: string, msg: string) => messages.push([tag, msg]),
    messages,
  };
}

function sanitize(effort: string, model: string, provider = "opencode-go") {
  const log = makeLog();
  const res = sanitizeReasoningEffortForProvider(
    { model, reasoning_effort: effort, messages: [] },
    provider,
    model,
    log
  ) as Record<string, unknown>;
  return { effort: res.reasoning_effort, log };
}

// opencode-go's MiMo gateway validates reasoning_effort as a pydantic literal
// of exactly low|medium|high: xhigh/max -> 400 "Invalid request parameters",
// low/medium/high -> 200 (verified live 2026-09-25; oh-my-pi #2864 carries the
// gateway's own literal_error text). mimo-v2.6-flash/pro ship unregistered, so
// without the registry declaration the provider-wide xhigh -> max rewrite fired
// before any model-specific check and every request above high 400'd.

test("mimo-v2.6 registry entries declare the gateway-accepted tier vocabulary", () => {
  const models = getProviderModels("opencode-go");
  for (const id of ["mimo-v2.6-flash", "mimo-v2.6-pro"]) {
    const entry = models.find((m) => m.id === id);
    assert.ok(entry, `${id} must be registered on opencode-go`);
    assert.equal(entry!.supportsReasoning, true);
    assert.deepEqual(entry!.supportedThinkingEfforts, ["low", "medium", "high"]);
  }
});

test("mimo-v2.6-flash: xhigh and max clamp to high (gateway ceiling)", () => {
  assert.equal(sanitize("xhigh", "mimo-v2.6-flash").effort, "high");
  assert.equal(sanitize("max", "mimo-v2.6-flash").effort, "high");
});

test("mimo-v2.6-flash: accepted tiers pass through untouched", () => {
  for (const effort of ["low", "medium", "high"]) {
    assert.equal(sanitize(effort, "mimo-v2.6-flash").effort, effort);
  }
});

test("mimo-v2.6-pro: xhigh and max clamp to high", () => {
  assert.equal(sanitize("xhigh", "mimo-v2.6-pro").effort, "high");
  assert.equal(sanitize("max", "mimo-v2.6-pro").effort, "high");
});

test("mimo-v2.6-flash: prefixed model id clamps the same way", () => {
  assert.equal(sanitize("xhigh", "opencode-go/mimo-v2.6-flash").effort, "high");
});

test("mimo-v2.5 keeps its max ceiling (contract unchanged by the reorder)", () => {
  // v2.5 declares [high, max] and the gateway accepts max for it — verified
  // live 2026-09-25. The declared clamp above isMaxTierTarget must not
  // downgrade an in-vocabulary tier.
  assert.equal(sanitize("xhigh", "mimo-v2.5").effort, "max");
  assert.equal(sanitize("max", "mimo-v2.5").effort, "max");
  assert.equal(sanitize("high", "mimo-v2.5").effort, "high");
});

test("opencode-go models without a v2.6-style declaration keep provider-wide xhigh → max", () => {
  // glm-5.2 declares [high, max]: xhigh is out of vocabulary, so the declared
  // clamp maps it to max — same result the provider-wide rewrite produced.
  assert.equal(sanitize("xhigh", "glm-5.2").effort, "max");
  // An unregistered model has no declared vocabulary at all and must reach
  // the provider-wide block untouched (#8057 pass-through for unknown max).
  const unknown = sanitize("xhigh", "some-unregistered-model");
  assert.equal(unknown.effort, "max");
});
