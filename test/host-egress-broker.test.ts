import assert from "node:assert/strict";
import { createServer, createConnection } from "node:net";
import { networkInterfaces } from "node:os";
import test from "node:test";
import { egressBrokerPortCandidates, HostEgressBroker } from "../src/connectivity/host-egress-broker.js";

const magic = Buffer.from("LNDB1", "ascii");

test("egress broker port candidates stay below the ephemeral range", () => {
  const candidates = egressBrokerPortCandidates(undefined);
  assert.equal(candidates[0], 47610);
  assert.ok(candidates.every((port) => port < 49152), "pool must avoid the macOS ephemeral range");
  assert.equal(new Set(candidates).size, candidates.length);
});

test("egress broker port candidates honor a fixed override", () => {
  assert.deepEqual(egressBrokerPortCandidates("47642"), [47642]);
  assert.throws(() => egressBrokerPortCandidates("not-a-port"));
  assert.throws(() => egressBrokerPortCandidates("80"));
  assert.throws(() => egressBrokerPortCandidates("70000"));
});

test("host egress broker binds inside the managed pool and skips occupied ports", async (context) => {
  const squatter = createServer();
  await new Promise<void>((resolve) => squatter.listen(47610, "0.0.0.0", resolve));
  context.after(() => new Promise<void>((resolve) => squatter.close(() => resolve())));

  const previousOverride = process.env.LUANNIAO_EGRESS_BROKER_PORT;
  delete process.env.LUANNIAO_EGRESS_BROKER_PORT;
  context.after(() => {
    if (previousOverride === undefined) delete process.env.LUANNIAO_EGRESS_BROKER_PORT;
    else process.env.LUANNIAO_EGRESS_BROKER_PORT = previousOverride;
  });

  const broker = new HostEgressBroker();
  const endpoint = await broker.start();
  context.after(() => broker.close());
  assert.equal(endpoint.port, 47611, "first occupied pool port must be skipped");
  assert.ok(endpoint.port < 49152);
});

test("host egress broker honors the port override", async (context) => {
  const previousOverride = process.env.LUANNIAO_EGRESS_BROKER_PORT;
  process.env.LUANNIAO_EGRESS_BROKER_PORT = "47999";
  context.after(() => {
    if (previousOverride === undefined) delete process.env.LUANNIAO_EGRESS_BROKER_PORT;
    else process.env.LUANNIAO_EGRESS_BROKER_PORT = previousOverride;
  });

  const broker = new HostEgressBroker();
  const endpoint = await broker.start();
  context.after(() => broker.close());
  assert.equal(endpoint.port, 47999);
});

test("host egress broker reports real refusal and relays accepted connections", async (context) => {
  const target = createServer((socket) => socket.end("target-response"));
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve) => target.close(() => resolve())));
  const targetAddress = target.address();
  assert.ok(targetAddress && typeof targetAddress !== "string");

  const broker = new HostEgressBroker();
  const endpoint = await broker.start();
  context.after(() => broker.close());
  const accepted = await brokerDial("127.0.0.1", endpoint.port, endpoint.token, "127.0.0.1", targetAddress.port);
  assert.equal(accepted.code, 1, "loopback targets must be denied at the host boundary");

  const interfaceAddress = Object.values(networkInterfaces()).flat()
    .find((value) => value?.family === "IPv4" && !value.internal)?.address;
  assert.ok(interfaceAddress, "test host needs a non-loopback IPv4 interface");
  const publicTarget = createServer((socket) => socket.end("ok"));
  await new Promise<void>((resolve) => publicTarget.listen(0, "0.0.0.0", resolve));
  const publicAddress = publicTarget.address();
  assert.ok(publicAddress && typeof publicAddress !== "string");
  const relayed = await brokerDial("127.0.0.1", endpoint.port, endpoint.token, interfaceAddress, publicAddress.port);
  assert.equal(relayed.code, 0);
  assert.equal(relayed.body.toString(), "ok");
  await new Promise<void>((resolve) => publicTarget.close(() => resolve()));
  const refused = await brokerDial("127.0.0.1", endpoint.port, endpoint.token, interfaceAddress, publicAddress.port);
  assert.equal(refused.code, 1);
});

test("host egress broker rejects invalid authentication", async (context) => {
  const broker = new HostEgressBroker();
  const endpoint = await broker.start();
  context.after(() => broker.close());
  const result = await brokerDial("127.0.0.1", endpoint.port, "00".repeat(32), "1.1.1.1", 80);
  assert.equal(result.code, -1);
});

