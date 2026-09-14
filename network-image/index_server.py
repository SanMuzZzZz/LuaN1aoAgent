from __future__ import annotations

import argparse
from dataclasses import dataclass, field
import ipaddress
import json
import os
import re
import signal
import socket
import stat
import subprocess
import threading
import time
import base64
from datetime import datetime, timezone
from typing import Callable
from urllib.parse import parse_qs, unquote, urlparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from mitmproxy import http, io, tcp
from mitmproxy.exceptions import FlowReadException
from conntrack_telemetry import AGENT_INTENT_MARK, ConntrackEpochTracker, stream_conntrack_epochs
from segmented_capture import capture_quota_state
from scope_dns import ScopeDnsProxy

REPLAY_BODY_LIMIT = int(os.environ.get("LUANNIAO_CAPTURE_BYTES", str(1 << 20)))
CONTROL_REQUEST_LIMIT = 1 << 20
ROUTES_PATH = Path(os.environ.get("LUANNIAO_ROUTES_FILE", "/run/luanniao/routes.json"))
GATEWAY_TUN_NAME = "luanniao0"
GATEWAY_ROUTE_TABLE = "4242"
GATEWAY_READY = Path("/run/luanniao/gateway-tun.ready")
CONNTRACK_ACCT_PATH = Path("/proc/sys/net/netfilter/nf_conntrack_acct")
CAPTURE_STATUS_PATH = Path(os.environ.get(
    "LUANNIAO_CAPTURE_STATUS", "/run/luanniao/capture/status.json"
))
CONNTRACK_STATUS_PATH = Path(os.environ.get(
    "LUANNIAO_CONNTRACK_STATUS", "/run/luanniao/conntrack-status.json"
))
GATEWAY_DRAIN_TIMEOUT_SECONDS = float(os.environ.get("LUANNIAO_GATEWAY_DRAIN_TIMEOUT_S", "15"))
ROUTE_GUARD_CHAIN = "LUANNIAO_ROUTE_GUARD"
SCOPE_GUARD_CHAIN = "LUANNIAO_SCOPE_GUARD"
SCOPE_NFT_TABLE = "luanniao_scope"
SCOPE_NFT_SET = "allowed4"


