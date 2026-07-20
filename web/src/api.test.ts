import { describe, expect, it } from "vitest";
import { runtimeRoot } from "./api";

describe("runtimeRoot", () => {
  it("keeps agent runtime sessions under the shared root", () => {
    expect(runtimeRoot(".agent-runtime/session-a")).toBe(".agent-runtime");
    expect(runtimeRoot(".agent-runtime")).toBe(".agent-runtime");
  });

  it("uses external runtime directories as their own root", () => {
    expect(runtimeRoot("/tmp/agent-run")).toBe("/tmp/agent-run");
  });
});
