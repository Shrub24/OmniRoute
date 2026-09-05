/**
 * Bonus live boot: start the stub catalog server, then run the package-local
 * `pi` 0.85.0 binary with this extension and drive TWO real print turns against
 * the mapped `omniroute/tiered-model` — one at thinking level `low`, one at
 * `high` — asserting the wire `reasoning_effort` each time.
 *
 * A complete answer from the stub proves registration + the chat wire protocol
 * end-to-end (`/v1/chat/completions`, never `/v1/v1/…`), and the captured
 * request bodies' `reasoning_effort` values prove the server-declared
 * `effort_tiers` → `thinkingLevelMap` survived Pi's model resolution and was
 * applied at request time for BOTH levels (the tiered model round-trips its
 * advertised levels live).
 *
 * Run from the package root:
 *   node --import tsx/esm tests/boot-live.mts
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { startStubModelsServer } from "./stub-server.ts";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const server = await startStubModelsServer();

// Drive two distinct thinking levels end-to-end, one pi invocation per level.
// Each turn must land its own `reasoning_effort` on the wire — proving the
// map is applied per level, not just that one hardcoded level round-trips.
const LEVELS = ["low", "high"];

function runPi(level: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(
      join(pkgRoot, "node_modules", ".bin", "pi"),
      [
        "--extension",
        "./src/index.ts",
        "--no-approve",
        "--print",
        "--api-key",
        "test-key",
        "--model",
        "omniroute/tiered-model",
        "--thinking",
        level,
        "say hi",
      ],
      {
        cwd: pkgRoot,
        env: { ...process.env, OMNIROUTE_BASE_URL: server.baseURL, OMNIROUTE_API_KEY: "test-key" },
        stdio: "inherit",
      }
    );
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

const codes = [];
for (const level of LEVELS) codes.push(await runPi(level));

const bodies = server.chatBodies();
if (codes.some((code) => code !== 0)) {
  console.error(`[boot-live] pi exited with codes ${codes.join(", ")}`);
  process.exitCode = 1;
} else if (bodies.length !== LEVELS.length) {
  console.error(
    `[boot-live] FAIL: expected ${LEVELS.length} chat requests, stub received ${bodies.length}`
  );
  process.exitCode = 1;
} else {
  for (let i = 0; i < LEVELS.length; i++) {
    const body = bodies[i]!;
    const level = LEVELS[i]!;
    if (body.model !== "tiered-model") {
      console.error(
        `[boot-live] FAIL: turn ${i} expected model tiered-model, got ${String(body.model)}`
      );
      process.exitCode = 1;
    } else if (body.reasoning_effort !== level) {
      console.error(
        `[boot-live] FAIL: turn ${i} expected reasoning_effort "${level}" (mapped from tiered-model's effort_tiers), got ${String(body.reasoning_effort)}`
      );
      process.exitCode = 1;
    } else {
      console.log(
        `[boot-live] OK: turn ${i} pi resolved omniroute/tiered-model, thinkingLevelMap applied → reasoning_effort=${String(body.reasoning_effort)}`
      );
    }
  }
}
await server.close();
process.exit(process.exitCode ?? 0);
