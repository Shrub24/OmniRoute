/**
 * Criteria proof for milestone 6.2 (TTY-gated notices):
 *
 *   - `notify` emits ZERO bytes when stdout is a TTY (Pi's fullscreen TUI
 *     shares the stream — extension output would glitch into it).
 *   - `notify` writes the notice when stdout is not a TTY (headless `pi -p`
 *     keeps full observability).
 *
 * The helper is the single choke point every boot/skip/sync/degradation
 * notice routes through; loud thrown errors are NOT routed here (Pi renders
 * those itself) and are out of scope for this file.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { notify, notifyUi } from "../src/index.js";

function captureConsole(isTTY: boolean | undefined, fn: (calls: string[]) => void): void {
  const origIsTTY = process.stdout.isTTY;
  const origInfo = console.info;
  const origWarn = console.warn;
  const calls: string[] = [];
  console.info = (...args: unknown[]) => calls.push(`info:${args.join(" ")}`);
  console.warn = (...args: unknown[]) => calls.push(`warn:${args.join(" ")}`);
  (process.stdout as { isTTY?: boolean }).isTTY = isTTY;
  try {
    fn(calls);
  } finally {
    (process.stdout as { isTTY?: boolean }).isTTY = origIsTTY;
    console.info = origInfo;
    console.warn = origWarn;
  }
}

test("notify: silent when stdout is a TTY (TUI emits zero bytes)", () => {
  captureConsole(true, (calls) => {
    notify("info", "registered");
    notify("warn", "skipped");
    assert.deepEqual(calls, []);
  });
});

test("notify: writes when stdout is not a TTY (headless keeps notices)", () => {
  captureConsole(false, (calls) => {
    notify("info", "registered");
    notify("warn", "skipped");
    assert.deepEqual(calls, ["info:registered", "warn:skipped"]);
  });
});

test("notifyUi: uses ctx.ui.notify in TUI/RPC modes", () => {
  const calls: Array<{ message: string; type?: string }> = [];
  const uiCtx = {
    mode: "tui",
    ui: { notify: (message: string, type?: "info" | "warning" | "error") => { calls.push({ message, type }); } },
  };
  notifyUi(uiCtx, "info", "synced");
  assert.deepEqual(calls, [{ message: "synced", type: "info" }]);
  notifyUi({ ...uiCtx, mode: "rpc" }, "error", "failed");
  assert.deepEqual(calls[1], { message: "failed", type: "error" });
});

test("notifyUi: falls back to stdout in print/headless modes", () => {
  const calls: Array<{ message: string; type?: string }> = [];
  const uiCtx = {
    mode: "print",
    ui: { notify: (message: string, type?: "info" | "warning" | "error") => { calls.push({ message, type }); } },
  };
  // stdout is not a TTY under the test runner, so the legacy route writes.
  notifyUi(uiCtx, "info", "synced");
  assert.equal(calls.length, 0);
});
