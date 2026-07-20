import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebAuthError, WebAuthService } from "../src/web-auth.js";

test("registers the first user as admin and authenticates its session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "luanniao-auth-"));
  try {
    const auth = new WebAuthService(join(directory, "auth.sqlite"));
    const result = await auth.register({ username: "Admin.User", displayName: "管理员", password: "secure-pass-123" });

    assert.equal(result.user.username, "admin.user");
    assert.equal(result.user.role, "admin");
    assert.deepEqual(auth.authenticate(result.token), result.user);

    auth.logout(result.token);
    assert.equal(auth.authenticate(result.token), undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("creates later users as analysts and rejects invalid credentials", async () => {
  const directory = mkdtempSync(join(tmpdir(), "luanniao-auth-"));
  try {
    const auth = new WebAuthService(join(directory, "auth.sqlite"));
    await auth.register({ username: "owner", displayName: "Owner", password: "secure-pass-123" });
    const analyst = await auth.register({ username: "analyst", displayName: "Analyst", password: "another-pass-456" });

    assert.equal(analyst.user.role, "analyst");
    await assert.rejects(
      auth.login({ username: "analyst", password: "wrong-password" }),
      (error) => error instanceof WebAuthError && error.code === "invalid_credentials"
    );
    const login = await auth.login({ username: "analyst", password: "another-pass-456" });
    assert.equal(login.user.id, analyst.user.id);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
