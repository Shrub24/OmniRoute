/**
 * Regression guard for the client-bundle leak that broke the Docker image build
 * after the upstream/release/v3.8.51 sync.
 *
 * `src/lib/combos/controlCenter.ts` is imported by the `"use client"`
 * `ComboControlCenterClient.tsx`, so everything it reaches statically ends up in
 * the browser bundle. Upstream #13283 added `import { resolveProviderAlias }
 * from "../../../open-sse/services/model.ts"` to that file; `model.ts` reaches
 * `@/lib/db/readCache`, which fans out through `settings.ts` → `runtimeSettings.ts`
 * → `tokenHealthCheck.ts` → `webCookie.ts` → `zai-web.ts` → `cursorImages.ts` →
 * `sharp` → `detect-libc`, and webpack then failed the client compile with
 * "Module not found: Can't resolve 'child_process'".
 *
 * The fix moved `resolveProviderAlias` into the import-free `services/providerAlias.ts`.
 * This test walks the static import graph from `controlCenter.ts` and fails if any
 * server-only module re-enters it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ENTRY = "src/lib/combos/controlCenter.ts";

/** Server-only files that must never be reachable from a client entry point. */
const SERVER_ONLY = [/^src\/lib\/db\//, /^open-sse\/services\/model\.ts$/];

/** `import type` / `export type` are erased at compile time, so they cannot leak. */
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(?!type\b)[^;\n]*?from\s+["']([^"']+)["']/g;

function resolveSpecifier(fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = path.join("src", specifier.slice(2));
  else if (specifier.startsWith("@omniroute/open-sse/"))
    base = path.join("open-sse", specifier.slice("@omniroute/open-sse/".length));
  else if (specifier.startsWith(".")) base = path.join(path.dirname(fromFile), specifier);
  else return null; // bare package specifier — node_modules is out of scope

  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (existsSync(path.join(REPO_ROOT, candidate))) return candidate;
  }
  return null;
}

test("controlCenter.ts stays free of server-only imports (client bundle safety)", () => {
  const seen = new Set<string>();
  const offenders: string[] = [];
  const queue = [ENTRY];

  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);

    for (const match of readFileSync(path.join(REPO_ROOT, file), "utf8").matchAll(IMPORT_RE)) {
      const target = resolveSpecifier(file, match[1]);
      if (!target) continue;
      if (SERVER_ONLY.some((pattern) => pattern.test(target))) offenders.push(`${file} → ${target}`);
      else queue.push(target);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `server-only module reached from the client entry ${ENTRY}:\n${offenders.join("\n")}`
  );
  assert.ok(seen.size > 1, "walker found no imports — the regex or the entry path is wrong");
});
