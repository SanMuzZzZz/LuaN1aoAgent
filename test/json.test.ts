import assert from "node:assert/strict";
import test from "node:test";
import { extractJsonObject } from "../src/json.js";

test("extracts the first balanced valid JSON object from mixed model output", () => {
  const parsed = extractJsonObject<{ ok: boolean }>("notes {not json} before {\"ok\":true} after");
  assert.deepEqual(parsed, { ok: true });
});

test("extracts fenced JSON output", () => {
  const parsed = extractJsonObject<{ sourceEventIds: string[] }>("```json\n{\"sourceEventIds\":[\"event:1\"]}\n```");
  assert.deepEqual(parsed, { sourceEventIds: ["event:1"] });
});
