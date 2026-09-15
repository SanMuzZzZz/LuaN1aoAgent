from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, TextIO

from segmented_capture import SegmentedCapture


NET_SEGMENT_BYTES = int(os.environ.get("LUANNIAO_NET_SEGMENT_BYTES", str(16 << 20)))
CAPTURE_MAX_FILES = int(os.environ.get("LUANNIAO_CAPTURE_MAX_FILES", "8"))
AGENT_INTENT_MARK = int(os.environ.get("LUANNIAO_AGENT_INTENT_MARK", "0x4c4e4101"), 0)
CONNTRACK_STATUS_PATH = Path(os.environ.get(
    "LUANNIAO_CONNTRACK_STATUS", "/run/luanniao/conntrack-status.json"
))

HEADER = re.compile(
    r"^\[(?P<timestamp>[0-9.]+)\]\s+\[(?P<event>[A-Z]+)\]\s+"
    r"(?P<family>\S+)\s+\d+\s+(?P<protocol>\S+)\s+\d+\s+\d+\s*(?P<body>.*)$"
)


def parse_conntrack_line(
    line: str,
    metadata: dict[str, str],
    routes: list[dict],
    starts: dict[str, str],
    remove_destroy: bool = True,
    required_mark: int | None = None,
) -> dict | None:
    match = HEADER.match(line.strip())
    if not match:
        return None
    connmark = _connmark(match.group("body"))
    if required_mark is not None and connmark != required_mark:
        return None
    tuples, state, flags = _parse_body(match.group("body"))
    if not tuples:
        return None
    original = tuples[0]
    reply = tuples[1] if len(tuples) > 1 else {}
    source_host = str(original.get("src", ""))
    destination_host = str(original.get("dst", ""))
    protocol = match.group("protocol").lower()
    source_port = _integer(original.get("sport"))
    destination_port = _integer(original.get("dport"))
    icmp_type = _integer(original.get("type")) if protocol in ("icmp", "icmpv6") else None
    icmp_code = _integer(original.get("code")) if protocol in ("icmp", "icmpv6") else None
    icmp_id = _integer(original.get("id")) if protocol in ("icmp", "icmpv6") else None
    key = f"{protocol}|{source_host}|{source_port}|{destination_host}|{destination_port}|{icmp_type}|{icmp_code}|{icmp_id}"
    observed_at = _timestamp(match.group("timestamp"))
    event = match.group("event").lower()
    if event == "new" or key not in starts:
        starts[key] = observed_at
    started_at = starts[key]
    connection_ref = "net:" + hashlib.sha256(
        f"{metadata.get('task_ref', '')}|{metadata.get('epoch_ref', '')}|{key}|{started_at}".encode()
    ).hexdigest()[:24]
    route = _route_for_destination(destination_host, routes) if protocol == "tcp" else None
    record = {
        "kind": "network_connection",
        "network_ref": connection_ref,
        "connection_ref": connection_ref,
        "event": event,
        "family": match.group("family"),
        "protocol": protocol,
        "state": state,
        "flags": flags,
        "origin": "executor" if required_mark is not None else "observed",
        "intent_mark": connmark,
        "source": {"host": source_host, "port": source_port},
        "destination": {"host": destination_host, "port": destination_port},
        "icmp": {"type": icmp_type, "code": icmp_code, "id": icmp_id} if protocol in ("icmp", "icmpv6") else None,
        "reply": {
            "source_host": str(reply.get("src", "")),
            "source_port": _integer(reply.get("sport")),
            "destination_host": str(reply.get("dst", "")),
            "destination_port": _integer(reply.get("dport")),
        },
        "started_at": started_at,
        "observed_at": observed_at,
        "ended_at": observed_at if event == "destroy" else "",
        "packets_original": _integer(original.get("packets")),
        "bytes_original": _integer(original.get("bytes")),
        "packets_reply": _integer(reply.get("packets")),
        "bytes_reply": _integer(reply.get("bytes")),
        **metadata,
    }
    if route:
        record["route_ref"] = str(route.get("routeRef", ""))
        connection_ref = str(route.get("connectionRef") or route.get("sessionRef") or "")
        record["connection_ref"] = connection_ref
    if event == "destroy" and remove_destroy:
        starts.pop(key, None)
    return record


