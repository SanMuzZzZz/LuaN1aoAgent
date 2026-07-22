import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import test from "node:test";
import type { WebUser } from "../src/web-auth.js";
import {
  hasCapability,
  requireCapability,
  validateMutationRequest,
  WebSecurityError
} from "../src/web-security.js";

const baseUser = {
  id: "user:test",
  username: "test",
  displayName: "Test",
  createdAt: "2026-01-01T00:00:00.000Z"
};
const admin: WebUser = { ...baseUser, role: "admin" };
const analyst: WebUser = { ...baseUser, role: "analyst" };

function request(input: { method?: string; origin?: string; csrf?: string; host?: string } = {}): IncomingMessage {
  return {
    method: input.method ?? "POST",
    headers: {
      host: input.host ?? "127.0.0.1:8787",
      origin: input.origin,
      "x-csrf-token": input.csrf
    }
  } as unknown as IncomingMessage;
}

function securityCode(code: WebSecurityError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof WebSecurityError && error.code === code;
}

test("admin has all capabilities while analyst cannot perform admin operations", () => {
  for (const capability of [
    "viewer:metadata",
    "traffic:read-sensitive",
    "connectivity:manage",
    "operator:mutate",
    "admin:credential",
    "admin:delete",
    "admin:export"
  ] as const) {
    assert.equal(hasCapability(admin, capability), true);
  }
  assert.equal(hasCapability(analyst, "viewer:metadata"), true);
  assert.equal(hasCapability(analyst, "traffic:read-sensitive"), true);
  assert.equal(hasCapability(analyst, "operator:mutate"), true);
  assert.equal(hasCapability(analyst, "connectivity:manage"), false);
  assert.throws(() => requireCapability(analyst, "connectivity:manage"), securityCode("authorization_forbidden"));
  for (const capability of ["admin:credential", "admin:delete", "admin:export"] as const) {
    assert.equal(hasCapability(analyst, capability), false);
    assert.throws(() => requireCapability(analyst, capability), securityCode("authorization_forbidden"));
  }
});

test("CSRF validation rejects missing and incorrect tokens", () => {
  assert.throws(() => validateMutationRequest(request(), undefined), securityCode("csrf_token_missing"));
  assert.throws(() => validateMutationRequest(request({ csrf: "wrong" }), "expected"), securityCode("csrf_token_invalid"));
});

test("CSRF validation rejects cross-origin requests even with a valid token", () => {
  assert.throws(
    () => validateMutationRequest(request({ origin: "https://attacker.example", csrf: "valid" }), "valid"),
    securityCode("cross_origin_forbidden")
  );
});

test("CSRF validation accepts same-origin and origin-less clients with a valid token", () => {
  assert.doesNotThrow(() => validateMutationRequest(
    request({ origin: "http://127.0.0.1:8787", csrf: "valid" }),
    "valid"
  ));
  assert.doesNotThrow(() => validateMutationRequest(request({ csrf: "valid" }), "valid"));
  assert.doesNotThrow(() => validateMutationRequest(request({ method: "GET" }), undefined));
});