def json_line(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as output:
        output.write(json.dumps(value, separators=(",", ":")) + "\n")


def iso_timestamp(value: float) -> str:
    return datetime.fromtimestamp(value, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def flow_record(path: Path, flow, quota: dict | None = None) -> dict:
    metadata = dict(flow.metadata)
    started = metadata.get("replayStartedAt", flow.timestamp_start)
    completed = getattr(flow, "timestamp_end", None)
    if isinstance(flow, http.HTTPFlow):
        completed = (flow.response.timestamp_end if flow.response else None) or flow.request.timestamp_end or completed
    if isinstance(flow, tcp.TCPFlow):
        completed = flow.server_conn.timestamp_end or flow.client_conn.timestamp_end or completed
    completed = metadata.get("replayCompletedAt", completed or started)
    base = {
        "id": f"{metadata.get('taskRef', path.parent.name)}:{flow.id}",
        "flow_id": flow.id,
        "task_ref": metadata.get("taskRef", ""),
        "run_ref": metadata.get("runRef", ""),
        "epoch_ref": metadata.get("epochRef", ""),
        "route_ref": metadata.get("routeRef", ""),
        "connection_ref": metadata.get("connectionRef", metadata.get("sessionRef", "")),
        "session_ref": metadata.get("sessionRef", ""),
        "replay_of": metadata.get("replayOf", ""),
        "attribution": metadata.get("attribution", ""),
        "runtime_ref": metadata.get("runtimeRef", metadata.get("runRef", "")),
        "started_at": iso_timestamp(started),
        "completed_at": iso_timestamp(completed),
        "duration_ms": max(0, int((completed - started) * 1000)),
        "error": str(flow.error) if flow.error else "",
        "source_file": str(path),
        "quota_pressure": bool((quota or {}).get("quota_pressure", False)),
        "evicted_exchanges": int((quota or {}).get("evicted_records", 0)),
    }
    if isinstance(flow, http.HTTPFlow):
        request = flow.request
        response = flow.response
        base.update({
            "kind": "http", "method": request.method, "url": request.pretty_url,
            "host": request.host, "scheme": request.scheme, "protocol": request.http_version,
            "mode": "replay" if metadata.get("replayOf") or flow.is_replay == "request" else "mitm",
            "status": response.status_code if response else 0,
            "request_body": request.raw_content or b"", "response_body": response.raw_content if response and response.raw_content else b"",
            "request_headers": list(request.headers.items(multi=True)),
            "response_headers": list(response.headers.items(multi=True)) if response else [],
            "request_truncated": bool(metadata.get("requestBodyTruncated")),
            "response_truncated": bool(metadata.get("responseBodyTruncated")),
            "request_observed_bytes": int(metadata.get("requestObservedBytes", len(request.raw_content or b""))),
            "response_observed_bytes": int(metadata.get("responseObservedBytes", len(response.raw_content or b"") if response else 0)),
        })
    elif isinstance(flow, tcp.TCPFlow):
        server = flow.server_conn.address or ("", 0)
        request_body = b"".join(message.content for message in flow.messages if message.from_client)
        response_body = b"".join(message.content for message in flow.messages if not message.from_client)
        request_observed_bytes = int(metadata.get("requestObservedBytes", len(request_body)))
        response_observed_bytes = int(metadata.get("responseObservedBytes", len(response_body)))
        base.update({
            "kind": "tcp", "method": "TCP", "url": f"tcp://{server[0]}:{server[1]}",
            "host": f"{server[0]}:{server[1]}", "scheme": "tcp", "protocol": "TCP",
            "mode": "passthrough", "status": 200 if not flow.error else 0,
            "request_body": request_body, "response_body": response_body,
            "request_headers": [], "response_headers": [],
            "request_truncated": bool(metadata.get("requestBodyTruncated", request_observed_bytes > len(request_body))),
            "response_truncated": bool(metadata.get("responseBodyTruncated", response_observed_bytes > len(response_body))),
            "request_observed_bytes": request_observed_bytes,
            "response_observed_bytes": response_observed_bytes,
            "request_message_count": sum(1 for message in flow.messages if message.from_client),
            "response_message_count": sum(1 for message in flow.messages if not message.from_client),
        })
    else:
        return {}
    return base


def native_flow_record(path: Path, value: dict, quota: dict | None = None) -> dict:
    if value.get("format") != "luanniao-flow-v1" or not value.get("id"):
        return {}
    record = dict(value)
    try:
        record["request_body"] = base64.b64decode(record.pop("request_body_base64", ""), validate=True)
        record["response_body"] = base64.b64decode(record.pop("response_body_base64", ""), validate=True)
    except (ValueError, TypeError) as error:
        raise ValueError("invalid native flow body encoding") from error
    record.pop("format", None)
    record["runtime_ref"] = record.get("run_ref", "")
    record["source_file"] = str(path)
    record["quota_pressure"] = bool((quota or {}).get("quota_pressure", False))
    record["evicted_exchanges"] = int((quota or {}).get("evicted_records", 0))
    return record


@dataclass
class IndexedFlowFile:
    identity: tuple[int, int]
    path: Path
    committed_offset: int = 0
    records: list[dict] = field(default_factory=list)


class FlowIndex:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.lock = threading.RLock()
        self.files: dict[tuple[int, int], IndexedFlowFile] = {}

    def records(self) -> list[dict]:
        with self.lock:
            discovered = self._discover_files()
            present = set(discovered)
            for identity in set(self.files) - present:
                del self.files[identity]
            for identity, (path, size) in discovered.items():
                indexed = self.files.get(identity)
                if indexed is None:
                    indexed = IndexedFlowFile(identity, path)
                    self.files[identity] = indexed
                else:
                    indexed.path = path
                if size < indexed.committed_offset:
                    indexed.committed_offset = 0
                    indexed.records.clear()
                quota = capture_quota_state(path, ".mitm", "evictedExchanges")
                self._refresh_record_metadata(indexed, quota)
                if size > indexed.committed_offset:
                    self._read_appended_records(indexed, quota)
            records = [dict(record) for indexed in self.files.values() for record in indexed.records]
            records.sort(key=lambda value: (value["started_at"], value["id"]), reverse=True)
            return records

    def _discover_files(self) -> dict[tuple[int, int], tuple[Path, int]]:
        discovered: dict[tuple[int, int], tuple[Path, int]] = {}
        for path in sorted(self.root.glob("**/*.mitm")):
            try:
                details = path.stat()
            except OSError:
                continue
            if not stat.S_ISREG(details.st_mode):
                continue
            identity = (details.st_dev, details.st_ino)
            discovered.setdefault(identity, (path, details.st_size))
        return discovered

    @staticmethod
    def _refresh_record_metadata(indexed: IndexedFlowFile, quota: dict) -> None:
        for record in indexed.records:
            record["source_file"] = str(indexed.path)
            record["quota_pressure"] = bool(quota.get("quota_pressure", False))
            record["evicted_exchanges"] = int(quota.get("evicted_records", 0))

    @staticmethod
    def _read_appended_records(indexed: IndexedFlowFile, quota: dict) -> None:
        try:
            with indexed.path.open("rb") as source:
                first_byte = source.read(1)
                source.seek(indexed.committed_offset)
                if first_byte == b"{":
                    while True:
                        start = source.tell()
                        line = source.readline()
                        if not line:
                            break
                        if not line.endswith(b"\n"):
                            source.seek(start)
                            break
                        try:
                            value = json.loads(line)
                            record = native_flow_record(indexed.path, value, quota)
                        except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
                            break
                        indexed.committed_offset = source.tell()
                        if record:
                            indexed.records.append(record)
                    return
                source.seek(indexed.committed_offset)
                try:
                    for flow in io.FlowReader(source).stream():
                        record = flow_record(indexed.path, flow, quota)
                        indexed.committed_offset = source.tell()
                        if record:
                            indexed.records.append(record)
                except (FlowReadException, EOFError):
                    pass
        except OSError:
            pass

class Handler(BaseHTTPRequestHandler):
    server_version = "luanniao-flow-index/1"

    def _authorized(self) -> bool:
        return self.headers.get("Authorization") == f"Bearer {self.server.token}"

    def _send(self, status: int, value: dict) -> None:
        body = json.dumps(value, default=lambda item: item.hex() if isinstance(item, bytes) else str(item), separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if not self._authorized():
            self._send(401, {"error": "unauthorized"})
            return
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self._send(200, {"status": "ok"})
            return
        records = self.server.index.records()
        if parsed.path.startswith("/history/"):
            suffix = parsed.path.split("/history/", 1)[1]
            body_side = None
            if suffix.endswith("/body"):
                suffix = suffix[:-5].rstrip("/")
                body_side = parse_qs(parsed.query).get("side", ["response"])[0]
            flow_ref = unquote(suffix)
            record = next((item for item in records if item["id"] == flow_ref), None)
            if not record:
                self._send(404, {"error": "not_found"})
            elif body_side:
                byte_limit = min(max(int(parse_qs(parsed.query).get("byte_limit", [256 << 10])[0]), 1), REPLAY_BODY_LIMIT)
                self._send(200, body_record(record, flow_ref, body_side, byte_limit))
            else:
                self._send(200, {"record": public_record(record, True)})
            return
        query = parse_qs(parsed.query)
        for key in ("task_ref", "run_ref", "route_ref", "connection_ref", "session_ref", "epoch_ref", "replay_of", "mode", "method", "host"):
            if key in query:
                records = [record for record in records if str(record.get(key, "")).lower().find(query[key][0].lower()) >= 0]
        if "status" in query:
            records = [record for record in records if record.get("status") == int(query["status"][0])]
        if "error" in query:
            requested_error = query["error"][0].lower()
            if requested_error in ("true", "false"):
                records = [record for record in records if bool(record.get("error")) == (requested_error == "true")]
            else:
                records = [record for record in records if requested_error in str(record.get("error", "")).lower()]
        if "started_after" in query:
            records = [record for record in records if record["started_at"] > query["started_after"][0]]
        if "started_before" in query:
            records = [record for record in records if record["started_at"] < query["started_before"][0]]
        limit = min(max(int(query.get("limit", [100])[0]), 1), 500)
        cursor = max(int(query.get("cursor", [0])[0]), 0)
        page = records[cursor:cursor + limit]
        self._send(200, {"records": [public_record(record, False) for record in page], "has_more": cursor + limit < len(records), "next_cursor": str(cursor + limit) if cursor + limit < len(records) else None})

    def do_POST(self) -> None:
        if not self._authorized():
            self._send(401, {"error": "unauthorized"})
            return
        self._send(405, {"error": "read_only_index"})

    def log_message(self, _format: str, *_args) -> None:
        return


def public_record(record: dict, include_headers: bool) -> dict:
    output = {key: value for key, value in record.items() if key not in {"request_body", "response_body", "source_file", "request_headers", "response_headers"}}
    output.update({
        "request_observed_bytes": record["request_observed_bytes"],
        "response_observed_bytes": record["response_observed_bytes"],
        "request_captured_bytes": len(record["request_body"]),
        "response_captured_bytes": len(record["response_body"]),
        "request_capture_state": "truncated" if record["request_truncated"] else ("captured" if record["request_body"] else "none"),
        "response_capture_state": "truncated" if record["response_truncated"] else ("captured" if record["response_body"] else "none"),
        "headers_truncated": False,
        "quota_pressure": bool(record.get("quota_pressure", False)),
        "evicted_exchanges": int(record.get("evicted_exchanges", 0)),
    })
    if record["request_body"]:
        output["request_body_ref"] = f"{record['id']}:request"
    if record["response_body"]:
        output["response_body_ref"] = f"{record['id']}:response"
    if include_headers:
        output["request_headers"] = [{"name": name, "value": value, "ordinal": index} for index, (name, value) in enumerate(record["request_headers"])]
        output["response_headers"] = [{"name": name, "value": value, "ordinal": index} for index, (name, value) in enumerate(record["response_headers"])]
    return output


def body_record(record: dict, flow_ref: str, body_side: str, byte_limit: int) -> dict:
    original = record["request_body"] if body_side == "request" else record["response_body"]
    content = original[:byte_limit]
    return {
        "exchange_id": flow_ref,
        "side": body_side,
        "body_ref": f"{flow_ref}:{body_side}",
        "encoding": "base64",
        "data": base64.b64encode(content).decode(),
        "bytes": len(content),
        "truncated": bool(record[f"{body_side}_truncated"]) or len(original) > byte_limit,
    }


def _unprivileged_gate_command() -> list[str]:
    return [
        "setpriv", "--reuid=101", "--regid=101", "--clear-groups",
        "--pdeathsig", "TERM",
        "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs",
        "gateway-tun",
    ]


def gateway_tun_command() -> list[str]:
    command = [
        *_unprivileged_gate_command(),
        "--mode", "unified", "--tun", GATEWAY_TUN_NAME,
        "--routes-file", str(ROUTES_PATH),
        "--direct-broker", os.environ["LUANNIAO_DIRECT_BROKER"],
        "--direct-broker-token", os.environ["LUANNIAO_DIRECT_BROKER_TOKEN"],
        "--local-direct-host", "host.docker.internal",
        "--deny-cidrs", f"{os.environ['LUANNIAO_TASK_NETWORK_CIDR']},{os.environ['LUANNIAO_CONTROL_NETWORK_CIDR']}",
        "--allow-cidrs", os.environ["LUANNIAO_AUTHORIZED_CIDRS"],
        "--local-direct-deny-ports", os.environ.get("LUANNIAO_LOCAL_DIRECT_DENY_PORTS", ""),
        "--epoch-file", "/run/luanniao/epoch.json",
        "--capture-status", str(CAPTURE_STATUS_PATH),
        "--ca-cert", "/traffic/ca/mitmproxy-ca-cert.pem",
        "--ca-key", "/traffic/ca/luanniao-ca-key.pem",
        "--run-ref", os.environ.get("LUANNIAO_RUN_REF", ""),
        "--task-ref", os.environ.get("LUANNIAO_TASK_REF", ""),
        "--ready-file", str(GATEWAY_READY),
        "--max-inflight", "8192",
    ]
    if _authorized_domains():
        command.append("--allow-domain-resolved")
    if os.environ.get("LUANNIAO_DEBUG", "").lower() in ("1", "true", "yes"):
        command.append("--debug")
    return command


def _authorized_domains() -> list[str]:
    return [
        value.strip() for value in os.environ.get("LUANNIAO_AUTHORIZED_DOMAINS", "").split(",")
        if value.strip()
    ]


class GatewayControl:
    def __init__(
        self,
        socket_path: str,
        ready: threading.Event,
        epoch_state: Path,
        flow_root: Path,
        routes_path: Path = ROUTES_PATH,
        capture_status_path: Path = CAPTURE_STATUS_PATH,
        conntrack_status_path: Path = CONNTRACK_STATUS_PATH,
        active_connection_drain: Callable[[], int] | None = None,
        drain_timeout_seconds: float = GATEWAY_DRAIN_TIMEOUT_SECONDS,
        network_epoch_drain: Callable[[str], None] | None = None,
        route_guard_replace: Callable[[list[dict]], None] | None = None,
    ) -> None:
        self.socket_path = socket_path
        self.ready = ready
        self.epoch_state = epoch_state
        self.flow_root = flow_root.resolve()
        self.routes_path = routes_path
        self.capture_status_path = capture_status_path
        self.conntrack_status_path = conntrack_status_path
        self.active_connection_drain = active_connection_drain or drain_executor_connections
        self.network_epoch_drain = network_epoch_drain
        self.drain_timeout_seconds = max(0.1, drain_timeout_seconds)
        self.route_guard_replace = route_guard_replace

    def serve(self) -> None:
        Path(self.socket_path).parent.mkdir(parents=True, exist_ok=True)
        try:
            os.unlink(self.socket_path)
        except FileNotFoundError:
            pass
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(self.socket_path)
        os.chmod(self.socket_path, 0o600)
        server.listen()
        while True:
            connection, _ = server.accept()
            with connection:
                try:
                    request = self._read_request(connection)
                    result = {}
                    if request.get("command") == "routes.replace":
                        if not self.ready.is_set():
                            raise RuntimeError("gateway data plane is not ready")
                        self.replace_routes(request.get("payload", {}).get("routes", []))
                    elif request.get("command") == "epoch.begin":
                        if not self.ready.is_set():
                            raise RuntimeError("gateway data plane is not ready")
                        self.begin_epoch(request.get("payload", {}))
                    elif request.get("command") == "epoch.end":
                        result = self.end_epoch(request.get("payload", {}))
                    elif request.get("command") == "health":
                        if not self.ready.is_set():
                            raise RuntimeError("gateway data plane is not ready")
                    else:
                        raise ValueError("unknown command")
                    connection.sendall((json.dumps({
                        "ok": True,
                        "result": result,
                    }, separators=(",", ":")) + "\n").encode())
                except Exception as error:
                    connection.sendall((json.dumps({"ok": False, "error": str(error)}) + "\n").encode())

    def replace_routes(self, routes: list[dict]) -> None:
        if not isinstance(routes, list) or len(routes) > 1024:
            raise ValueError("routes must be a list with at most 1024 entries")
        ordered: list[dict] = []
        seen_cidrs: set[str] = set()
        for route in routes:
            if not isinstance(route, dict):
                raise ValueError("route must be an object")
            route_ref = self._route_string(route.get("routeRef"), "routeRef", 512)
            network = ipaddress.ip_network(str(route.get("cidr", "")), strict=False)
            if network.version != 4:
                raise ValueError("only IPv4 route CIDRs are supported")
            prefix_length = int(route.get("prefixLength", -1))
            if prefix_length != network.prefixlen:
                raise ValueError("prefixLength must match cidr")
            cidr = str(network)
            if cidr in seen_cidrs:
                raise ValueError(f"duplicate route CIDR: {cidr}")
            seen_cidrs.add(cidr)
            socks_host = self._route_string(route.get("socksHost"), "socksHost", 253)
            socks_port = int(route.get("socksPort", 0))
            if not 1 <= socks_port <= 65535:
                raise ValueError("socksPort must be between 1 and 65535")
            normalized = {
                "routeRef": route_ref,
                "cidr": cidr,
                "prefixLength": prefix_length,
                "socksHost": socks_host,
                "socksPort": socks_port,
            }
            connection_ref = route.get("connectionRef") or route.get("sessionRef")
            if connection_ref:
                normalized["connectionRef"] = self._route_string(connection_ref, "connectionRef", 512)
            ordered.append(normalized)
        ordered.sort(key=lambda item: (-item["prefixLength"], item["cidr"], item["routeRef"]))
        if self.route_guard_replace:
            self.route_guard_replace(ordered)
        self._write_routes({"routes": ordered})

    @staticmethod
    def _read_request(connection: socket.socket) -> dict:
        payload = bytearray()
        while True:
            chunk = connection.recv(min(64 << 10, CONTROL_REQUEST_LIMIT + 1 - len(payload)))
            if not chunk:
                break
            payload.extend(chunk)
            newline = payload.find(b"\n")
            if newline >= 0:
                payload = payload[:newline]
                break
            if len(payload) > CONTROL_REQUEST_LIMIT:
                raise ValueError("gateway control request exceeds 1 MiB")
        if len(payload) > CONTROL_REQUEST_LIMIT:
            raise ValueError("gateway control request exceeds 1 MiB")
        if not payload:
            raise ValueError("empty gateway control request")
        value = json.loads(payload.decode())
        if not isinstance(value, dict):
            raise ValueError("gateway control request must be an object")
        return value

    @staticmethod
    def _route_string(value: object, field: str, maximum: int) -> str:
        if not isinstance(value, str) or not value or len(value) > maximum:
            raise ValueError(f"invalid {field}")
        if any(ord(character) < 32 for character in value):
            raise ValueError(f"invalid {field}")
        return value

    def _write_routes(self, value: dict) -> None:
        self.routes_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.routes_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(value, separators=(",", ":")), encoding="utf-8")
        os.chmod(temporary, 0o644)
        temporary.replace(self.routes_path)

    def begin_epoch(self, payload: dict) -> None:
        epoch_ref = str(payload.get("epochRef", ""))
        if not epoch_ref or len(epoch_ref) > 256 or "\x00" in epoch_ref:
            raise ValueError("invalid epochRef")
        flow_file = self._capture_path(payload.get("flowFile"), ".mitm")
        net_file = self._capture_path(payload.get("netFile"), ".net.jsonl")
        for path in (flow_file, net_file):
            path.parent.mkdir(parents=True, exist_ok=True)
            os.chown(path.parent, 101, 101)
            path.touch(exist_ok=True)
            os.chmod(path, 0o664)
            os.chown(path, 101, 101)
        self._write_epoch({
            "active": True,
            "epochRef": epoch_ref,
            "flowFile": str(flow_file),
            "netFile": str(net_file),
        })

    def end_epoch(self, payload: dict) -> dict:
        epoch_ref = str(payload.get("epochRef", ""))
        try:
            current = json.loads(self.epoch_state.read_text(encoding="utf-8"))
        except (FileNotFoundError, OSError, json.JSONDecodeError) as error:
            if epoch_ref:
                raise RuntimeError("gateway epoch state is unavailable") from error
            return self._empty_drain_ack(epoch_ref)
        current_epoch_ref = str(current.get("epochRef", ""))
        if epoch_ref and current_epoch_ref != epoch_ref:
            raise RuntimeError(
                f"gateway epoch mismatch: active={current_epoch_ref or '<none>'} requested={epoch_ref}"
            )
        epoch_ref = current_epoch_ref or epoch_ref
        deadline = time.monotonic() + self.drain_timeout_seconds
        stable_snapshot = None
        stable_observations = 0
        final_flow = {}
        final_network = {}
        while True:
            active_kernel_connections = self.active_connection_drain()
            final_flow = self._epoch_status(self.capture_status_path, epoch_ref)
            final_network = self._epoch_status(self.conntrack_status_path, epoch_ref)
            capture_error = str(final_flow.get("error", ""))
            network_error = str(final_network.get("error", ""))
            if capture_error or network_error:
                raise RuntimeError(
                    f"capture persistence failed: {capture_error or network_error}"
                )
            snapshot = (
                int(final_flow.get("activeFlowCount", 0)),
                int(final_flow.get("activeTcpCount", 0)),
                int(final_network.get("activeNetworkCount", 0)),
                active_kernel_connections,
                int(final_flow.get("persistedSequence", 0)),
                int(final_network.get("persistedSequence", 0)),
            )
            if snapshot[0] == 0 and snapshot[1] == 0 and snapshot[3] == 0 and snapshot[2] > 0 and self.network_epoch_drain:
                self.network_epoch_drain(epoch_ref)
                final_network = self._epoch_status(self.conntrack_status_path, epoch_ref)
                snapshot = (
                    snapshot[0],
                    snapshot[1],
                    int(final_network.get("activeNetworkCount", 0)),
                    snapshot[3],
                    snapshot[4],
                    int(final_network.get("persistedSequence", 0)),
                )
            if snapshot[:4] == (0, 0, 0, 0):
                # Stability is anchored on the flow persistence sequence only.
                # The conntrack/network sequence keeps moving on destroy
                # bookkeeping (e.g. after full-port scans) and must not block
                # the stability window once nothing is active.
                drain_signature = snapshot[:5]
                if drain_signature == stable_snapshot:
                    stable_observations += 1
                else:
                    stable_snapshot = drain_signature
                    stable_observations = 1
                if stable_observations >= 3:
                    break
            else:
                stable_snapshot = None
                stable_observations = 0
            if time.monotonic() >= deadline:
                raise RuntimeError(
                    "gateway epoch drain timed out "
                    f"(active_flows={snapshot[0]}, active_tcp={snapshot[1]}, "
                    f"active_network={snapshot[2]}, kernel_connections={snapshot[3]}, "
                    f"flow_seq={snapshot[4]}, net_seq={snapshot[5]})"
                )
            time.sleep(0.05)

        flow_file = Path(str(current.get("flowFile", "")))
        net_file = Path(str(current.get("netFile", "")))
        self._write_epoch({**current, "active": False})
        flow_bytes = self._flush_capture_family(flow_file, ".mitm")
        net_bytes = self._flush_capture_family(net_file, ".net.jsonl")
        ack = {
            "epochRef": epoch_ref,
            "activeFlowCount": 0,
            "activeTcpCount": 0,
            "activeNetworkCount": 0,
            "persistedFlowSequence": int(final_flow.get("persistedSequence", 0)),
            "persistedNetworkSequence": int(final_network.get("persistedSequence", 0)),
            "flowBytes": flow_bytes,
            "netBytes": net_bytes,
            "flushed": True,
        }
        self._write_epoch({**current, "active": False, "drainAck": ack})
        return ack

    @staticmethod
    def _epoch_status(path: Path, epoch_ref: str) -> dict:
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (FileNotFoundError, OSError, json.JSONDecodeError):
            return {}
        epochs = value.get("epochs", {}) if isinstance(value, dict) else {}
        status = epochs.get(epoch_ref, {}) if isinstance(epochs, dict) else {}
        return status if isinstance(status, dict) else {}

    @staticmethod
    def _flush_capture_family(path: Path, suffix: str) -> int:
        if not path.name.endswith(suffix):
            raise RuntimeError(f"capture path does not end with {suffix}")
        prefix = path.name[:-len(suffix)]
        files = [path, *sorted(path.parent.glob(f"{prefix}.part-*-n*{suffix}"))]
        quota_path = Path(f"{path}.quota.json")
        if quota_path.exists():
            files.append(quota_path)
        total_bytes = 0
        for candidate in files:
            try:
                details = candidate.stat()
            except OSError:
                continue
            if not stat.S_ISREG(details.st_mode):
                raise RuntimeError(f"capture path is not a regular file: {candidate}")
            descriptor = os.open(candidate, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
            if candidate.name.endswith(suffix):
                total_bytes += details.st_size
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        return total_bytes

    @staticmethod
    def _empty_drain_ack(epoch_ref: str) -> dict:
        return {
            "epochRef": epoch_ref,
            "activeFlowCount": 0,
            "activeTcpCount": 0,
            "activeNetworkCount": 0,
            "persistedFlowSequence": 0,
            "persistedNetworkSequence": 0,
            "flowBytes": 0,
            "netBytes": 0,
            "flushed": True,
        }

    def _capture_path(self, value: object, suffix: str) -> Path:
        path = Path(str(value or ""))
        resolved = path.resolve()
        if not str(path).endswith(suffix) or not resolved.is_relative_to(self.flow_root):
            raise ValueError("capture path is outside the task flow root")
        return resolved

    def _write_epoch(self, value: dict) -> None:
        temporary = self.epoch_state.with_suffix(".tmp")
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
        try:
            payload = json.dumps(value, separators=(",", ":")).encode()
            view = memoryview(payload)
            while view:
                written = os.write(descriptor, view)
                if written <= 0:
                    raise OSError("epoch state write made no progress")
                view = view[written:]
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        temporary.replace(self.epoch_state)


def drain_executor_connections() -> int:
    mark = f"{AGENT_INTENT_MARK:#x}/0xffffffff"
    deleted = subprocess.run(
        ["conntrack", "-D", "--mark", mark],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    if deleted.returncode not in (0, 1):
        raise RuntimeError(f"failed to drain executor conntrack entries: {deleted.stderr.strip()}")
    listed = subprocess.run(
        ["conntrack", "-L", "-o", "extended"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if listed.returncode not in (0, 1):
        raise RuntimeError(f"failed to inspect executor conntrack entries: {listed.stderr.strip()}")
    active = 0
    for line in listed.stdout.splitlines():
        match = re.search(r"(?:^|\s)mark=(0x[0-9a-fA-F]+|[0-9]+)(?:\s|$)", line)
        if match and int(match.group(1), 0) == AGENT_INTENT_MARK:
            active += 1
    return active

def _gateway_networks() -> tuple[ipaddress.IPv4Network, ipaddress.IPv4Network]:
    task_network = ipaddress.ip_network(os.environ["LUANNIAO_TASK_NETWORK_CIDR"], strict=False)
    control_network = ipaddress.ip_network(os.environ["LUANNIAO_CONTROL_NETWORK_CIDR"], strict=False)
    if task_network.version != 4 or control_network.version != 4 or task_network.overlaps(control_network):
        raise RuntimeError("gateway task and control networks must be distinct IPv4 CIDRs")
    return task_network, control_network


def wait_for_gateway_networks() -> str:
    task_network, control_network = _gateway_networks()
    for _ in range(100):
        addresses = json.loads(subprocess.run(
            ["ip", "-j", "-4", "address", "show"], check=True,
            stdout=subprocess.PIPE, text=True,
        ).stdout)
        task_address = ""
        has_control = False
        for interface in addresses:
            for address in interface.get("addr_info", []):
                candidate = ipaddress.ip_address(address.get("local", "0.0.0.0"))
                if candidate in task_network:
                    task_address = str(candidate)
                if candidate in control_network:
                    has_control = True
        if task_address and has_control:
            return task_address
        time.sleep(0.1)
    raise RuntimeError("gateway did not receive both task and control network interfaces")


def replace_route_guard(routes: list[dict]) -> None:
    subprocess.run(["iptables", "-F", ROUTE_GUARD_CHAIN], check=True)
    for route in routes:
        for protocol in ("udp", "icmp"):
            subprocess.run([
                "iptables", "-A", ROUTE_GUARD_CHAIN,
                "-d", route["cidr"], "-p", protocol,
                "-j", "REJECT",
            ], check=True)


def configure_gateway_firewall(task_address: str) -> None:
    task_network, control_network = _gateway_networks()
    authorized_networks = [
        ipaddress.ip_network(value.strip(), strict=False)
        for value in os.environ["LUANNIAO_AUTHORIZED_CIDRS"].split(",")
        if value.strip()
    ]
    authorized_domains = _authorized_domains()
    if (not authorized_networks and not authorized_domains) or any(network.version != 4 for network in authorized_networks):
        raise RuntimeError("gateway authorized scope must contain IPv4 CIDRs or domains")
    subprocess.run(["ip", "tuntap", "add", "dev", GATEWAY_TUN_NAME, "mode", "tun", "user", "101", "group", "101"], check=True)
    subprocess.run(["ip", "link", "set", "dev", GATEWAY_TUN_NAME, "up"], check=True)
    subprocess.run(["ip", "route", "add", "default", "dev", GATEWAY_TUN_NAME, "table", GATEWAY_ROUTE_TABLE], check=True)
    subprocess.run([
        "ip", "rule", "add", "priority", "100", "fwmark",
        f"{AGENT_INTENT_MARK:#x}/0xffffffff", "lookup", GATEWAY_ROUTE_TABLE
    ], check=True)
    subprocess.run(["ip", "rule", "add", "priority", "200", "lookup", "local"], check=True)
    subprocess.run(["ip", "rule", "del", "priority", "0", "lookup", "local"], check=True)
    subprocess.run(["iptables", "-N", ROUTE_GUARD_CHAIN], check=True)
    if authorized_domains:
        subprocess.run(["nft", "add", "table", "ip", SCOPE_NFT_TABLE], check=True)
        subprocess.run([
            "nft", "add", "set", "ip", SCOPE_NFT_TABLE, SCOPE_NFT_SET,
            "{", "type", "ipv4_addr", ";", "flags", "timeout", ";", "timeout", "5m", ";", "}"
        ], check=True)
        subprocess.run([
            "nft", "add", "chain", "ip", SCOPE_NFT_TABLE, "forward",
            "{", "type", "filter", "hook", "forward", "priority", "-1", ";", "policy", "accept", ";", "}"
        ], check=True)
        subprocess.run([
            "nft", "add", "rule", "ip", SCOPE_NFT_TABLE, "forward",
            "ip", "saddr", str(task_network), "ip", "daddr", f"@{SCOPE_NFT_SET}", "accept"
        ], check=True)
        for network in authorized_networks:
            subprocess.run([
                "nft", "add", "rule", "ip", SCOPE_NFT_TABLE, "forward",
                "ip", "saddr", str(task_network), "ip", "daddr", str(network), "accept"
            ], check=True)
        subprocess.run([
            "nft", "add", "rule", "ip", SCOPE_NFT_TABLE, "forward",
            "ip", "saddr", str(task_network), "reject"
        ], check=True)
    else:
        subprocess.run(["iptables", "-N", SCOPE_GUARD_CHAIN], check=True)
        for network in authorized_networks:
            subprocess.run([
                "iptables", "-A", SCOPE_GUARD_CHAIN, "-d", str(network), "-j", "RETURN"
            ], check=True)
        subprocess.run(["iptables", "-A", SCOPE_GUARD_CHAIN, "-j", "REJECT"], check=True)
    subprocess.run([
        "iptables", "-t", "mangle", "-A", "PREROUTING",
        "-s", str(task_network), "-m", "conntrack", "--ctstate", "NEW",
        "-j", "CONNMARK", "--set-mark", f"{AGENT_INTENT_MARK:#x}/0xffffffff"
    ], check=True)
    if os.environ.get("LUANNIAO_TRUSTED_REPLAY") == "1":
        subprocess.run([
            "iptables", "-t", "mangle", "-A", "OUTPUT",
            "-m", "owner", "--uid-owner", "1000", "-p", "tcp",
            "-m", "conntrack", "--ctstate", "NEW",
            "-j", "CONNMARK", "--set-mark", f"{AGENT_INTENT_MARK:#x}/0xffffffff"
        ], check=True)
        subprocess.run([
            "iptables", "-t", "mangle", "-A", "OUTPUT",
            "-m", "owner", "--uid-owner", "1000", "-p", "tcp",
            "-j", "MARK", "--set-mark", f"{AGENT_INTENT_MARK:#x}/0xffffffff"
        ], check=True)
    subprocess.run([
        "iptables", "-t", "mangle", "-A", "PREROUTING",
        "-s", str(task_network), "-p", "tcp",
        "-j", "MARK", "--set-mark", f"{AGENT_INTENT_MARK:#x}/0xffffffff"
    ], check=True)
    for protocol in ("udp", "tcp"):
        subprocess.run([
            "iptables", "-A", "INPUT", "-s", str(task_network),
            "-d", f"{task_address}/32", "-p", protocol, "--dport", "53", "-j", "ACCEPT"
        ], check=True)
    subprocess.run([
        "iptables", "-A", "INPUT", "-s", str(task_network), "-j", "REJECT"
    ], check=True)
    subprocess.run([
        "iptables", "-A", "FORWARD", "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT"
    ], check=True)
    subprocess.run([
        "iptables", "-A", "FORWARD", "-s", str(task_network), "-d", str(control_network), "-j", "REJECT"
    ], check=True)
    if not authorized_domains:
        subprocess.run([
            "iptables", "-A", "FORWARD", "-s", str(task_network), "-j", SCOPE_GUARD_CHAIN
        ], check=True)
    subprocess.run([
        "iptables", "-A", "FORWARD", "-s", str(task_network), "-j", ROUTE_GUARD_CHAIN
    ], check=True)
    subprocess.run([
        "iptables", "-A", "FORWARD", "-s", str(task_network), "-j", "ACCEPT"
    ], check=True)
    subprocess.run([
        "iptables", "-A", "FORWARD", "-d", str(task_network), "-j", "REJECT"
    ], check=True)
    subprocess.run([
        "iptables", "-t", "nat", "-A", "POSTROUTING", "-s", str(task_network), "-j", "MASQUERADE"
    ], check=True)


def authorize_domain_address(address: str, ttl: int) -> None:
    try:
        subprocess.run([
            "nft", "add", "element", "ip", SCOPE_NFT_TABLE, SCOPE_NFT_SET,
            "{", address, "timeout", f"{ttl}s", "}"
        ], check=True)
    except subprocess.CalledProcessError as error:
        raise OSError(f"failed to authorize DNS address {address}") from error


def publish_gateway_ready(
    ready: threading.Event,
    *,
    ca_ready: bool,
    gate_ready: bool,
    capture_ready: bool,
) -> bool:
    if not (ca_ready and gate_ready and capture_ready):
        return False
    ready.set()
    return True


def file_is_nonempty(path: Path) -> bool:
    try:
        return path.stat().st_size > 0
    except OSError:
        return False


def capture_writer_is_ready(path: Path = CAPTURE_STATUS_PATH) -> bool:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return False
    return isinstance(value, dict) and value.get("ready") is True


def prepare_tun_gate_ready_file(path: Path) -> None:
    path.unlink(missing_ok=True)
    os.chmod(path.parent, 0o733)
    try:
        subprocess.run([
            "setpriv", "--reuid=101", "--regid=101", "--clear-groups",
            "install", "-m", "0600", "/dev/null", str(path),
        ], check=True)
    finally:
        os.chmod(path.parent, 0o755)


def ensure_conntrack_accounting(path: Path = CONNTRACK_ACCT_PATH) -> None:
    try:
        enabled = path.read_text(encoding="utf-8").strip()
    except OSError as error:
        raise RuntimeError("conntrack accounting status is unavailable") from error
    if enabled != "1":
        raise RuntimeError("conntrack accounting is disabled")


def gateway() -> None:
    ca_path = Path("/traffic/ca")
    flow_root = Path(os.environ["LUANNIAO_TASK_FLOW_ROOT"])
    epoch_state = Path("/run/luanniao/epoch.json")
    flow_root.mkdir(parents=True, exist_ok=True)
    ca_path.mkdir(parents=True, exist_ok=True)
    epoch_state.parent.mkdir(parents=True, exist_ok=True)
    epoch_state.write_text('{"active":false}', encoding="utf-8")
    os.chmod(epoch_state, 0o644)
    CAPTURE_STATUS_PATH.parent.mkdir(parents=True, exist_ok=True)
    CAPTURE_STATUS_PATH.write_text('{"ready":false,"epochs":{}}', encoding="utf-8")
    os.chmod(CAPTURE_STATUS_PATH, 0o664)
    CONNTRACK_STATUS_PATH.write_text('{"epochs":{}}', encoding="utf-8")
    os.chmod(CONNTRACK_STATUS_PATH, 0o664)
    ready = threading.Event()
    task_address = wait_for_gateway_networks()
    conntrack_tracker = ConntrackEpochTracker(CONNTRACK_STATUS_PATH)
    control = GatewayControl(
        "/run/luanniao/gateway.sock",
        ready,
        epoch_state,
        flow_root,
        ROUTES_PATH,
        CAPTURE_STATUS_PATH,
        CONNTRACK_STATUS_PATH,
        network_epoch_drain=conntrack_tracker.close_epoch,
        route_guard_replace=replace_route_guard,
    )
    configure_gateway_firewall(task_address)
    control.replace_routes([])
    threading.Thread(target=control.serve, daemon=True).start()
    ensure_conntrack_accounting()
    telemetry = subprocess.Popen(
        ["conntrack", "-E", "-o", "timestamp,extended"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    telemetry_thread = threading.Thread(
        target=stream_conntrack_epochs,
        args=(telemetry.stdout, {
            "run_ref": os.environ.get("LUANNIAO_RUN_REF", ""),
            "task_ref": os.environ.get("LUANNIAO_TASK_REF", ""),
        }, ROUTES_PATH, epoch_state, AGENT_INTENT_MARK, CONNTRACK_STATUS_PATH, conntrack_tracker),
        daemon=True,
    )
    telemetry_thread.start()
    dns = ScopeDnsProxy(
        task_address,
        _authorized_domains(),
        authorize_domain_address,
        allow_unmatched=bool(os.environ.get("LUANNIAO_AUTHORIZED_CIDRS", "").strip()),
    )
    dns.start()
    ca_cert = ca_path / "mitmproxy-ca-cert.pem"
    prepare_tun_gate_ready_file(GATEWAY_READY)
    gate = subprocess.Popen(gateway_tun_command())
    for _ in range(100):
        if telemetry.poll() is not None or not telemetry_thread.is_alive():
            raise RuntimeError("conntrack telemetry exited during TUN gate startup")
        if not dns.is_alive():
            raise RuntimeError("gateway DNS forwarder exited during gateway startup")
        if gate.poll() is not None:
            raise RuntimeError("protocol gateway exited during gateway startup")
        if publish_gateway_ready(
            ready,
            ca_ready=file_is_nonempty(ca_cert),
            gate_ready=file_is_nonempty(GATEWAY_READY),
            capture_ready=capture_writer_is_ready(),
        ):
            break
        time.sleep(0.1)
    else:
        raise RuntimeError("protocol gateway readiness timed out")
    print(json.dumps({"ready": True, "task": os.environ["LUANNIAO_TASK_REF"]}), flush=True)
    while dns.is_alive() and gate.poll() is None:
        if telemetry.poll() is not None or not telemetry_thread.is_alive():
            raise RuntimeError("conntrack telemetry stopped while gateway was running")
        time.sleep(0.2)
    code = gate.poll()
    dns.close()
    telemetry.terminate()
    telemetry_thread.join(timeout=2)
    raise SystemExit(code or 1)


def index() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("role")
    parser.add_argument("--listen", default="0.0.0.0:8788")
    args = parser.parse_args()
    host, port = args.listen.rsplit(":", 1)
    server = ThreadingHTTPServer((host, int(port)), Handler)
    server.index = FlowIndex(Path(os.environ["LUANNIAO_FLOW_ROOT"]))
    server.token = os.environ["LUANNIAO_INDEX_TOKEN"]
    print(json.dumps({"ready": True, "listen": server.server_address}), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    if len(os.sys.argv) > 1 and os.sys.argv[1] == "gateway":
        gateway()
    else:
        index()