def stream_conntrack(
    source: Iterable[str],
    output: TextIO,
    metadata: dict[str, str],
    routes_path: Path,
) -> None:
    starts: dict[str, str] = {}
    for line in source:
        routes = _load_routes(routes_path)
        record = parse_conntrack_line(line, metadata, routes, starts)
        if record is None:
            continue
        output.write(json.dumps(record, separators=(",", ":")) + "\n")
        output.flush()


def stream_conntrack_epochs(
    source: Iterable[str],
    base_metadata: dict[str, str],
    routes_path: Path,
    epoch_state_path: Path,
    required_mark: int | None = None,
    status_path: Path | None = None,
    tracker: "ConntrackEpochTracker | None" = None,
) -> None:
    tracker = tracker or ConntrackEpochTracker(status_path)
    tracker.initialize_status()
    for line in source:
        with tracker.lock:
            epoch = _load_epoch(epoch_state_path)
            metadata = {
                **base_metadata,
                "epoch_ref": str(epoch.get("epochRef", "")) if epoch else "",
            }
            routes = _load_routes(routes_path)
            candidate = parse_conntrack_line(
                line, metadata, routes, tracker.starts, remove_destroy=False, required_mark=required_mark
            )
            if candidate is None:
                continue
            key = _record_key(candidate)
            owner = tracker.owners.get(key)
            if owner is None:
                if epoch is None or candidate["event"] == "destroy" or metadata["epoch_ref"] in tracker.closed_epochs:
                    if candidate["event"] == "destroy" or metadata["epoch_ref"] in tracker.closed_epochs:
                        tracker.starts.pop(key, None)
                    continue
                owner = {
                    **metadata,
                    "net_file": str(epoch["netFile"]),
                    "network_ref": str(candidate.get("network_ref", "")),
                    "connection_ref": str(candidate.get("connection_ref", "")),
                }
                for reference in ("route_ref",):
                    if candidate.get(reference):
                        owner[reference] = str(candidate[reference])
                tracker.owners[key] = owner
            owner_metadata = {key: value for key, value in owner.items() if key != "net_file"}
            record = candidate if owner_metadata == metadata else parse_conntrack_line(
                line, owner_metadata, routes, tracker.starts, remove_destroy=False, required_mark=required_mark
            )
            if record is None:
                continue
            tracker.persist(key, owner, record)


class ConntrackEpochTracker:
    def __init__(self, status_path: Path | None = None) -> None:
        self.status_path = status_path
        self.lock = threading.RLock()
        self.starts: dict[str, str] = {}
        self.owners: dict[str, dict[str, str]] = {}
        self.last_records: dict[str, dict] = {}
        self.captures: dict[str, SegmentedCapture] = {}
        self.persisted: dict[str, int] = {}
        self.failures: dict[str, str] = {}
        self.closed_epochs: set[str] = set()

    def initialize_status(self) -> None:
        with self.lock:
            self._write_status()

    def persist(self, key: str, owner: dict[str, str], record: dict) -> None:
        epoch_ref = str(owner.get("epoch_ref", ""))
        try:
            self._capture(owner["net_file"]).append(
                (json.dumps(record, separators=(",", ":")) + "\n").encode()
            )
            if epoch_ref:
                self.persisted[epoch_ref] = self.persisted.get(epoch_ref, 0) + 1
            self.last_records[key] = record
        except Exception as error:
            if epoch_ref:
                self.failures[epoch_ref] = str(error)
            self._write_status()
            raise
        if record["event"] == "destroy":
            self.starts.pop(key, None)
            self.owners.pop(key, None)
            self.last_records.pop(key, None)
        self._write_status()

    def close_epoch(self, epoch_ref: str) -> None:
        with self.lock:
            self.closed_epochs.add(epoch_ref)
            for key, owner in list(self.owners.items()):
                if str(owner.get("epoch_ref", "")) != epoch_ref:
                    continue
                record = self.last_records.get(key)
                if record is not None:
                    closed_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
                    self.persist(key, owner, {
                        **record,
                        "event": "destroy",
                        "state": "closed",
                        "flags": sorted(set(record.get("flags", [])) | {"runtime_drained"}),
                        "observed_at": closed_at,
                        "ended_at": closed_at,
                    })
                else:
                    self.starts.pop(key, None)
                    self.owners.pop(key, None)
                    self.last_records.pop(key, None)
            self._write_status()

    def _capture(self, net_file: str) -> SegmentedCapture:
        capture = self.captures.get(net_file)
        if capture is None:
            capture = SegmentedCapture(
                Path(net_file),
                ".net.jsonl",
                NET_SEGMENT_BYTES,
                CAPTURE_MAX_FILES,
                _count_json_lines,
            )
            self.captures[net_file] = capture
        return capture

    def _write_status(self) -> None:
        if self.status_path is not None:
            _write_capture_status(
                self.status_path,
                self.owners,
                self.persisted,
                self.failures,
            )


