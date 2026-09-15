from __future__ import annotations

import json
import os
import re
import threading
from pathlib import Path
from typing import Callable


class SegmentedCapture:
    def __init__(
        self,
        path: Path,
        suffix: str,
        segment_bytes: int,
        max_files: int,
        count_records: Callable[[Path], int],
        evicted_field: str = "evictedRecords",
    ) -> None:
        if not path.name.endswith(suffix):
            raise ValueError(f"capture path must end with {suffix}")
        self.path = path
        self.suffix = suffix
        self.segment_bytes = max(1, segment_bytes)
        self.max_files = max(1, max_files)
        self.count_records = count_records
        self.evicted_field = evicted_field
        self.prefix = path.name[:-len(suffix)]
        self.manifest_path = Path(f"{path}.quota.json")
        self.part_pattern = re.compile(
            rf"^{re.escape(self.prefix)}\.part-(?P<sequence>\d+)-n(?P<count>\d+){re.escape(suffix)}$"
        )
        self.tombstone_pattern = re.compile(
            rf"^\.(?P<part>{re.escape(self.prefix)}\.part-(?P<sequence>\d+)-n(?P<count>\d+){re.escape(suffix)})\.evicted$"
        )
        self.lock = threading.Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.active_records = self.count_records(path) if path.exists() else 0
        self._recover_tombstones()
        known_sequences = [item[0] for item in self._parts()]
        for part_name in self._read_manifest().get("evictions", {}):
            match = self.part_pattern.match(str(part_name))
            if match:
                known_sequences.append(int(match.group("sequence")))
        self.next_sequence = 1 + max(known_sequences, default=0)
        self._enforce_retention()
        self._write_manifest()

    def append(self, payload: bytes, records: int = 1) -> None:
        if not payload:
            return
        with self.lock:
            current_size = self.path.stat().st_size if self.path.exists() else 0
            if current_size > 0 and current_size + len(payload) > self.segment_bytes:
                self._rotate()
            descriptor = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o664)
            try:
                view = memoryview(payload)
                while view:
                    written = os.write(descriptor, view)
                    if written <= 0:
                        raise OSError("capture append made no progress")
                    view = view[written:]
            finally:
                os.close(descriptor)
            self.active_records += max(0, records)

    def state(self) -> dict:
        with self.lock:
            return self._manifest_value()

    def _rotate(self) -> None:
        if not self.path.exists() or self.path.stat().st_size == 0:
            return
        target = self.path.with_name(
            f"{self.prefix}.part-{self.next_sequence:06d}-n{self.active_records:09d}{self.suffix}"
        )
        self.next_sequence += 1
        os.replace(self.path, target)
        self.active_records = 0
        self._enforce_retention()
        self._write_manifest()

    def _enforce_retention(self) -> None:
        parts = self._parts()
        retained_parts = max(0, self.max_files - 1)
        for _, count, part in parts[:max(0, len(parts) - retained_parts)]:
            tombstone = part.with_name(f".{part.name}.evicted")
            os.replace(part, tombstone)
            self._account_tombstone(tombstone, part.name, count)

    def _recover_tombstones(self) -> None:
        for tombstone in self.path.parent.glob(f".{self.prefix}.part-*{self.suffix}.evicted"):
            match = self.tombstone_pattern.match(tombstone.name)
            if not match:
                continue
            self._account_tombstone(tombstone, match.group("part"), int(match.group("count")))

    def _account_tombstone(self, tombstone: Path, part_name: str, count: int) -> None:
        manifest = self._read_manifest()
        evictions = manifest.get("evictions")
        if not isinstance(evictions, dict):
            evictions = {}
        if part_name not in evictions:
            evictions[part_name] = max(0, count)
        manifest["evictions"] = evictions
        self._write_manifest(manifest)
        tombstone.unlink(missing_ok=True)

    def _parts(self) -> list[tuple[int, int, Path]]:
        parts: list[tuple[int, int, Path]] = []
        for path in self.path.parent.glob(f"{self.prefix}.part-*{self.suffix}"):
            match = self.part_pattern.match(path.name)
            if match:
                parts.append((int(match.group("sequence")), int(match.group("count")), path))
        return sorted(parts)

    def _read_manifest(self) -> dict:
        try:
            value = json.loads(self.manifest_path.read_text(encoding="utf-8"))
            return value if isinstance(value, dict) else {}
        except (FileNotFoundError, OSError, json.JSONDecodeError):
            return {}

    def _manifest_value(self, existing: dict | None = None) -> dict:
        value = dict(existing or self._read_manifest())
        evictions = value.get("evictions")
        if not isinstance(evictions, dict):
            evictions = {}
        evicted_records = sum(
            count for count in evictions.values()
            if isinstance(count, int) and count > 0
        )
        value.update({
            "version": 1,
            "segmentBytes": self.segment_bytes,
            "maxFiles": self.max_files,
            "quotaBytes": self.segment_bytes * self.max_files,
            "quotaPressure": evicted_records > 0,
            "evictedRecords": evicted_records,
            self.evicted_field: evicted_records,
            "evictions": evictions,
        })
        return value

    def _write_manifest(self, existing: dict | None = None) -> None:
        value = self._manifest_value(existing)
        temporary = self.manifest_path.with_name(f".{self.manifest_path.name}.{os.getpid()}.tmp")
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o664)
        try:
            payload = json.dumps(value, separators=(",", ":")).encode()
            view = memoryview(payload)
            while view:
                written = os.write(descriptor, view)
                if written <= 0:
                    raise OSError("manifest write made no progress")
                view = view[written:]
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        os.replace(temporary, self.manifest_path)


def capture_base_path(path: Path, suffix: str) -> Path:
    if not path.name.endswith(suffix):
        return path
    prefix = path.name[:-len(suffix)]
    match = re.match(r"^(?P<base>.+)\.part-\d+-n\d+$", prefix)
    base = match.group("base") if match else prefix
    return path.with_name(f"{base}{suffix}")


def capture_quota_state(path: Path, suffix: str, evicted_field: str = "evictedRecords") -> dict:
    base_path = capture_base_path(path, suffix)
    manifest_path = Path(f"{base_path}.quota.json")
    try:
        value = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        value = {}
    evicted = value.get(evicted_field, value.get("evictedRecords", 0))
    return {
        "quota_pressure": bool(value.get("quotaPressure", False)),
        "evicted_records": evicted if isinstance(evicted, int) and evicted > 0 else 0,
    }
