import json
import os
import sys
import tempfile
import threading
import time
import types
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

try:
    import mitmproxy
except ModuleNotFoundError:
    package = types.ModuleType("mitmproxy")
    http = types.ModuleType("mitmproxy.http")
    io = types.ModuleType("mitmproxy.io")
    tcp = types.ModuleType("mitmproxy.tcp")
    exceptions = types.ModuleType("mitmproxy.exceptions")
    http.HTTPFlow = type("HTTPFlow", (), {})
    tcp.TCPFlow = type("TCPFlow", (), {})
    exceptions.FlowReadException = type("FlowReadException", (Exception,), {})
    package.http = http
    package.io = io
    package.tcp = tcp
    sys.modules.update({
        "mitmproxy": package,
        "mitmproxy.http": http,
        "mitmproxy.io": io,
        "mitmproxy.tcp": tcp,
        "mitmproxy.exceptions": exceptions,
    })

from index_server import (
    FlowIndex,
    GatewayControl,
    body_record,
    configure_gateway_firewall,
    ensure_conntrack_accounting,
    file_is_nonempty,
    flow_record,
    gateway_tun_command,
    prepare_tun_gate_ready_file,
    publish_gateway_ready,
)


class FramedFlowReader:
    starts: list[int] = []
    delay = 0.0

    def __init__(self, source) -> None:
        self.source = source
        self.starts.append(source.tell())

    def stream(self):
        while True:
            header = self.source.readline()
            if not header:
                return
            if not header.endswith(b"\n"):
                raise sys.modules["mitmproxy.exceptions"].FlowReadException("partial header")
            try:
                length = int(header[:-1])
            except ValueError as error:
                raise sys.modules["mitmproxy.exceptions"].FlowReadException("invalid header") from error
            payload = self.source.read(length)
            if len(payload) != length:
                raise sys.modules["mitmproxy.exceptions"].FlowReadException("partial payload")
            if self.delay:
                time.sleep(self.delay)
            yield SimpleNamespace(id=payload.decode(), started_at=float(payload.decode().split("-")[-1]))


def framed_flow(flow_id: str) -> bytes:
    payload = flow_id.encode()
    return f"{len(payload)}\n".encode() + payload


def indexed_record(path: Path, flow, quota: dict | None = None) -> dict:
    return {
        "id": flow.id,
        "started_at": f"{flow.started_at:020.6f}",
        "source_file": str(path),
        "quota_pressure": bool((quota or {}).get("quota_pressure", False)),
        "evicted_exchanges": int((quota or {}).get("evicted_records", 0)),
    }