test("host egress broker logs rejections without leaking the token in debug mode", async (context) => {
  const broker = new HostEgressBroker();
  const endpoint = await broker.start();
  context.after(() => broker.close());
  const previousDebug = process.env.LUANNIAO_DEBUG;
  process.env.LUANNIAO_DEBUG = "1";
  context.after(() => {
    if (previousDebug === undefined) delete process.env.LUANNIAO_DEBUG;
    else process.env.LUANNIAO_DEBUG = previousDebug;
  });
  const messages: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { messages.push(args.map(String).join(" ")); };
  context.after(() => { console.error = originalError; });

  const rejected = await brokerDial("127.0.0.1", endpoint.port, "00".repeat(32), "1.1.1.1", 80);
  assert.equal(rejected.code, -1);
  const denied = await brokerDial("127.0.0.1", endpoint.port, endpoint.token, "127.0.0.1", 80);
  assert.equal(denied.code, 1);

  assert.ok(
    messages.some((message) => message.includes("bad magic or token")),
    `missing handshake rejection log: ${messages}`
  );
  assert.ok(
    messages.some((message) => message.includes("denied target 127.0.0.1:80")),
    `missing denied target log: ${messages}`
  );
  assert.ok(
    messages.every((message) => !message.includes(endpoint.token)),
    "logs must never contain the broker token"
  );
});

test("host egress broker stays silent when debug mode is off", async (context) => {
  const broker = new HostEgressBroker();
  const endpoint = await broker.start();
  context.after(() => broker.close());
  const previousDebug = process.env.LUANNIAO_DEBUG;
  delete process.env.LUANNIAO_DEBUG;
  context.after(() => {
    if (previousDebug !== undefined) process.env.LUANNIAO_DEBUG = previousDebug;
  });
  const messages: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { messages.push(args.map(String).join(" ")); };
  context.after(() => { console.error = originalError; });

  const rejected = await brokerDial("127.0.0.1", endpoint.port, "00".repeat(32), "1.1.1.1", 80);
  assert.equal(rejected.code, -1);
  assert.deepEqual(messages, []);
});

test("host egress broker close terminates established relay connections", async (context) => {
  const interfaceAddress = Object.values(networkInterfaces()).flat()
    .find((value) => value?.family === "IPv4" && !value.internal)?.address;
  assert.ok(interfaceAddress, "test host needs a non-loopback IPv4 interface");

  const targetSocketAccepted = deferred<void>();
  const target = createServer(() => targetSocketAccepted.resolve());
  await new Promise<void>((resolve) => target.listen(0, "0.0.0.0", resolve));
  context.after(() => new Promise<void>((resolve) => target.close(() => resolve())));
  const targetAddress = target.address();
  assert.ok(targetAddress && typeof targetAddress !== "string");

  const broker = new HostEgressBroker();
  const endpoint = await broker.start();
  const relay = createConnection({ host: "127.0.0.1", port: endpoint.port });
  const relayClosed = new Promise<void>((resolve) => relay.once("close", () => resolve()));
  const accepted = new Promise<void>((resolve, reject) => {
    relay.once("connect", () => {
      const request = Buffer.alloc(43);
      magic.copy(request);
      Buffer.from(endpoint.token, "hex").copy(request, 5);
      interfaceAddress.split(".").map(Number).forEach((value, index) => { request[37 + index] = value; });
      request.writeUInt16BE(targetAddress.port, 41);
      relay.write(request);
    });
    relay.once("data", (chunk) => {
      if (chunk[0] === 0) resolve();
      else reject(new Error(`broker rejected relay with code ${chunk[0] ?? -1}`));
    });
    relay.once("error", reject);
  });
  await accepted;
  await targetSocketAccepted.promise;

  await broker.close();
  await relayClosed;
});

async function brokerDial(
  brokerHost: string,
  brokerPort: number,
  token: string,
  targetHost: string,
  targetPort: number
): Promise<{ code: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: brokerHost, port: brokerPort });
    const chunks: Buffer[] = [];
    socket.once("connect", () => {
      const request = Buffer.alloc(43);
      magic.copy(request);
      Buffer.from(token, "hex").copy(request, 5);
      targetHost.split(".").map(Number).forEach((value, index) => { request[37 + index] = value; });
      request.writeUInt16BE(targetPort, 41);
      socket.write(request);
    });
    socket.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    socket.on("error", reject);
    socket.on("close", () => {
      const payload = Buffer.concat(chunks);
      resolve({ code: payload.length > 0 ? payload[0]! : -1, body: payload.subarray(1) });
    });
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}
