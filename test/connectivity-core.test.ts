import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChiselAdapter } from "../src/connectivity/chisel-adapter.js";
import {
  NodeProcessDriver,
  type ManagedProcess,
  type ProcessDriver,
  type ProcessOutputStream
} from "../src/connectivity/process-driver.js";
import { SessionBroker } from "../src/connectivity/session-broker.js";
import { TunnelManager } from "../src/connectivity/tunnel-manager.js";
import { OperationalTopology } from "../src/operational-topology.js";
import { ConnectivityStore } from "../src/stores/connectivity-store.js";
import { SQLiteGraphStore } from "../src/stores/graph-store.js";

class FakeProcess implements ManagedProcess {
  readonly pid = 4242;
  running = true;
  terminated = false;
  private readonly outputListeners: Array<(stream: ProcessOutputStream, chunk: string) => void> = [];
  private readonly exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  private readonly errorListeners: Array<(error: Error) => void> = [];

  isRunning(): boolean { return this.running; }
  onOutput(listener: (stream: ProcessOutputStream, chunk: string) => void): void { this.outputListeners.push(listener); }
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void { this.exitListeners.push(listener); }
  onError(listener: (error: Error) => void): void { this.errorListeners.push(listener); }
  terminateGroup(): void { this.terminated = true; this.running = false; }
  output(stream: ProcessOutputStream, chunk: string): void { this.outputListeners.forEach((listener) => listener(stream, chunk)); }
  error(error: Error): void {
    this.running = false;
    this.errorListeners.forEach((listener) => listener(error));
  }
  exit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.running = false;
    this.exitListeners.forEach((listener) => listener(code, signal));
  }
}

class FakeDriver implements ProcessDriver {
  readonly calls: Array<{ command: string; argv: readonly string[]; options?: { env?: NodeJS.ProcessEnv; stdin?: string } }> = [];
  readonly processes: FakeProcess[] = [];
  onSpawn?: (process: FakeProcess) => void;

  spawn(command: string, argv: readonly string[], options?: { env?: NodeJS.ProcessEnv; stdin?: string }): ManagedProcess {
    const process = new FakeProcess();
    this.calls.push({ command, argv, options });
    this.processes.push(process);
    this.onSpawn?.(process);
    return process;
  }
}

function fixture(): {
  dir: string;
  graph: SQLiteGraphStore;
  store: ConnectivityStore;
  topology: OperationalTopology;
} {
  const dir = mkdtempSync(join(tmpdir(), "luanniao-connectivity-core-"));
  const graph = new SQLiteGraphStore(join(dir, "state.sqlite"), join(dir, "graph-deltas.jsonl"));
  graph.upsertDelta({
    sourceEventIds: [],
    nodes: [
      { id: "host:a", graphKind: "operation", type: "Host", label: "A", properties: {} },
      { id: "host:b", graphKind: "operation", type: "Host", label: "B", properties: {} }
    ],
    edges: []
  });
  return { dir, graph, store: new ConnectivityStore(join(dir, "state.sqlite")), topology: new OperationalTopology(graph) };
}

test("TunnelManager builds strict SSH argv, redacts bounded output, and stops the process group", async () => {
  const { dir, graph, store, topology } = fixture();
  const driver = new FakeDriver();
  const manager = new TunnelManager(store, topology, dir, {
    processDriver: driver,
    credentialResolver: () => "/runtime/keys/operator",
    sshProbe: async () => true,
    outputLimit: 32
  });
  const definition = manager.define({
    externalId: "pivot-1",
    fromHostRef: "host:a",
    toHostRef: "host:b",
    host: "gateway.example",
    user: "operator",
    credentialRef: "credential:ssh-operator",
    controlMaster: true,
    forwards: [
      { mode: "local", bindHost: "127.0.0.1", bindPort: 8080, targetHost: "10.0.0.5", targetPort: 80 },
      { mode: "remote", bindPort: 9000, targetHost: "127.0.0.1", targetPort: 9001 },
      { mode: "dynamic", bindPort: 1080 }
    ]
  });
  const live = await manager.start(definition.id);
  assert.equal(live.status, "live");
  assert.equal(driver.calls[0].command, "ssh");
  assert.deepEqual(driver.calls[0].argv.slice(0, 8), ["-N", "-T", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "StrictHostKeyChecking=yes"]);
  assert.ok(driver.calls[0].argv.includes(`UserKnownHostsFile=${manager.knownHostsPath}`));
  assert.ok(driver.calls[0].argv.includes("127.0.0.1:8080:10.0.0.5:80"));
  assert.equal(JSON.stringify(store.getDefinition(definition.id)).includes("/runtime/keys/operator"), false);
  driver.processes[0].output("stderr", `password=hunter2 ${"x".repeat(40)}`);
  assert.equal(manager.output(definition.id).includes("hunter2"), false);
  assert.ok(manager.output(definition.id).length <= 32);
  const edge = graph.query("operation", [], 100).edges.find((candidate) => candidate.id === "tunnel:pivot-1");
  assert.equal(edge?.type, "tunnels_to");
  await manager.stop(definition.id);
  assert.equal(driver.processes[0].terminated, true);
  assert.equal(store.getDefinition(definition.id)?.desiredState, "stopped");
  store.close();
  graph.close();
});

