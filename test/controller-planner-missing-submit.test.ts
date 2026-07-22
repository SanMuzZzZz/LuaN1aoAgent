import assert from "node:assert/strict";
import test from "node:test";
import { classifyPlannerProviderFailure } from "../src/controller.js";
import { StructuredInvocationError } from "../src/pi-runner.js";

test("classifies missing planner_submit as retryable instead of run-fatal", () => {
  const failure = classifyPlannerProviderFailure(
    new StructuredInvocationError("Invocation completed without planner_submit", "missing_submit")
  );
  assert.equal(failure.errorKind, "missing_submit");
  assert.equal(failure.retryable, true);
});

test("keeps planner timeouts and provider errors retryable", () => {
  const timeout = classifyPlannerProviderFailure(
    new StructuredInvocationError("Structured invocation hard timed out after 240000ms", "timeout")
  );
  assert.equal(timeout.retryable, true);
  const provider = classifyPlannerProviderFailure(
    new StructuredInvocationError("HTTP 429 too many requests", "provider_error")
  );
  assert.equal(provider.errorKind, "provider_rate_limit");
  assert.equal(provider.retryable, true);
});

test("keeps invalid_submit retryable and tool_error non-retryable", () => {
  const invalid = classifyPlannerProviderFailure(
    new StructuredInvocationError("Validation failed for tool planner_submit", "invalid_submit")
  );
  assert.equal(invalid.retryable, true);
  const toolError = classifyPlannerProviderFailure(
    new StructuredInvocationError("Terminal tool crashed", "tool_error")
  );
  assert.equal(toolError.retryable, false);
});
