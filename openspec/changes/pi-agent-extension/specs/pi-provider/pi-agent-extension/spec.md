## Purpose

Let Pi users consume OmniRoute's live model catalog, combos, and server-declared reasoning tiers as a first-class Pi provider, with metadata imported natively at registration and re-syncable mid-session.

## ADDED Requirements

### Requirement: Register the OmniRoute provider from an async extension factory
The extension SHALL fetch the OmniRoute `/v1/models` catalog in its async factory and register a single `omniroute` provider via `pi.registerProvider()` before Pi startup completes, so the provider is available in the interactive picker and to `pi --list-models`.

#### Scenario: Fresh Pi start with the extension installed
- **WHEN** Pi starts with a configured OmniRoute base URL and API key
- **THEN** the `omniroute` provider SHALL appear with the catalog's models and combos registered

#### Scenario: Catalog fetch fails at startup
- **WHEN** the `/v1/models` fetch fails (unreachable server, bad key, timeout)
- **THEN** registration SHALL fail loudly with the HTTP status attached, never with a silently empty model list

### Requirement: Map catalog entries to Pi provider-model shapes
The extension SHALL map each raw catalog entry to Pi's `ProviderModelConfig`: `reasoning` from thinking/reasoning capabilities, `input` from input modalities, `contextWindow` from `context_length` (default 128000), `maxTokens` from `max_output_tokens` (default 16384), and cost zeroed unless pricing enrichment is enabled.

#### Scenario: Entry with full metadata
- **WHEN** a catalog entry declares modalities, context length, and output tokens
- **THEN** the Pi model entry SHALL carry the mapped values, not the Pi defaults

#### Scenario: Entry with missing metadata
- **WHEN** a catalog entry lacks `context_length` or token limits
- **THEN** the Pi entry SHALL fall back to Pi defaults and the gap SHALL be visible (flagged name/description), never silently misreported as measured

### Requirement: Map server effort tiers to thinking levels without synthesis
The extension SHALL map only server-declared `capabilities.effort_tiers` to Pi `thinkingLevelMap` (Pi levels off/minimal/low/medium/high/xhigh/max to server tier strings, `null` for unsupported holes), and SHALL NOT invent tiers for tierless models. For combos, the mapping SHALL be the union of member tiers (see combo requirement): tierless members contribute nothing and never veto, and per-member out-of-vocab requests are clamped server-side at runtime — so advertising the union is safe and a single tierless member MUST NOT strip thinking levels from the whole combo.

#### Scenario: Model with server-declared tiers
- **WHEN** an entry declares `effort_tiers`
- **THEN** each Pi thinking level SHALL resolve to a server tier string the model provably accepts

#### Scenario: Tierless model
- **WHEN** a model entry declares no `effort_tiers`
- **THEN** the Pi entry SHALL expose no thinking-level mapping rather than a synthesized one

### Requirement: Map combos as plain provider entries with LCD roll-up and union thinking levels
The extension SHALL expose each usable combo as a plain model entry under the single `omniroute` provider (not a second provider), rolling static capabilities (input modalities, context/token limits, wire protocol, cost) up across members by lowest-common-denominator, reusing the guards proven in the opencode plugin (usable-combo, bare-combo-ids, auto-combo-context). Reasoning support and thinking levels are UNIONED, not LCDed: `reasoning` is true when ANY member supports it, and `thinkingLevelMap` is built from the union of member `effort_tiers` — because model identity already varies per request for a combo, reasoning depth varying with it is the same semantic, and LCD would let one tierless member strip thinking levels from the whole combo.

#### Scenario: Combo with mixed member capabilities
- **WHEN** a combo's members differ in vision/tool support
- **THEN** the combo entry SHALL advertise only the static capabilities every member supports

#### Scenario: Combo with a tierless member
- **WHEN** one member declares `effort_tiers` and another declares none
- **THEN** the combo entry SHALL still expose `reasoning: true` with the union tier mapping (e.g. `coder-high` + tierless GLM member offers the tiered member's levels); a tierless serving member handles the level via server-side clamp at runtime

#### Scenario: Combo with all-tierless members
- **WHEN** no member declares `effort_tiers`
- **THEN** the combo entry SHALL expose no thinking-level mapping rather than a synthesized one

### Requirement: Select the wire protocol per model at build time
The extension SHALL pin each entry's Pi `api` from its OmniRoute `api_format` (chat vs responses) so Pi requests hit the correct OmniRoute surface, never a doubled `/v1/v1/…` path or a mismatched protocol.

#### Scenario: Responses-format model
- **WHEN** an entry's `api_format` is responses
- **THEN** its Pi entry SHALL use the responses wire protocol against the correct base URL

### Requirement: Re-sync live mid-session
The extension SHALL support re-running the catalog fetch and applying it via `unregisterProvider()` + `registerProvider()` without a Pi restart, through an explicit command and/or a session-start refresh.

#### Scenario: Operator re-syncs after server catalog changes
- **WHEN** the re-sync command runs
- **THEN** the `omniroute` provider's model list SHALL reflect the fresh catalog within the same session

### Requirement: Authenticate through Pi's native key flow
The extension SHALL accept the API key through Pi's `registerProvider` apiKey form (`$VAR`/`!cmd`/literal) so it surfaces in `/login`, keeping catalog-fetch credentials in extension config (separate env var) rather than overloading the single provider key.

#### Scenario: Key precedence
- **WHEN** CLI flag, auth.json, env, and static config disagree
- **THEN** Pi's documented precedence (CLI > auth.json > env > static) SHALL hold without extension interference

### Requirement: Never write to stdout/stderr under the Pi TUI
The extension SHALL NOT call `console.*` (or otherwise write to stdout/stderr) when attached to a TTY — Pi's fullscreen TUI shares that stream and extension output glitches into it. Notices (skip/config/degradation/sync confirmations) SHALL be gated on non-TTY output (headless `pi -p` keeps full observability). Loud failure paths (thrown errors) are unchanged — Pi renders those through its own UI.

#### Scenario: Interactive TUI session
- **WHEN** Pi runs its fullscreen TUI (stdout is a TTY)
- **THEN** the extension SHALL emit zero bytes to stdout/stderr on boot, skip, re-sync, or degraded-combos paths

#### Scenario: Headless run
- **WHEN** Pi runs piped/non-interactive (stdout is not a TTY)
- **THEN** the extension MAY emit its boot/skip/sync notices as today
