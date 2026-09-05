/**
 * Live proof of the 3.1 auth flow: the provider request key is carried as Pi's
 * `$OMNIROUTE_API_KEY` apiKey form, so Pi resolves it from the environment at
 * request time and sends `Authorization: Bearer <key>` to the gateway — with
 * NO `--api-key` CLI flag involved. This is the same resolution path `/login`
 * uses (Pi's "API key" login for the provider), so a successful authed turn
 * here proves the env-ref form is live and `/login`-visible.
 *
 * Run from the package root:
 *   node --import tsx/esm tests/boot-auth.mts
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { startStubModelsServer } from "./stub-server.ts";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const server = await startStubModelsServer();

// NOTE: no `--api-key` flag — the key must come from the env-ref on the
// provider config, exactly as it would after a `/login`-stored credential.
const child = spawn(
  join(pkgRoot, "node_modules", ".bin", "pi"),
  [
    "--extension",
    "./src/index.ts",
    "--no-approve",
    "--print",
    "--model",
    "omniroute/chat-full",
    "say hi",
  ],
  {
    cwd: pkgRoot,
    env: { ...process.env, OMNIROUTE_BASE_URL: server.baseURL, OMNIROUTE_API_KEY: "env-ref-key" },
    stdio: "inherit",
  }
);

child.on("exit", async (code) => {
  try {
    const body = server.lastChatBody();
    const auth = server.lastAuthHeader();
    if (code !== 0) {
      console.error(`[boot-auth] pi exited with code ${code}`);
      process.exitCode = code ?? 1;
    } else if (!body) {
      console.error("[boot-auth] FAIL: stub received no chat request");
      process.exitCode = 1;
    } else if (auth !== "Bearer env-ref-key") {
      console.error(
        `[boot-auth] FAIL: expected Authorization "Bearer env-ref-key" (env-ref apiKey form), got ${String(auth)}`
      );
      process.exitCode = 1;
    } else {
      console.log(
        `[boot-auth] OK: env-ref apiKey form resolved → Authorization: ${auth} (no CLI flag)`
      );
    }
  } finally {
    await server.close();
    process.exit(process.exitCode ?? 0);
  }
});