test("TunnelManager rejects argv injection and recovery requires process/control plus SSH probes", async () => {
  const { dir, graph, store, topology } = fixture();
  const manager = new TunnelManager(store, topology, dir, {
    processProbe: async () => true,
    sshProbe: async (definition) => definition.externalId === "healthy",
    baseBackoffMs: 10
  });
  assert.throws(() => manager.define({
    externalId: "bad",
    fromHostRef: "host:a",
    toHostRef: "host:b",
    host: "-oProxyCommand=bad",
    forwards: [{ mode: "dynamic", bindPort: 1080 }]
  }), /Invalid host/);
  const healthy = manager.define({ externalId: "healthy", fromHostRef: "host:a", toHostRef: "host:b", host: "gateway", forwards: [{ mode: "dynamic", bindPort: 1080 }] });
  const broken = manager.define({ externalId: "broken", fromHostRef: "host:a", toHostRef: "host:b", host: "gateway", forwards: [{ mode: "dynamic", bindPort: 1081 }] });
  store.updateStatus(healthy.id, "live");
  store.updateStatus(broken.id, "live");
  const recovered = await manager.recover();
  assert.equal(recovered.find(({ id }) => id === healthy.id)?.status, "live");
  assert.equal(recovered.find(({ id }) => id === broken.id)?.status, "stale");
  assert.match(String(store.getDefinition(broken.id)?.definition.lastFailureReason), /SSH recovery probe failed/);
  assert.ok(manager.nextRetryAt(broken.id));
  store.close();
  graph.close();
});

test("ChiselAdapter is optional, allowlists a real binary, and injects token only in runtime env", async () => {
  const dir = mkdtempSync(join(tmpdir(), "luanniao-chisel-"));
  const binary = join(dir, "chisel");
  writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  chmodSync(binary, 0o700);
  const driver = new FakeDriver();
  const adapter = new ChiselAdapter({
    binaryPath: binary,
    allowedBinaries: [binary],
    allowedRoots: [dir],
    processDriver: driver,
    credentialResolver: () => "runtime-only-token"
  });
  assert.equal(adapter.availability().available, true);
  await adapter.start({ mode: "client", server: "https://gateway.example", routes: ["8080:127.0.0.1:80"], tokenCredentialRef: "credential:chisel" });
  assert.equal(driver.calls[0].argv.includes("runtime-only-token"), false);
  assert.equal(driver.calls[0].options?.env?.AUTH, "runtime-only-token");
  assert.deepEqual(adapter.buildArgv({ mode: "server", port: 8443, reverse: true }), ["server", "--port", "8443", "--reverse"]);

  const link = join(dir, "chisel-link");
  symlinkSync(binary, link);
  const linked = new ChiselAdapter({ binaryPath: link, allowedBinaries: [link], allowedRoots: [dir] });
  assert.equal(linked.availability().available, false);
  const missing = new ChiselAdapter({ allowedBinaries: [], allowedRoots: [dir] });
  assert.match(missing.availability().reason ?? "", /not configured/);
});

test("SessionBroker persists SSH definitions, enforces exclusive leases, and run releases without closing", async () => {
  const { dir, graph, store, topology } = fixture();
  const driver = new FakeDriver();
  driver.onSpawn = (process) => queueMicrotask(() => {
    process.output("stdout", "ok\n");
    process.exit(0);
  });
  const broker = new SessionBroker(store, topology, dir, {
    processDriver: driver,
    credentialResolver: () => "/runtime/key"
  });
  const definition = broker.defineSsh({
    externalId: "shell-ssh",
    sessionType: "shell",
    hostRef: "host:a",
    host: "gateway.example",
    user: "operator",
    credentialRef: "credential:ssh"
  });
  const held = broker.claim(definition.id, "run:held", 10_000);
  assert.ok(held);
  await assert.rejects(() => broker.run({
    sessionRef: definition.id,
    ownerId: "run:blocked",
    leaseTtlMs: 1_000,
    command: { argv: ["id"], timeoutMs: 500 }
  }), /already leased/);
  broker.release(held);
  const result = await broker.run({
    sessionRef: definition.id,
    ownerId: "run:1",
    leaseTtlMs: 1_000,
    command: { argv: ["printf", "%s", "hello world"], stdin: "input", timeoutMs: 500 }
  });
  assert.equal(result.stdout, "ok\n");
  assert.equal(result.timedOut, false);
  assert.equal(driver.calls[0].options?.stdin, "input");
  assert.deepEqual(driver.calls[0].argv.slice(-3), ["operator@gateway.example", "--", "'printf' '%s' 'hello world'"]);
  assert.equal(store.listLeases().length, 0);
  assert.equal(store.getDefinition(definition.id)?.desiredState, "running");
  assert.notEqual(store.getDefinition(definition.id)?.status, "closed");

  const observed = broker.observeUnmanaged({ externalId: "venom-1", hostRef: "host:b", adapter: "venom", sessionType: "agent" });
  assert.equal(observed.status, "stale");
  await assert.rejects(() => broker.run({ sessionRef: observed.id, ownerId: "run:2", leaseTtlMs: 1_000, command: { argv: ["id"], timeoutMs: 100 } }), /no managed transport/);
  store.close();
  graph.close();
});

