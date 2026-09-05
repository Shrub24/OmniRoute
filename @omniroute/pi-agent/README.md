# @omniroute/pi-agent

Pi extension for the **OmniRoute AI Gateway**. Registers OmniRoute's live model
catalog — models, combos, and server-declared reasoning tiers — as a first-class
[Pi](https://github.com/earendil-works/pi) provider, with metadata imported
natively at registration and re-syncable mid-session.

> **Status: functional.** The extension fetches `/v1/models` + `/api/combos` at
> startup, maps everything to Pi `ProviderModelConfig` entries (reasoning/input/
> context/maxTokens + per-model wire protocol + server-declared `effort_tiers` →
> `thinkingLevelMap`), and registers the single `omniroute` provider.
> `/api/combos/auto` is opt-in (`OMNIROUTE_AUTO_COMBOS=on`) and off by default.
> Provider auth goes through Pi's `apiKey` form
> (see [Authentication](#authentication)); the catalog stays fresh via
> mid-session re-sync (see [Re-sync](#re-sync)). No server, executor, or
> `@omniroute/opencode-plugin` code is touched.

## How Pi loads extensions

Pi loads extensions as plain TypeScript modules at startup (via jiti — **no
build step**). Each extension is a file declared in the package manifest, whose
default export is an async factory:

```ts
// src/index.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function (pi: ExtensionAPI): Promise<void> {
  // fetch catalog, then:
  // pi.registerProvider("omniroute", { baseUrl, apiKey, api, models });
}
```

Pi **awaits the factory before startup continues**, which is what makes
fetching `/v1/models` at registration safe. See the pinned docs below.

## Configuration

The extension reads its catalog credentials from the environment (extension
config, never hardcoded):

| Env var | Purpose |
| ------- | ------- |
| `OMNIROUTE_BASE_URL` | Gateway base URL (`http://host:port` or `.../v1`) |
| `OMNIROUTE_API_KEY` | Gateway API key used to fetch the catalog (Bearer) |
| `OMNIROUTE_AUTO_COMBOS` | `on` registers auto combos. Unset (the default) drops them — see below |

### Auto combos are off by default

OmniRoute exposes two combo families: **named combos** (`/api/combos`, e.g.
`coder-high`, `Kimi Coding`) and **auto combos** (`/api/combos/auto`, e.g.
`auto/coding`). Only the named ones register by default.

Setting `OMNIROUTE_AUTO_COMBOS=on` adds both the `/api/combos/auto` entries and
the `auto/*` entries `/v1/models` mirrors for them. Cost of opting in: the
auto-combo endpoint materialises its candidate pool per combo and answers in
seconds, and Pi **awaits the factory before startup continues** — so enabling
this makes every boot wait that long.

When neither is set the extension logs a notice and skips the fetch (no
`omniroute` provider). A models fetch failure is loud — Pi startup fails with
the HTTP status attached, never a silently empty model list.

> Note: `pi auth check --provider omniroute` does not exercise
> settings-registered extensions — it reports `not_ready` even when the
> extension is installed and enabled. Use a real boot (`pi -p ...`) or the
> explicit `-e` flag to verify loading.

## Authentication

The provider request key is carried on the registered config as **Pi's `apiKey`
form** — `apiKey: "$OMNIROUTE_API_KEY"` (an env interpolation reference, not a
literal copy). Pi resolves it at request time and surfaces the provider's
"API key" login in `/login`, so operators can also set the key there (or via
`--api-key` / `auth.json`); Pi's documented precedence (CLI flag > auth.json >
env > static) holds without extension interference. Catalog-fetch credentials
stay on the env vars above — they are never overloaded into the provider key.

## Re-sync

The catalog can change while Pi runs (models added/removed, metadata updated).
The extension re-applies it mid-session via Pi's
`unregisterProvider()` + `registerProvider()` — **no restart, no `/reload`**:

- **`/omniroute-sync`** — explicit command: re-fetches the catalog and
  re-registers the `omniroute` provider immediately.
- **Session-start refresh** — every subsequent session start (`new`/`resume`/
  `fork`) re-syncs in the background so the catalog stays current even if the
  command is never run. A failed background refresh only warns — the previous
  catalog is kept.

### Multi-instance limitation

There is **no plugin-options story** for pointing the extension at multiple
OmniRoute instances (e.g. prod + preprod) in one Pi install: the base URL comes
from `OMNIROUTE_BASE_URL`, which is process-wide. To run against a different
instance today, either launch Pi with that instance's env vars, or keep a
per-instance copy of the extension (e.g. separate extension directories with a
static `baseUrl` override). This is a Pi packaging constraint — a plugin-options
shim would not survive Pi's weekly version churn.

## Install path

Prerequisite: Pi `>= 0.85.0` (this package is pinned against
`@earendil-works/pi-coding-agent@0.85.0`; see [Version pin](#version-pin)).

### Quick test (from this repo, no install)

```bash
pi -e ./@omniroute/pi-agent
```

`-e` (alias `--extension`) resolves a directory's `package.json` `pi`
manifest and loads the declared extensions. This is the recommended way while
developing in the monorepo.

### Global drop-in (manual)

Symlink or copy the package so Pi auto-discovers it:

```bash
ln -s "$(pwd)/@omniroute/pi-agent" ~/.pi/agent/extensions/omniroute
```

Pi scans `~/.pi/agent/extensions/` (global) and `.pi/extensions/` (project
local) one level deep: a subdirectory with a `package.json` containing a `pi`
field is loaded via its manifest. A single-file drop-in also works — copy
`src/index.ts` to `~/.pi/agent/extensions/omniroute.ts`.

### As a Pi package (once published)

```bash
pi install npm:@omniroute/pi-agent
```

Pi installs npm packages into `~/.pi/agent/npm/` (project-local with `pi
install -l`), then auto-discovers them through the same manifest mechanism.
The git install form (`pi install git:...`) expects a package root, so in this
monorepo the npm route is the canonical distribution path.

## Extension manifest

This package declares its extension in `package.json`:

```json
{
  "name": "@omniroute/pi-agent",
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

`pi.extensions` paths are resolved relative to the package directory and may
point at files or directories.

## Version pin

Pi is pre-1.0 and changes weekly. This package targets and is type-checked
against **`@earendil-works/pi-coding-agent@0.85.0`**:

- `devDependencies`: exact pin `0.85.0` (what types/tests compile against).
- `peerDependencies`: `^0.85.0` (host Pi must be 0.85.x).
- `devDependencies` also pin `@earendil-works/pi-server@0.85.0`: the npm
  distribution of `pi-coding-agent@0.85.0` omits it from `dependencies` even
  though the top-level `dist/index.js` imports it, so any runtime import of
  the package root fails without it. Extensions only ever import **types**
  from the package root (Pi virtualizes the module at runtime), so the server
  dep is verification/test-only and never runs.

Move these together when bumping to a newer Pi release, and re-run
`npm run check` plus the smoke check.

Reference docs (pinned to the Pi `main` branch at 2026-09-05):

- Extensions: <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md>
- Custom providers (`registerProvider`): <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/custom-provider.md>
- Pi packages (`pi install`): <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md>

## Development

```bash
npm install        # installs the pinned Pi devDependency
npm run check      # tsc --noEmit against the pinned Pi types
# unit tests (mapping + auth/re-sync behavior)
node --import tsx/esm --test tests/mapper.test.ts tests/auth-resync.test.ts
# live boots against the stub server (real Pi 0.85.0 binary)
node --import tsx/esm tests/boot-live.mts
node --import tsx/esm tests/boot-auth.mts
```

Prettier formatting is enforced on new files (repo default: 2 spaces,
semicolons, double quotes, 100 columns).
