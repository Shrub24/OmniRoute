## 1. Extension scaffold

- [x] 1.1 Scaffold `@omniroute/pi-agent` alongside `@omniroute/opencode-plugin` (package manifest with Pi extension declaration, TS entry module, README install path); verify Pi loads the extension skeleton.
  - refs: `specs/pi-provider/pi-agent-extension/spec.md`
  - criteria: `pi` discovers the extension; factory runs without registering models yet
  - delegate: CoderAgent

## 2. Catalog import

- [x] 2.1 Port the `/v1/models` fetcher + raw-entry typing from the opencode plugin (baseURL normalization, Bearer auth, envelope tolerance, abort timeout); verify against a live server.
  - refs: `specs/pi-provider/pi-agent-extension/spec.md`
  - criteria: fresh-start registration lists catalog models; fetch failure is loud with HTTP status
  - delegate: CoderAgent
- [x] 2.2 Implement raw-entry → `ProviderModelConfig` mapping (reasoning/input/contextWindow/maxTokens/cost, Pi defaults + visible gaps on missing metadata) and the per-model wire-protocol (`api`) decision from `api_format`.
  - refs: `specs/pi-provider/pi-agent-extension/spec.md`
  - criteria: full-metadata entry maps exactly; missing-metadata entry falls back visibly; responses entry hits the responses surface
  - delegate: CoderAgent
- [x] 2.3 Map server `effort_tiers` → `thinkingLevelMap` (declared tiers only, `null` holes, no synthesis) and combos → plain entries with LCD roll-up.
  - refs: `specs/pi-provider/pi-agent-extension/spec.md`
  - criteria: tiered model round-trips every advertised level live; tierless model/combo exposes no mapping
  - delegate: CoderAgent

## 3. Auth + live re-sync

- [x] 3.1 Wire provider auth through Pi's `registerProvider` apiKey form (`/login`-visible) with catalog credentials on a separate env var; implement mid-session re-sync (command and/or session-start refresh via unregister/re-register).
  - refs: `specs/pi-provider/pi-agent-extension/spec.md`
  - criteria: `/login` shows the key flow; re-sync reflects catalog changes without restart
  - delegate: CoderAgent

## 4. Regression coverage

- [x] 4.1 Add mapping/registration unit tests with pinned Pi dependency versions plus a live tier round-trip check; verify the suite passes.
  - refs: `specs/pi-provider/pi-agent-extension/spec.md`
  - delegate: TestEngineer
  - verify: new test files pass; Pi version pins asserted

## 5. Review gate

- [x] 5.1 Review the new package for no-synthesis violations, wrong-default metadata, and auth leakage; verify no server/executor/opencode-plugin files changed.
  - delegate: CodeReviewer

## 6. Live-feedback fixes (Pi 0.84.4 + real catalog)

- [x] 6.1 Union combo thinking levels: `reasoning` true when ANY member supports it; `thinkingLevelMap` from the union of member `effort_tiers` (tierless members contribute nothing, never veto); all-tierless combos keep no mapping; static caps (input/context/api/cost) stay LCD.
  - refs: `specs/pi-provider/pi-agent-extension/spec.md` (combo requirement)
  - criteria: tiered+tierless combo (e.g. coder-high shape) exposes reasoning + union map; all-tierless combo exposes neither; no invented tiers
  - delegate: CoderAgent
  - verify: new/updated mapper tests green; full package suite green
- [x] 6.2 Silence stdout/stderr under the Pi TUI: gate all `console.*` notices on non-TTY output; loud throws unchanged.
  - refs: `specs/pi-provider/pi-agent-extension/spec.md` (TTY requirement)
  - criteria: zero extension bytes on stdout/stderr in TUI; headless keeps notices
  - delegate: CoderAgent
  - verify: notify-helper tests (TTY + piped) green; full package suite green
