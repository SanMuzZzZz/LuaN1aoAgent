from __future__ import annotations

import ipaddress
from io import BytesIO
import json
import os
from pathlib import Path

from mitmproxy import http, io, tcp
from mitmproxy.exceptions import FlowReadException
from segmented_capture import SegmentedCapture

BODY_LIMIT = int(os.environ.get("LUANNIAO_CAPTURE_BYTES", str(1 << 20)))
TCP_LIMIT = int(os.environ.get("LUANNIAO_TCP_CAPTURE_BYTES", str(64 << 10)))
MITM_SEGMENT_BYTES = int(os.environ.get("LUANNIAO_MITM_SEGMENT_BYTES", str(64 << 20)))
CAPTURE_MAX_FILES = int(os.environ.get("LUANNIAO_CAPTURE_MAX_FILES", "8"))
EPOCH_STATE = Path(os.environ.get("LUANNIAO_EPOCH_STATE", "/run/luanniao/epoch.json"))
ROUTES_PATH = Path(os.environ.get("LUANNIAO_ROUTES_FILE", "/run/luanniao/routes.json"))
CAPTURE_STATUS_PATH = Path(os.environ.get(
    "LUANNIAO_CAPTURE_STATUS", "/run/luanniao/capture/status.json"
))
class CaptureWriter:
    def __init__(self) -> None:
        self.base_metadata = {
            "runRef": os.environ.get("LUANNIAO_RUN_REF", ""),
            "taskRef": os.environ.get("LUANNIAO_TASK_REF", ""),
        }
        self.saved: set[str] = set()
        self.captures: dict[str, SegmentedCapture] = {}
        self.active: dict[str, tuple[str, str]] = {}
        self.persisted: dict[str, int] = {}
        self.failures: dict[str, str] = {}

    def _active_epoch(self) -> dict | None:
        try:
            value = json.loads(EPOCH_STATE.read_text(encoding="utf-8"))
        except (FileNotFoundError, OSError, json.JSONDecodeError):
            return None
        if not value.get("active") or not value.get("epochRef") or not value.get("flowFile"):
            return None
        return value

    def _tag_epoch(self, flow) -> None:
        if flow.metadata.get("epochRef"):
            return
        epoch = self._active_epoch()
        if not epoch:
            return
        flow.metadata.setdefault("runRef", self.base_metadata["runRef"])
        flow.metadata.setdefault("taskRef", self.base_metadata["taskRef"])
        flow.metadata["epochRef"] = epoch["epochRef"]
        flow.metadata["flowFile"] = epoch["flowFile"]
        self._tag_route(flow)

    def _tag_route(self, flow) -> None:
        if flow.metadata.get("routeRef"):
            return
        route = self._route_for_flow(flow)
        if not route:
            return
        flow.metadata["routeRef"] = route.get("routeRef", "")
        connection_ref = route.get("connectionRef") or route.get("sessionRef")
        if connection_ref:
            flow.metadata["connectionRef"] = connection_ref

    def _write(self, flow) -> None:
        if flow.id in self.saved:
            return
        self._tag_epoch(flow)
        flow_file = flow.metadata.get("flowFile")
        if not isinstance(flow_file, str) or not flow_file:
            return
        clone = flow.copy()
        clone.metadata.pop("flowFile", None)
        self._tag_route(clone)
        if isinstance(clone, http.HTTPFlow):
            if clone.request and clone.request.raw_content and len(clone.request.raw_content) > BODY_LIMIT:
                clone.metadata["requestBodyTruncated"] = True
                clone.metadata["requestObservedBytes"] = len(clone.request.raw_content)
                clone.request.raw_content = clone.request.raw_content[:BODY_LIMIT]
            if clone.response and clone.response.raw_content and len(clone.response.raw_content) > BODY_LIMIT:
                clone.metadata["responseBodyTruncated"] = True
                clone.metadata["responseObservedBytes"] = len(clone.response.raw_content)
                clone.response.raw_content = clone.response.raw_content[:BODY_LIMIT]
        elif isinstance(clone, tcp.TCPFlow):
            request_observed_bytes = sum(len(message.content) for message in flow.messages if message.from_client)
            response_observed_bytes = sum(len(message.content) for message in flow.messages if not message.from_client)
            remaining = TCP_LIMIT
            for message in clone.messages:
                if remaining <= 0:
                    message.content = b""
                    continue
                message.content = message.content[:remaining]
                remaining -= len(message.content)
            request_captured_bytes = sum(len(message.content) for message in clone.messages if message.from_client)
            response_captured_bytes = sum(len(message.content) for message in clone.messages if not message.from_client)
            clone.metadata["requestObservedBytes"] = request_observed_bytes
            clone.metadata["responseObservedBytes"] = response_observed_bytes
            clone.metadata["requestBodyTruncated"] = request_captured_bytes < request_observed_bytes
            clone.metadata["responseBodyTruncated"] = response_captured_bytes < response_observed_bytes
            clone.metadata["tcpMessagesTruncated"] = request_captured_bytes + response_captured_bytes < request_observed_bytes + response_observed_bytes
        encoded = BytesIO()
        io.FlowWriter(encoded).add(clone)
        payload = encoded.getvalue()
        capture = self.captures.get(flow_file)
        if capture is None:
            capture = SegmentedCapture(
                Path(flow_file),
                ".mitm",
                MITM_SEGMENT_BYTES,
                CAPTURE_MAX_FILES,
                _count_flows,
                evicted_field="evictedExchanges",
            )
            self.captures[flow_file] = capture
        capture.append(payload)
        self.saved.add(flow.id)
        epoch_ref = str(flow.metadata.get("epochRef", ""))
        if epoch_ref:
            self.persisted[epoch_ref] = self.persisted.get(epoch_ref, 0) + 1

    def _activate(self, flow, kind: str) -> None:
        self._tag_epoch(flow)
        epoch_ref = str(flow.metadata.get("epochRef", ""))
        if not epoch_ref:
            return
        self.active[flow.id] = (epoch_ref, kind)
        self._write_status()

    def _complete(self, flow) -> None:
        epoch_ref = str(getattr(flow, "metadata", {}).get("epochRef", ""))
        try:
            self._write(flow)
        except Exception as error:
            epoch_ref = str(getattr(flow, "metadata", {}).get("epochRef", epoch_ref))
            if epoch_ref:
                self.failures[epoch_ref] = str(error)
            raise
        finally:
            epoch_ref = str(getattr(flow, "metadata", {}).get("epochRef", epoch_ref))
            self.active.pop(getattr(flow, "id", ""), None)
            if epoch_ref:
                self._write_status()

    def _write_status(self) -> None:
        epoch_refs = set(self.persisted) | set(self.failures)
        epoch_refs.update(epoch_ref for epoch_ref, _ in self.active.values())
        epochs = {}
        for epoch_ref in sorted(epoch_refs):
            active = [kind for active_epoch, kind in self.active.values() if active_epoch == epoch_ref]
            epochs[epoch_ref] = {
                "activeFlowCount": len(active),
                "activeTcpCount": sum(1 for kind in active if kind == "tcp"),
                "persistedSequence": self.persisted.get(epoch_ref, 0),
                "error": self.failures.get(epoch_ref, ""),
            }
        CAPTURE_STATUS_PATH.parent.mkdir(parents=True, exist_ok=True)
        temporary = CAPTURE_STATUS_PATH.with_name(
            f".{CAPTURE_STATUS_PATH.name}.{os.getpid()}.tmp"
        )
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o664)
        try:
            payload = json.dumps({"ready": True, "epochs": epochs}, separators=(",", ":")).encode()
            view = memoryview(payload)
            while view:
                written = os.write(descriptor, view)
                if written <= 0:
                    raise OSError("capture status write made no progress")
                view = view[written:]
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        os.replace(temporary, CAPTURE_STATUS_PATH)

    def running(self) -> None:
        self._write_status()

    def _route_for_flow(self, flow):
        address = flow.server_conn.address
        if not address:
            return None
        try:
            destination = ipaddress.ip_address(address[0])
            with ROUTES_PATH.open(encoding="utf-8") as source:
                routes = json.load(source).get("routes", [])
            routes.sort(key=lambda item: int(item.get("prefixLength", 0)), reverse=True)
            return next((route for route in routes if destination in ipaddress.ip_network(route["cidr"], strict=False)), None)
        except (FileNotFoundError, ValueError, OSError, json.JSONDecodeError):
            return None

    def request(self, flow: http.HTTPFlow) -> None:
        self._activate(flow, "http")

    def response(self, flow: http.HTTPFlow) -> None:
        self._complete(flow)

    def error(self, flow: http.HTTPFlow) -> None:
        self._complete(flow)

    def tcp_start(self, flow: tcp.TCPFlow) -> None:
        self._activate(flow, "tcp")

    def tcp_end(self, flow: tcp.TCPFlow) -> None:
        self._complete(flow)

    def tcp_error(self, flow: tcp.TCPFlow) -> None:
        self._complete(flow)


def _count_flows(path: Path) -> int:
    if not path.exists() or path.stat().st_size == 0:
        return 0
    count = 0
    try:
        with path.open("rb") as source:
            for _ in io.FlowReader(source).stream():
                count += 1
    except (FlowReadException, EOFError):
        pass
    return count


addons = [CaptureWriter()]
