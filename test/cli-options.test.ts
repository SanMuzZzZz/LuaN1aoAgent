import assert from "node:assert/strict";
import test from "node:test";
import { parseCliOptions, shouldUseTui } from "../src/cli-options.js";

test("uses TUI only for an interactive terminal without machine output flags", () => {
  const options = parseCliOptions(["--goal", "inspect", "--max-cycles", "3"]);
  assert.equal(options.goal, "inspect");
  assert.equal(options.maxPlannerCycles, 3);
  assert.equal(shouldUseTui(options, { stdinIsTTY: true, stdoutIsTTY: true }), true);
  assert.equal(shouldUseTui(options, { stdinIsTTY: false, stdoutIsTTY: true }), false);
  assert.equal(shouldUseTui({ ...options, jsonl: true }, { stdinIsTTY: true, stdoutIsTTY: true }), false);
});

test("rejects missing and invalid numeric option values", () => {
  assert.throws(() => parseCliOptions(["--scope"]), /Missing value/);
  assert.throws(() => parseCliOptions(["--max-cycles", "many"]), /Invalid number/);
});
