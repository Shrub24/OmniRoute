## Why

Pi (earendil-works/pi, the badlogic coding agent) has no OmniRoute provider surface: Pi users cannot route Pi traffic through OmniRoute's unified catalog, combos, or effort-tier vocabularies. Pi's extension system exposes `registerProvider()` from an async factory — the exact analog of opencode's dynamic provider hook — plus a `thinkingLevelMap` per model that maps 1:1 onto OmniRoute's server-gated `capabilities.effort_tiers`. The catalog plumbing already exists and is proven in `@omniroute/opencode-plugin` (fetcher, tier mapping, combo roll-up, pricing enrichment); only the Pi provider-shape mapping and extension packaging are new.

## What Changes

- Add `@omniroute/pi-agent`: a Pi extension (plain TS module, jiti-loaded, no build step) that registers a single `omniroute` provider from an async factory, mapping OmniRoute `/v1/models` entries (and combos) to Pi `ProviderModelConfig` entries.
- Map server-declared `effort_tiers` to Pi `thinkingLevelMap` (server vocabulary only, never synthesized); map reasoning/modalities/context/token metadata to Pi's required model fields; map combos as plain model entries with lowest-common-denominator roll-up.
- Decide the per-model wire protocol (`api`) at build time from the entry's `api_format` so Pi hits the correct OmniRoute surface.
- Support live re-sync mid-session via `unregisterProvider()` + `registerProvider()` (command and/or session-start refresh); authenticate through Pi's `/login` apiKey form.
- Pin the Pi dependency versions in tests; verify tier round-trips against a live server.

## Capabilities

### New Capabilities
- `pi-provider/pi-agent-extension`: Register and sync OmniRoute as a Pi provider extension with native metadata import and live re-sync.

### Modified Capabilities
- None.

## Impact

- New package `@omniroute/pi-agent` only; no server, executor, or existing-plugin changes.
- Pi extension API volatility (pre-1.0, weekly churn) — versions pinned, extension targets a documented Pi release.
- Focused mapping/registration tests plus a live round-trip check.
