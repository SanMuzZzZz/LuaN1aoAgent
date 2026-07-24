import assert from "node:assert/strict";
import test from "node:test";
import { operationIdentityKeys } from "../src/operation-identity.js";
import type { GraphEdge, GraphNode } from "../src/types.js";

test("operation identities agree between explicit properties and graph topology", () => {
  const explicitNodes: GraphNode[] = [
    { id: "port:explicit", graphKind: "operation", type: "Port", label: "8000/TCP", properties: { host: "60.205.226.234", port: 8000, protocol: "tcp" } },
    { id: "service:explicit", graphKind: "operation", type: "Service", label: "HTTP", properties: { host: "60.205.226.234", port: 8000, protocol: "http" } },
    { id: "endpoint:explicit", graphKind: "operation", type: "WebEndpoint", label: "GET /flag", properties: { url: "http://60.205.226.234:8000/flag", method: "GET" } },
    { id: "parameter:explicit", graphKind: "operation", type: "Parameter", label: "query id", properties: { endpoint: "http://60.205.226.234:8000/flag", location: "query", name: "id" } }
  ];
  const topologyNodes: GraphNode[] = [
    { id: "host:topology", graphKind: "operation", type: "Host", label: "60.205.226.234", properties: {} },
    { id: "port:topology", graphKind: "operation", type: "Port", label: "8000/TCP", properties: {} },
    { id: "service:topology", graphKind: "operation", type: "Service", label: "HTTP on 8000", properties: {} },
    { id: "endpoint:topology", graphKind: "operation", type: "WebEndpoint", label: "GET /flag", properties: {} },
    { id: "parameter:topology", graphKind: "operation", type: "Parameter", label: "id", properties: { location: "query" } }
  ];
  const topologyEdges: GraphEdge[] = [
    { from: "host:topology", to: "port:topology", type: "has_port" },
    { from: "port:topology", to: "service:topology", type: "runs_service" },
    { from: "service:topology", to: "endpoint:topology", type: "exposes_endpoint" },
    { from: "endpoint:topology", to: "parameter:topology", type: "has_parameter" }
  ];
  const explicit = operationIdentityKeys(explicitNodes, []);
  const topology = operationIdentityKeys(topologyNodes, topologyEdges);

  assert.equal(topology.get("port:topology"), explicit.get("port:explicit"));
  assert.equal(topology.get("service:topology"), explicit.get("service:explicit"));
  assert.equal(topology.get("endpoint:topology"), explicit.get("endpoint:explicit"));
  assert.equal(topology.get("parameter:topology"), explicit.get("parameter:explicit"));
});