test("NodeProcessDriver reports asynchronous spawn errors", async () => {
  const child = new NodeProcessDriver().spawn("/definitely/missing/luanniao-command", []);
  const error = await new Promise<Error>((resolve) => child.onError(resolve));
  assert.match(error.message, /ENOENT/);
  assert.equal(child.isRunning(), false);
});

test("TunnelManager serializes starts and ignores exit from an obsolete process", async () => {
  const { dir, graph, store, topology } = fixture();
  const driver = new FakeDriver();
  const manager = new TunnelManager(store, topology, dir, {
    processDriver: driver,
    sshProbe: async () => true
  });
  const definition = manager.define({
    externalId: "serialized",
    fromHostRef: "host:a",
    toHostRef: "host:b",
    host: "gateway",
    forwards: [{ mode: "dynamic", bindPort: 1080 }]
  });
  await Promise.all([manager.start(definition.id), manager.start(definition.id)]);
  assert.equal(driver.processes.length, 1);

  const obsolete = driver.processes[0];
  obsolete.running = false;
  await manager.start(definition.id);
  const current = driver.processes[1];
  current.output("stderr", "current output");
  obsolete.exit(1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(manager.output(definition.id), "current output");
  assert.equal(store.getDefinition(definition.id)?.status, "live");
  store.close();
  graph.close();
});

test("TunnelManager handles child errors and redacts secrets split across chunks", async () => {
  const { dir, graph, store, topology } = fixture();
  const driver = new FakeDriver();
  const manager = new TunnelManager(store, topology, dir, {
    processDriver: driver,
    credentialResolver: () => "/runtime/secret-key",
    sshProbe: async () => true
  });
  const definition = manager.define({
    externalId: "errors",
    fromHostRef: "host:a",
    toHostRef: "host:b",
    host: "gateway",
    credentialRef: "credential:key",
    forwards: [{ mode: "dynamic", bindPort: 1080 }]
  });
  await manager.start(definition.id);
  driver.processes[0].output("stderr", "identity=/runtime/sec");
  driver.processes[0].output("stderr", "ret-key password=hun");
  driver.processes[0].output("stderr", "ter2\n");
  assert.equal(manager.output(definition.id).includes("secret-key"), false);
  assert.equal(manager.output(definition.id).includes("hunter2"), false);
  driver.processes[0].error(new Error("spawn failed"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.match(String(store.getDefinition(definition.id)?.definition.lastFailureReason), /spawn failed/);
  store.close();
  graph.close();
});

test("SessionBroker keeps the lease until timed-out child exit and quotes remote argv", async () => {
  const { dir, graph, store, topology } = fixture();
  const driver = new FakeDriver();
  const broker = new SessionBroker(store, topology, dir, { processDriver: driver });
  const definition = broker.defineSsh({ externalId: "timeout", hostRef: "host:a", host: "gateway" });
  const pending = broker.run({
    sessionRef: definition.id,
    ownerId: "run:timeout",
    leaseTtlMs: 1_000,
    command: { argv: ["printf", "hello world", "a'b", "$(id)"], timeoutMs: 10 }
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(driver.processes[0].terminated, true);
  assert.equal(store.listLeases().length, 1);
  assert.deepEqual(driver.calls[0].argv.slice(-3), ["gateway", "--", "'printf' 'hello world' 'a'\"'\"'b' '$(id)'"]);
  driver.processes[0].exit(null, "SIGTERM");
  const result = await pending;
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, "SIGTERM");
  assert.equal(store.listLeases().length, 0);
  store.close();
  graph.close();
});

test("SessionBroker rejects child process errors and releases its lease", async () => {
  const { dir, graph, store, topology } = fixture();
  const driver = new FakeDriver();
  driver.onSpawn = (process) => queueMicrotask(() => process.error(new Error("ssh spawn error")));
  const broker = new SessionBroker(store, topology, dir, { processDriver: driver });
  const definition = broker.defineSsh({ externalId: "spawn-error", hostRef: "host:a", host: "gateway" });
  await assert.rejects(() => broker.run({
    sessionRef: definition.id,
    ownerId: "run:error",
    leaseTtlMs: 1_000,
    command: { argv: ["id"], timeoutMs: 500 }
  }), /ssh spawn error/);
  assert.equal(store.listLeases().length, 0);
  store.close();
  graph.close();
});
