import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  TrafficProxyClient,
  TrafficProxyControlError,
  type TrafficProxyContext
} from "../src/connectivity/traffic-proxy-client.js";

async function controlServer(handler: (request: Record<string, unknown>, socket: Socket) => void) {
  const dir = await mkdtemp(join(tmpdir(), "traffic-proxy-client-"));
  const socketPath = join(dir, "control.sock");
  const server = createServer((socket) => {
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk.toString("utf8");
      const newline = input.indexOf("\n");
      if (newline >= 0) handler(JSON.parse(input.slice(0, newline)) as Record<string, unknown>, socket);
    });
  });
  await new Promise<void>((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
  return {
    socketPath,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  };
}

function response(request: Record<string, unknown>, result: unknown = undefined) {
  return JSON.stringify({ version: 1, id: request.id, ok: true, ...(result === undefined ? {} : { result }) }) + "\n";
}

test("client sends v1 NDJSON commands and validates response identity", async () => {
  const fixture = await controlServer((request, socket) => {
    assert.equal(request.version, 1);
    assert.equal(request.command, "set");
    assert.equal(request.field, "route_ref");
    assert.equal(request.value, "web-run");
    socket.end(response(request));
  });
  try {
    await new TrafficProxyClient(fixture.socketPath).set("route_ref", "web-run");
  } finally {
    await fixture.close();
  }
});

test("client enforces request timeout and the Go-compatible 1MiB response limit", async () => {
  const timeoutFixture = await controlServer(() => undefined);
  try {
    await assert.rejects(new TrafficProxyClient(timeoutFixture.socketPath, { timeoutMs: 20 }).health(), /timed out/);
  } finally {
    await timeoutFixture.close();
  }

  const validFixture = await controlServer((request, socket) => {
    socket.end(response(request, "x".repeat(65 * 1024)));
  });
  try {
    const result = await new TrafficProxyClient(validFixture.socketPath).historyBody(1, "response") as unknown as string;
    assert.equal(result.length, 65 * 1024);
  } finally {
    await validFixture.close();
  }

  const largeFixture = await controlServer((request, socket) => {
    socket.end(JSON.stringify({ version: 1, id: request.id, ok: true, result: "x".repeat(1024 * 1024) }) + "\n");
  });
  try {
    await assert.rejects(new TrafficProxyClient(largeFixture.socketPath).status(), /exceeds 1MiB/);
  } finally {
    await largeFixture.close();
  }
});

test("replay uses its dedicated longer timeout", async () => {
  const fixture = await controlServer((request, socket) => {
    setTimeout(() => socket.end(response(request, { exchange_id: 2, replay_of: 1, status: 200 })), 40);
  });
  try {
    const client = new TrafficProxyClient(fixture.socketPath, { timeoutMs: 20, replayTimeoutMs: 100 });
    const result = await client.replay({
      exchange_id: 1,
      context: {
        runtime_ref: "runtime-1",
        task_ref: "",
        run_ref: "",
        attribution: "web-user:user-1:admin",
        route_ref: "",
        session_ref: ""
      }
    });
    assert.deepEqual(result, { exchange_id: 2, replay_of: 1, status: 200 });
  } finally {
    await fixture.close();
  }
});

test("attribution scope restores context after an exception", async () => {
  const context: TrafficProxyContext = { runtime_ref: "runtime-1", task_ref: "task-1", run_ref: "run-1", attribution: "original", route_ref: "base", session_ref: "session-1" };
  const fixture = await controlServer((request, socket) => {
    const command = request.command;
    if (command === "status") socket.end(response(request, { uptime_seconds: 1, requests: 0, context: { ...context } }));
    else if (command === "set") {
      context[request.field as keyof TrafficProxyContext] = String(request.value);
      socket.end(response(request));
    } else if (command === "clear") {
      context[request.field as keyof TrafficProxyContext] = "";
      socket.end(response(request));
    }
  });
  try {
    const client = new TrafficProxyClient(fixture.socketPath);
    await assert.rejects(client.withAttributionScope(
      { task_ref: "task-2", run_ref: "run-2", attribution: "security-agent", route_ref: "tool-call", session_ref: "session-2" },
      async () => {
        assert.deepEqual((await client.status()).context, {
          runtime_ref: "runtime-1",
          task_ref: "task-2",
          run_ref: "run-2",
          attribution: "security-agent",
          route_ref: "tool-call",
          session_ref: "session-2"
        });
        throw new Error("operation failed");
      }
    ), /operation failed/);
    assert.deepEqual(context, { runtime_ref: "runtime-1", task_ref: "task-1", run_ref: "run-1", attribution: "original", route_ref: "base", session_ref: "session-1" });
  } finally {
    await fixture.close();
  }
});

test("client rejects oversized requests before connecting", async () => {
  const client = new TrafficProxyClient("/missing/control.sock");
  await assert.rejects(client.set("session_ref", "x".repeat(65 * 1024)), TrafficProxyControlError);
});

test("client sends the complete replay shape including duplicate headers and context", async () => {
  let replayRequest: Record<string, unknown> | undefined;
  const fixture = await controlServer((request, socket) => {
    replayRequest = request;
    socket.end(response(request, { exchange_id: 91, replay_of: 42, status: 202 }));
  });
  try {
    const result = await new TrafficProxyClient(fixture.socketPath).replay({
      exchange_id: 42,
      method: "PATCH",
      url: "https://example.test/replay",
      headers: [
        { name: "X-Repeat", value: "one", ordinal: 0 },
        { name: "X-Repeat", value: "two", ordinal: 1 }
      ],
      body: { encoding: "base64", data: "dGVzdA==" },
      route_ref: "route-1",
      session_ref: "session-1",
      context: {
        runtime_ref: "runtime-1",
        task_ref: "task-1",
        run_ref: "run-1",
        attribution: "web-user:user-1:admin",
        route_ref: "route-1",
        session_ref: "session-1"
      }
    });
    assert.deepEqual(result, { exchange_id: 91, replay_of: 42, status: 202 });
    assert.deepEqual(withoutId(replayRequest!), {
      version: 1,
      command: "replay",
      exchange_id: 42,
      method: "PATCH",
      url: "https://example.test/replay",
      headers: [
        { name: "X-Repeat", value: "one", ordinal: 0 },
        { name: "X-Repeat", value: "two", ordinal: 1 }
      ],
      body: { encoding: "base64", data: "dGVzdA==" },
      route_ref: "route-1",
      session_ref: "session-1",
      context: {
        runtime_ref: "runtime-1",
        task_ref: "task-1",
        run_ref: "run-1",
        attribution: "web-user:user-1:admin",
        route_ref: "route-1",
        session_ref: "session-1"
      }
    });
  } finally {
    await fixture.close();
  }
});

test("client preserves replay error code and failed result", async () => {
  const fixture = await controlServer((request, socket) => {
    socket.end(JSON.stringify({
      version: 1,
      id: request.id,
      ok: false,
      error: "secret upstream message",
      error_code: "source_not_replayable",
      result: { exchange_id: 92, replay_of: 42, status: 0, error_code: "source_not_replayable" }
    }) + "\n");
  });
  try {
    await assert.rejects(
      new TrafficProxyClient(fixture.socketPath).replay({
        exchange_id: 42,
        context: {
          runtime_ref: "runtime-1",
          task_ref: "",
          run_ref: "",
          attribution: "web-user:user-1:admin",
          route_ref: "",
          session_ref: ""
        }
      }),
      (error: unknown) => {
        assert(error instanceof TrafficProxyControlError);
        assert.equal(error.errorCode, "source_not_replayable");
        assert.deepEqual(error.result, { exchange_id: 92, replay_of: 42, status: 0, error_code: "source_not_replayable" });
        return true;
      }
    );
  } finally {
    await fixture.close();
  }
});

test("client sends history list, detail, and body protocol fields", async () => {
  const commands: Record<string, unknown>[] = [];
  const fixture = await controlServer((request, socket) => {
    commands.push(request);
    const result = request.command === "history_list"
      ? { items: [], has_more: false }
      : request.command === "history_get"
        ? { id: 42 }
        : { exchange_id: 42, side: "response", encoding: "base64", data: "", bytes: 0, truncated: false };
    socket.end(response(request, result));
  });
  try {
    const client = new TrafficProxyClient(fixture.socketPath);
    await client.historyList({ cursor: "NDI", limit: 25, filter: { method: "GET", status: 200 } });
    await client.historyGet(42);
    await client.historyBody(42, "response", 4096);
    assert.deepEqual(commands.map(({ id: _id, ...command }) => command), [
      { version: 1, command: "history_list", cursor: "NDI", limit: 25, filter: { method: "GET", status: 200 } },
      { version: 1, command: "history_get", exchange_id: 42 },
      { version: 1, command: "history_body", exchange_id: 42, side: "response", byte_limit: 4096 }
    ]);
  } finally {
    await fixture.close();
  }
});

test("managed HTTP scope composes route/session references and restores all changed fields", async () => {
  const context: TrafficProxyContext = { runtime_ref: "runtime-1", task_ref: "task-old", run_ref: "run-old", attribution: "original", route_ref: "route-old", session_ref: "session-old" };
  const fixture = await controlServer((request, socket) => {
    if (request.command === "status") socket.end(response(request, { uptime_seconds: 1, requests: 0, context: { ...context } }));
    else if (request.command === "set") {
      context[request.field as keyof TrafficProxyContext] = String(request.value);
      socket.end(response(request));
    } else if (request.command === "clear") {
      context[request.field as keyof TrafficProxyContext] = "";
      socket.end(response(request));
    }
  });
  try {
    const client = new TrafficProxyClient(fixture.socketPath);
    const observed = await client.withManagedHttpScope({
      routeRef: "route-managed",
      sessionRef: "session-managed",
      taskRef: "task-new",
      runRef: "run-new",
      attribution: "managed-http"
    }, async () => (await client.status()).context);
    assert.deepEqual(observed, {
      runtime_ref: "runtime-1",
      task_ref: "task-new",
      run_ref: "run-new",
      attribution: "managed-http",
      route_ref: "route-managed",
      session_ref: "session-managed"
    });
    assert.deepEqual(context, { runtime_ref: "runtime-1", task_ref: "task-old", run_ref: "run-old", attribution: "original", route_ref: "route-old", session_ref: "session-old" });
    await assert.rejects(client.withManagedHttpScope({ routeRef: "", sessionRef: "session" }, async () => undefined), /routeRef is invalid/);
  } finally {
    await fixture.close();
  }
});

function withoutId(request: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, ...fields } = request;
  return fields;
}