def _write_capture_status(
    path: Path,
    owners: dict[str, dict[str, str]],
    persisted: dict[str, int],
    failures: dict[str, str],
) -> None:
    epoch_refs = set(persisted) | set(failures)
    epoch_refs.update(str(owner.get("epoch_ref", "")) for owner in owners.values())
    epoch_refs.discard("")
    epochs = {}
    for epoch_ref in sorted(epoch_refs):
        epochs[epoch_ref] = {
            "activeNetworkCount": sum(
                1 for owner in owners.values()
                if str(owner.get("epoch_ref", "")) == epoch_ref
            ),
            "persistedSequence": persisted.get(epoch_ref, 0),
            "error": failures.get(epoch_ref, ""),
        }
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o664)
    try:
        payload = json.dumps({"epochs": epochs}, separators=(",", ":")).encode()
        view = memoryview(payload)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                raise OSError("conntrack status write made no progress")
            view = view[written:]
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.replace(temporary, path)


def _parse_body(body: str) -> tuple[list[dict[str, str]], str, list[str]]:
    tuples: list[dict[str, str]] = []
    current: dict[str, str] = {}
    state = ""
    flags: list[str] = []
    for token in body.split():
        if token.startswith("[") and token.endswith("]"):
            flags.append(token[1:-1].lower())
            continue
        if "=" not in token:
            if not state:
                state = token.lower()
            continue
        key, value = token.split("=", 1)
        if key == "src" and "src" in current:
            tuples.append(current)
            current = {}
        current[key] = value
    if current:
        tuples.append(current)
    return tuples, state, flags


def _connmark(body: str) -> int | None:
    match = re.search(r"(?:^|\s)mark=(0x[0-9a-fA-F]+|[0-9]+)(?:\s|$)", body)
    if not match:
        return None
    try:
        return int(match.group(1), 0)
    except ValueError:
        return None


def _count_json_lines(path: Path) -> int:
    if not path.exists():
        return 0
    count = 0
    try:
        with path.open("r", encoding="utf-8") as source:
            for line in source:
                try:
                    json.loads(line)
                    count += 1
                except json.JSONDecodeError:
                    continue
    except OSError:
        return count
    return count


def _route_for_destination(destination: str, routes: list[dict]) -> dict | None:
    try:
        address = ipaddress.ip_address(destination)
    except ValueError:
        return None
    ordered = sorted(routes, key=lambda item: int(item.get("prefixLength", 0)), reverse=True)
    for route in ordered:
        try:
            if address in ipaddress.ip_network(str(route["cidr"]), strict=False):
                return route
        except (KeyError, ValueError):
            continue
    return None


def _load_routes(path: Path) -> list[dict]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value.get("routes", []) if isinstance(value, dict) else []
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return []


def _load_epoch(path: Path) -> dict | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return None
    if not isinstance(value, dict) or not value.get("active") or not value.get("epochRef") or not value.get("netFile"):
        return None
    return value


def _record_key(record: dict) -> str:
    icmp = record.get("icmp") or {}
    return "|".join([
        str(record.get("protocol", "")),
        str(record.get("source", {}).get("host", "")),
        str(record.get("source", {}).get("port", "")),
        str(record.get("destination", {}).get("host", "")),
        str(record.get("destination", {}).get("port", "")),
        str(icmp.get("type")),
        str(icmp.get("code")),
        str(icmp.get("id")),
    ])


def _integer(value: object) -> int | None:
    try:
        return int(str(value))
    except (TypeError, ValueError):
        return None


def _timestamp(value: str) -> str:
    return datetime.fromtimestamp(float(value), tz=timezone.utc).isoformat().replace("+00:00", "Z")
