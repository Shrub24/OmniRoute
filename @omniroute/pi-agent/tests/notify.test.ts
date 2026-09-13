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

import { notify } from "../src/index.js";

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