class FlowIndexTest(unittest.TestCase):
    def setUp(self) -> None:
        FramedFlowReader.starts.clear()
        FramedFlowReader.delay = 0.0
        self.reader = patch("index_server.io.FlowReader", FramedFlowReader, create=True)
        self.record = patch("index_server.flow_record", side_effect=indexed_record)
        self.reader.start()
        self.record.start()

    def tearDown(self) -> None:
        self.record.stop()
        self.reader.stop()

    def test_reads_only_bytes_after_each_committed_record(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "epoch.mitm"
            first = framed_flow("flow-1")
            second = framed_flow("flow-2")
            path.write_bytes(first + second)
            index = FlowIndex(Path(directory))

            self.assertEqual([record["id"] for record in index.records()], ["flow-2", "flow-1"])
            self.assertEqual([record["id"] for record in index.records()], ["flow-2", "flow-1"])
            with path.open("ab") as output:
                output.write(framed_flow("flow-3"))
            self.assertEqual([record["id"] for record in index.records()], ["flow-3", "flow-2", "flow-1"])

            self.assertEqual(FramedFlowReader.starts, [0, len(first + second)])

    def test_partial_tail_is_retried_from_the_last_complete_record(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "epoch.mitm"
            first = framed_flow("flow-1")
            second = framed_flow("flow-2")
            split = len(second) - 2
            path.write_bytes(first + second[:split])
            index = FlowIndex(Path(directory))

            self.assertEqual([record["id"] for record in index.records()], ["flow-1"])
            with path.open("ab") as output:
                output.write(second[split:])
            self.assertEqual([record["id"] for record in index.records()], ["flow-2", "flow-1"])

            self.assertEqual(FramedFlowReader.starts, [0, len(first)])

    def test_rotation_preserves_inode_records_and_eviction_removes_them(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            active = root / "epoch.mitm"
            active.write_bytes(framed_flow("flow-1"))
            index = FlowIndex(root)
            self.assertEqual([record["id"] for record in index.records()], ["flow-1"])

            part = root / "epoch.part-000001-n000000001.mitm"
            os.replace(active, part)
            active.write_bytes(framed_flow("flow-2"))
            self.assertEqual([record["id"] for record in index.records()], ["flow-2", "flow-1"])
            self.assertEqual(FramedFlowReader.starts, [0, 0])

            part.unlink()
            (root / "epoch.mitm.quota.json").write_text(json.dumps({
                "quotaPressure": True,
                "evictedExchanges": 1,
            }), encoding="utf-8")
            records = index.records()
            self.assertEqual([record["id"] for record in records], ["flow-2"])
            self.assertTrue(records[0]["quota_pressure"])
            self.assertEqual(records[0]["evicted_exchanges"], 1)

    def test_restart_rebuilds_the_same_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "epoch.mitm").write_bytes(framed_flow("flow-1") + framed_flow("flow-2"))

            first = FlowIndex(root).records()
            second = FlowIndex(root).records()

            self.assertEqual(first, second)
            self.assertEqual(FramedFlowReader.starts, [0, 0])

    def test_concurrent_records_share_one_incremental_scan(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "epoch.mitm").write_bytes(framed_flow("flow-1") + framed_flow("flow-2"))
            index = FlowIndex(root)
            FramedFlowReader.delay = 0.01
            barrier = threading.Barrier(8)

            def read_ids() -> list[str]:
                barrier.wait()
                return [record["id"] for record in index.records()]

            with ThreadPoolExecutor(max_workers=8) as executor:
                snapshots = list(executor.map(lambda _index: read_ids(), range(8)))

            self.assertEqual(snapshots, [["flow-2", "flow-1"]] * 8)
            self.assertEqual(FramedFlowReader.starts, [0])

    def test_reads_native_jsonl_and_retries_a_partial_tail(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "epoch.mitm"
            first = json.dumps({
                "format": "luanniao-flow-v1", "id": "flow-1", "started_at": "2026-01-01T00:00:00Z",
                "request_body_base64": "cmVxdWVzdA==", "response_body_base64": "cmVzcG9uc2U=",
            }).encode() + b"\n"
            second = json.dumps({
                "format": "luanniao-flow-v1", "id": "flow-2", "started_at": "2026-01-01T00:00:01Z",
                "request_body_base64": "", "response_body_base64": "",
            }).encode() + b"\n"
            path.write_bytes(first + second[:-2])
            index = FlowIndex(Path(directory))

            records = index.records()
            self.assertEqual([record["id"] for record in records], ["flow-1"])
            self.assertEqual(records[0]["request_body"], b"request")
            with path.open("ab") as output:
                output.write(second[-2:])
            self.assertEqual([record["id"] for record in index.records()], ["flow-2", "flow-1"])


class RouteProxyTest(unittest.TestCase):
    def test_missing_readiness_file_is_not_ready(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "missing.ready"
            self.assertFalse(file_is_nonempty(path))
            path.write_bytes(b"")
            self.assertFalse(file_is_nonempty(path))
            path.write_bytes(b"ready\n")
            self.assertTrue(file_is_nonempty(path))

    def test_conntrack_accounting_configuration_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            status = Path(directory) / "nf_conntrack_acct"
            status.write_text("1\n", encoding="utf-8")
            ensure_conntrack_accounting(status)
            status.write_text("0\n", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "disabled"):
                ensure_conntrack_accounting(status)
            status.unlink()
            with self.assertRaisesRegex(RuntimeError, "unavailable"):
                ensure_conntrack_accounting(status)

    def test_protocol_gateway_owns_transparent_capture_and_routing(self) -> None:
        with patch.dict(os.environ, {
            "LUANNIAO_RUN_REF": "run:test", "LUANNIAO_TASK_REF": "task:test",
            "LUANNIAO_DIRECT_BROKER": "host.docker.internal:12345",
            "LUANNIAO_DIRECT_BROKER_TOKEN": "00" * 32,
            "LUANNIAO_TASK_NETWORK_CIDR": "172.31.0.0/24",
            "LUANNIAO_CONTROL_NETWORK_CIDR": "172.30.0.0/24",
            "LUANNIAO_AUTHORIZED_CIDRS": "198.51.100.0/24",
        }):
            command = gateway_tun_command()
        self.assertEqual(command[command.index("--pdeathsig") + 1], "TERM")
        self.assertEqual(command[command.index("--mode") + 1], "unified")
        self.assertEqual(command[command.index("--tun") + 1], "luanniao0")
        self.assertEqual(command[command.index("--task-ref") + 1], "task:test")
        self.assertEqual(command[command.index("--allow-cidrs") + 1], "198.51.100.0/24")
        self.assertNotIn("--proxy", command)

    def test_domain_scope_configures_nft_guard_and_gateway_admission(self) -> None:
        environment = {
            "LUANNIAO_RUN_REF": "run:test", "LUANNIAO_TASK_REF": "task:test",
            "LUANNIAO_DIRECT_BROKER": "host.docker.internal:12345",
            "LUANNIAO_DIRECT_BROKER_TOKEN": "00" * 32,
            "LUANNIAO_TASK_NETWORK_CIDR": "172.31.0.0/24",
            "LUANNIAO_CONTROL_NETWORK_CIDR": "172.30.0.0/24",
            "LUANNIAO_AUTHORIZED_CIDRS": "",
            "LUANNIAO_AUTHORIZED_DOMAINS": "baidu.com,*.baidu.com",
        }
        with patch.dict(os.environ, environment, clear=False):
            gate_command = gateway_tun_command()
        self.assertIn("--allow-domain-resolved", gate_command)

        commands: list[list[str]] = []
        with patch.dict(os.environ, environment, clear=False), patch(
            "index_server.subprocess.run",
            side_effect=lambda command, **_kwargs: commands.append(command) or MagicMock(returncode=0),
        ):
            configure_gateway_firewall("172.31.0.2")
        self.assertIn([
            "nft", "add", "table", "ip", "luanniao_scope"
        ], commands)
        self.assertIn([
            "nft", "add", "rule", "ip", "luanniao_scope", "forward",
            "ip", "saddr", "172.31.0.0/24", "ip", "daddr", "@allowed4", "accept"
        ], commands)
        self.assertIn([
            "nft", "add", "rule", "ip", "luanniao_scope", "forward",
            "ip", "saddr", "172.31.0.0/24", "reject"
        ], commands)
        self.assertFalse(any("LUANNIAO_SCOPE_GUARD" in command for command in commands))

    def test_gateway_routes_all_task_tcp_to_one_protocol_gateway(self) -> None:
        commands: list[list[str]] = []

        def run(command, **_kwargs):
            commands.append(command)
            return MagicMock(returncode=0)

        environment = {
            "LUANNIAO_TASK_NETWORK_CIDR": "172.31.0.0/24",
            "LUANNIAO_CONTROL_NETWORK_CIDR": "172.30.0.0/24",
            "LUANNIAO_AUTHORIZED_CIDRS": "198.51.100.0/24,203.0.113.10/32",
        }
        with patch.dict(os.environ, environment), patch("index_server.subprocess.run", side_effect=run):
            configure_gateway_firewall("172.31.0.2")

        set_marks = [command for command in commands if "--set-mark" in command]
        restore_marks = [command for command in commands if "--restore-mark" in command]
        fwmark_rules = [command for command in commands if command[:3] == ["ip", "rule", "add"] and "fwmark" in command]
        later_local = next(command for command in commands if command == ["ip", "rule", "add", "priority", "200", "lookup", "local"])
        old_local = next(command for command in commands if command == ["ip", "rule", "del", "priority", "0", "lookup", "local"])
        self.assertEqual(len(set_marks), 2)
        self.assertFalse(any("--uid-owner" in command and command[command.index("--uid-owner") + 1] in {"0", "1000"} for command in commands))
        self.assertEqual(len([command for command in set_marks if "PREROUTING" in command]), 2)
        self.assertEqual(len([command for command in set_marks if "OUTPUT" in command]), 0)
        self.assertEqual(restore_marks, [])
        self.assertIn(["ip", "tuntap", "add", "dev", "luanniao0", "mode", "tun", "user", "101", "group", "101"], commands)
        self.assertIn(["ip", "route", "add", "default", "dev", "luanniao0", "table", "4242"], commands)
        self.assertEqual([int(rule[rule.index("priority") + 1]) for rule in fwmark_rules], [100])
        self.assertTrue(all(commands.index(rule) < commands.index(later_local) for rule in fwmark_rules))
        self.assertLess(commands.index(later_local), commands.index(old_local))
        self.assertFalse(any("REDIRECT" in command for command in commands))
        for protocol in ("udp", "tcp"):
            self.assertIn([
                "iptables", "-A", "INPUT", "-s", "172.31.0.0/24",
                "-d", "172.31.0.2/32", "-p", protocol, "--dport", "53", "-j", "ACCEPT"
            ], commands)
        self.assertIn([
            "iptables", "-A", "INPUT", "-s", "172.31.0.0/24", "-j", "REJECT"
        ], commands)
        self.assertIn([
            "iptables", "-A", "FORWARD", "-s", "172.31.0.0/24", "-d", "172.30.0.0/24", "-j", "REJECT"
        ], commands)
        self.assertIn([
            "iptables", "-A", "LUANNIAO_SCOPE_GUARD", "-d", "198.51.100.0/24", "-j", "RETURN"
        ], commands)
        self.assertIn([
            "iptables", "-A", "LUANNIAO_SCOPE_GUARD", "-j", "REJECT"
        ], commands)
        self.assertIn([
            "iptables", "-t", "nat", "-A", "POSTROUTING", "-s", "172.31.0.0/24", "-j", "MASQUERADE"
        ], commands)
        self.assertFalse(any("--dports" in command for command in commands))

    def test_protocol_gateway_runs_unprivileged_as_capture_storage_owner(self) -> None:
        with patch.dict(os.environ, {
            "LUANNIAO_DIRECT_BROKER": "host.docker.internal:12345",
            "LUANNIAO_DIRECT_BROKER_TOKEN": "00" * 32,
            "LUANNIAO_TASK_NETWORK_CIDR": "172.31.0.0/24",
            "LUANNIAO_CONTROL_NETWORK_CIDR": "172.30.0.0/24",
            "LUANNIAO_AUTHORIZED_CIDRS": "198.51.100.0/24",
        }):
            command = gateway_tun_command()
        self.assertIn("--reuid=101", command)
        self.assertIn("--no-new-privs", command)
        self.assertEqual(command[command.index("--pdeathsig") + 1], "TERM")

    def test_uid_routing_exists_only_for_the_trusted_replay_helper(self) -> None:
        commands: list[list[str]] = []
        environment = {
            "LUANNIAO_TASK_NETWORK_CIDR": "172.31.0.0/24",
            "LUANNIAO_CONTROL_NETWORK_CIDR": "172.30.0.0/24",
            "LUANNIAO_AUTHORIZED_CIDRS": "198.51.100.0/24",
            "LUANNIAO_TRUSTED_REPLAY": "1",
        }
        with patch.dict(os.environ, environment), patch(
            "index_server.subprocess.run",
            side_effect=lambda command, **_kwargs: commands.append(command) or MagicMock(returncode=0),
        ):
            configure_gateway_firewall("172.31.0.2")
        owner_rules = [command for command in commands if "--uid-owner" in command]
        self.assertEqual(len(owner_rules), 2)
        self.assertTrue(all(command[command.index("--uid-owner") + 1] == "1000" for command in owner_rules))

    def test_gateway_readiness_requires_every_data_plane_component(self) -> None:
        ready = MagicMock()
        conditions = {
            "ca_ready": True,
            "gate_ready": True,
            "capture_ready": True,
        }
        for missing in conditions:
            with self.subTest(missing=missing):
                ready.reset_mock()
                incomplete = {**conditions, missing: False}
                self.assertFalse(publish_gateway_ready(ready, **incomplete))
                ready.set.assert_not_called()

        self.assertTrue(publish_gateway_ready(ready, **conditions))
        ready.set.assert_called_once_with()

    def test_tun_ready_file_is_created_by_gateway_uid_without_chown_capability(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "tun-gate.ready"
            with (
                patch("index_server.subprocess.run") as run,
                patch("index_server.os.chmod") as chmod,
                patch("index_server.os.chown") as chown,
            ):
                prepare_tun_gate_ready_file(path)

        run.assert_called_once_with([
            "setpriv", "--reuid=101", "--regid=101", "--clear-groups",
            "install", "-m", "0600", "/dev/null", str(path),
        ], check=True)
        self.assertEqual(chmod.call_args_list[0].args, (path.parent, 0o733))
        self.assertEqual(chmod.call_args_list[-1].args, (path.parent, 0o755))
        chown.assert_not_called()

    def test_body_api_reports_response_truncated_by_requested_byte_limit(self) -> None:
        record = {
            "request_body": b"request",
            "response_body": b"response-body",
            "request_truncated": False,
            "response_truncated": False,
        }

        response = body_record(record, "flow:test", "response", 8)
        request = body_record(record, "flow:test", "request", 8)

        self.assertEqual(response["bytes"], 8)
        self.assertTrue(response["truncated"])
        self.assertFalse(request["truncated"])

    def test_tcp_flow_record_exposes_directional_bounded_summaries(self) -> None:
        class FakeTCPFlow:
            pass

        flow = FakeTCPFlow()
        flow.id = "flow-one"
        flow.metadata = {"taskRef": "task:test", "requestObservedBytes": 9, "responseObservedBytes": 7}
        flow.timestamp_start = 10.0
        flow.timestamp_end = 11.0
        flow.error = None
        flow.server_conn = SimpleNamespace(address=("192.0.2.10", 22), timestamp_end=11.0)
        flow.client_conn = SimpleNamespace(timestamp_end=11.0)
        flow.messages = [
            SimpleNamespace(from_client=True, content=b"hello"),
            SimpleNamespace(from_client=False, content=b"world"),
            SimpleNamespace(from_client=True, content=b"!"),
        ]

        with patch("index_server.tcp.TCPFlow", FakeTCPFlow):
            record = flow_record(Path("task-test/epoch.mitm"), flow)

        self.assertEqual(record["request_body"], b"hello!")
        self.assertEqual(record["response_body"], b"world")
        self.assertEqual(record["request_observed_bytes"], 9)
        self.assertEqual(record["response_observed_bytes"], 7)
        self.assertTrue(record["request_truncated"])
        self.assertTrue(record["response_truncated"])
        self.assertEqual(record["request_message_count"], 2)
        self.assertEqual(record["response_message_count"], 1)

    def test_gateway_route_update_atomically_writes_normalized_longest_prefix_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            routes_path = root / "run" / "routes.json"
            control = GatewayControl(
                str(root / "gateway.sock"), MagicMock(), root / "epoch.json", root, routes_path
            )
            control.replace_routes([
                {
                    "routeRef": "route:test",
                    "cidr": "172.31.0.7/24",
                    "prefixLength": 24,
                    "socksHost": "192.0.2.10",
                    "socksPort": 22000,
                    "connectionRef": "connection:test",
                },
                {
                    "routeRef": "route:specific",
                    "cidr": "172.31.0.9/32",
                    "prefixLength": 32,
                    "socksHost": "192.0.2.11",
                    "socksPort": 22001,
                },
            ])

            snapshot = json.loads(routes_path.read_text(encoding="utf-8"))
            self.assertEqual([route["cidr"] for route in snapshot["routes"]], ["172.31.0.9/32", "172.31.0.0/24"])
            self.assertEqual(snapshot["routes"][1]["connectionRef"], "connection:test")
            self.assertEqual(routes_path.stat().st_mode & 0o777, 0o644)
            self.assertFalse(routes_path.with_suffix(".tmp").exists())

    def test_gateway_begin_epoch_keeps_capture_storage_host_readable(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            control = GatewayControl(
                str(root / "gateway.sock"),
                MagicMock(),
                root / "epoch.json",
                root,
                root / "routes.json",
            )
            with patch("index_server.os.chown") as chown, patch("index_server.os.chmod") as chmod:
                control.begin_epoch({
                    "epochRef": "epoch:test",
                    "flowFile": str(root / "epoch:test.mitm"),
                    "netFile": str(root / "epoch:test.net.jsonl"),
                })

            owned = {call.args for call in chown.call_args_list}
            capture_modes = {
                call.args for call in chmod.call_args_list
                if call.args[0].name.endswith((".mitm", ".net.jsonl"))
            }
            self.assertIn((root.resolve(), 101, 101), owned)
            self.assertIn(((root / "epoch:test.mitm").resolve(), 101, 101), owned)
            self.assertIn(((root / "epoch:test.net.jsonl").resolve(), 101, 101), owned)
            self.assertIn(((root / "epoch:test.mitm").resolve(), 0o664), capture_modes)
            self.assertIn(((root / "epoch:test.net.jsonl").resolve(), 0o664), capture_modes)

    def test_gateway_route_validation_keeps_previous_snapshot_on_failure(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            routes_path = root / "routes.json"
            control = GatewayControl(
                str(root / "gateway.sock"), MagicMock(), root / "epoch.json", root, routes_path
            )
            control.replace_routes([{
                "routeRef": "route:stable", "cidr": "172.31.0.0/24", "prefixLength": 24,
                "socksHost": "192.0.2.10", "socksPort": 22000,
            }])
            previous = routes_path.read_bytes()

            invalid_routes = [
                [{"routeRef": "route:bad", "cidr": "172.31.0.0/24", "prefixLength": 25, "socksHost": "192.0.2.10", "socksPort": 22000}],
                [{"routeRef": "route:bad", "cidr": "2001:db8::/64", "prefixLength": 64, "socksHost": "192.0.2.10", "socksPort": 22000}],
                [{"routeRef": "route:bad", "cidr": "172.31.0.0/24", "prefixLength": 24, "socksHost": "192.0.2.10", "socksPort": 0}],
                [
                    {"routeRef": "route:one", "cidr": "172.31.0.0/24", "prefixLength": 24, "socksHost": "192.0.2.10", "socksPort": 22000},
                    {"routeRef": "route:two", "cidr": "172.31.0.7/24", "prefixLength": 24, "socksHost": "192.0.2.11", "socksPort": 22001},
                ],
            ]
            for routes in invalid_routes:
                with self.subTest(routes=routes), self.assertRaises((ValueError, TypeError)):
                    control.replace_routes(routes)
                self.assertEqual(routes_path.read_bytes(), previous)

    def test_gateway_epoch_end_waits_for_zero_active_work_and_returns_fsynced_ack(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            epoch_state = root / "epoch.json"
            flow_file = root / "epoch.mitm"
            net_file = root / "epoch.net.jsonl"
            capture_status = root / "capture-status.json"
            conntrack_status = root / "conntrack-status.json"
            flow_file.write_bytes(b"flow-bytes")
            net_file.write_bytes(b"net-bytes")
            epoch_state.write_text(json.dumps({
                "active": True,
                "epochRef": "epoch:test",
                "flowFile": str(flow_file),
                "netFile": str(net_file),
            }))
            capture_status.write_text(json.dumps({"epochs": {"epoch:test": {
                "activeFlowCount": 1,
                "activeTcpCount": 1,
                "persistedSequence": 4,
                "error": "",
            }}}))
            conntrack_status.write_text(json.dumps({"epochs": {"epoch:test": {
                "activeNetworkCount": 1,
                "persistedSequence": 6,
                "error": "",
            }}}))
            drain_calls = 0

            def drain_connections() -> int:
                nonlocal drain_calls
                drain_calls += 1
                if drain_calls == 2:
                    capture_status.write_text(json.dumps({"epochs": {"epoch:test": {
                        "activeFlowCount": 0,
                        "activeTcpCount": 0,
                        "persistedSequence": 5,
                        "error": "",
                    }}}))
                    conntrack_status.write_text(json.dumps({"epochs": {"epoch:test": {
                        "activeNetworkCount": 0,
                        "persistedSequence": 7,
                        "error": "",
                    }}}))
                return 1 if drain_calls == 1 else 0

            control = GatewayControl(
                str(root / "gateway.sock"),
                MagicMock(),
                epoch_state,
                root,
                root / "routes.json",
                capture_status,
                conntrack_status,
                drain_connections,
                1,
            )
            with patch("index_server.time.sleep", return_value=None):
                ack = control.end_epoch({"epochRef": "epoch:test"})

            self.assertGreaterEqual(drain_calls, 4)
            self.assertEqual(ack["activeFlowCount"], 0)
            self.assertEqual(ack["activeTcpCount"], 0)
            self.assertEqual(ack["activeNetworkCount"], 0)
            self.assertEqual(ack["persistedFlowSequence"], 5)
            self.assertEqual(ack["persistedNetworkSequence"], 7)
            self.assertEqual(ack["flowBytes"], len(b"flow-bytes"))
            self.assertEqual(ack["netBytes"], len(b"net-bytes"))
            self.assertTrue(ack["flushed"])
            persisted = json.loads(epoch_state.read_text())
            self.assertFalse(persisted["active"])
            self.assertEqual(persisted["drainAck"], ack)

    def test_gateway_epoch_end_reconciles_stale_telemetry_after_kernel_drain(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            epoch_state = root / "epoch.json"
            flow_file = root / "epoch.mitm"
            net_file = root / "epoch.net.jsonl"
            capture_status = root / "capture-status.json"
            conntrack_status = root / "conntrack-status.json"
            flow_file.touch()
            net_file.write_text("network\n")
            epoch_state.write_text(json.dumps({
                "active": True,
                "epochRef": "epoch:stale",
                "flowFile": str(flow_file),
                "netFile": str(net_file),
            }))
            capture_status.write_text(json.dumps({"epochs": {"epoch:stale": {
                "activeFlowCount": 0,
                "activeTcpCount": 0,
                "persistedSequence": 1,
                "error": "",
            }}}))
            conntrack_status.write_text(json.dumps({"epochs": {"epoch:stale": {
                "activeNetworkCount": 4,
                "persistedSequence": 8,
                "error": "",
            }}}))
            reconciliations = 0

            def reconcile(epoch_ref: str) -> None:
                nonlocal reconciliations
                reconciliations += 1
                self.assertEqual(epoch_ref, "epoch:stale")
                conntrack_status.write_text(json.dumps({"epochs": {"epoch:stale": {
                    "activeNetworkCount": 0,
                    "persistedSequence": 12,
                    "error": "",
                }}}))

            control = GatewayControl(
                str(root / "gateway.sock"),
                MagicMock(),
                epoch_state,
                root,
                root / "routes.json",
                capture_status,
                conntrack_status,
                lambda: 0,
                1,
                reconcile,
            )
            with patch("index_server.time.sleep", return_value=None):
                ack = control.end_epoch({"epochRef": "epoch:stale"})

            self.assertEqual(reconciliations, 1)
            self.assertEqual(ack["activeNetworkCount"], 0)
            self.assertEqual(ack["persistedNetworkSequence"], 12)
            self.assertTrue(ack["flushed"])

    def test_gateway_epoch_end_tolerates_conntrack_destroy_storm(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            epoch_state = root / "epoch.json"
            flow_file = root / "epoch.mitm"
            net_file = root / "epoch.net.jsonl"
            capture_status = root / "capture-status.json"
            conntrack_status = root / "conntrack-status.json"
            flow_file.write_bytes(b"flow-bytes")
            net_file.write_bytes(b"net-bytes")
            epoch_state.write_text(json.dumps({
                "active": True,
                "epochRef": "epoch:storm",
                "flowFile": str(flow_file),
                "netFile": str(net_file),
            }))
            capture_status.write_text(json.dumps({"epochs": {"epoch:storm": {
                "activeFlowCount": 0,
                "activeTcpCount": 0,
                "persistedSequence": 9,
                "error": "",
            }}}))
            storm = {"netSeq": 100}

            def churn_conntrack() -> None:
                # Full-port scan teardown: nothing active, but the conntrack
                # persistence sequence never sits still for two polls in a row.
                storm["netSeq"] += 7
                conntrack_status.write_text(json.dumps({"epochs": {"epoch:storm": {
                    "activeNetworkCount": 0,
                    "persistedSequence": storm["netSeq"],
                    "error": "",
                }}}))

            churn_conntrack()
            control = GatewayControl(
                str(root / "gateway.sock"),
                MagicMock(),
                epoch_state,
                root,
                root / "routes.json",
                capture_status,
                conntrack_status,
                lambda: 0,
                5,
            )

            with patch("index_server.time.sleep", side_effect=lambda _seconds: churn_conntrack()):
                ack = control.end_epoch({"epochRef": "epoch:storm"})

            self.assertTrue(ack["flushed"])
            self.assertEqual(ack["persistedFlowSequence"], 9)

    def test_gateway_epoch_end_failure_keeps_epoch_active_for_retry(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            epoch_state = root / "epoch.json"
            flow_file = root / "epoch.mitm"
            net_file = root / "epoch.net.jsonl"
            capture_status = root / "capture-status.json"
            conntrack_status = root / "conntrack-status.json"
            flow_file.touch()
            net_file.touch()
            epoch_state.write_text(json.dumps({
                "active": True,
                "epochRef": "epoch:retry",
                "flowFile": str(flow_file),
                "netFile": str(net_file),
            }))
            capture_status.write_text('{"epochs":{}}')
            conntrack_status.write_text('{"epochs":{}}')
            control = GatewayControl(
                str(root / "gateway.sock"),
                MagicMock(),
                epoch_state,
                root,
                root / "routes.json",
                capture_status,
                conntrack_status,
                lambda: 1,
                0.1,
            )

            with patch("index_server.time.monotonic", side_effect=[0.0, 1.0]):
                with self.assertRaisesRegex(RuntimeError, "drain timed out"):
                    control.end_epoch({"epochRef": "epoch:retry"})

            self.assertTrue(json.loads(epoch_state.read_text())["active"])

    def test_gateway_control_reads_fragmented_newline_delimited_request(self) -> None:
        connection = MagicMock()
        connection.recv.side_effect = [
            b'{"command":"routes.',
            b'replace","payload":{"routes":[]}}\nignored',
        ]

        request = GatewayControl._read_request(connection)

        self.assertEqual(request, {"command": "routes.replace", "payload": {"routes": []}})
        self.assertEqual(connection.recv.call_count, 2)

    def test_gateway_control_rejects_request_larger_than_one_mebibyte(self) -> None:
        connection = MagicMock()
        connection.recv.side_effect = [b"x" * (64 << 10)] * 16 + [b"x"]

        with self.assertRaisesRegex(ValueError, "exceeds 1 MiB"):
            GatewayControl._read_request(connection)

if __name__ == "__main__":
    unittest.main()
