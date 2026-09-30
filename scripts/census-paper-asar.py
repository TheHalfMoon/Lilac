#!/usr/bin/env python3
"""Metadata-only census for a publicly shipped Paper Desktop app.asar.

This script intentionally does not emit recovered source contents. It records
hashes, source paths, source-map coverage, and package metadata so Lilac can
track recovery evidence without publishing proprietary source in the public
repository.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import struct
from pathlib import Path
from typing import Any, Iterator


INTERNAL_PATH_MARKERS = (
    "models/src/",
    "assets/src/",
    "client-desktop-types/src/",
    "cli/",
)

TARGET_PATH_SUFFIXES = (
    "assets/src/types.ts",
    "models/src/mcp/mcp-types.ts",
    "client-desktop-types/src/desktop-bridge.ts",
)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def walk_entries(node: dict[str, Any], prefix: str = "") -> Iterator[tuple[str, dict[str, Any]]]:
    for name, entry in node.get("files", {}).items():
        path = f"{prefix}/{name}" if prefix else name
        if "files" in entry:
            yield from walk_entries(entry, path)
        else:
            yield path, entry


def normalize_source_path(path: str) -> str:
    value = path.replace("\\", "/")
    for prefix in ("webpack://", "vite://", "file://"):
        if value.startswith(prefix):
            value = value[len(prefix) :]
    while value.startswith("./"):
        value = value[2:]
    return value


class AsarReader:
    def __init__(self, path: Path):
        self.path = path
        self.file = path.open("rb")
        first = self.file.read(16)
        if len(first) != 16:
            raise ValueError("ASAR header is truncated")
        _a, b, _c, json_len = struct.unpack("<4I", first)
        raw_header = self.file.read(json_len)
        self.header = json.loads(raw_header.decode("utf-8"))
        self.data_start = 8 + b
        self.entries = dict(walk_entries(self.header))
        self.unpacked_root = path.with_name(path.name + ".unpacked")

    def close(self) -> None:
        self.file.close()

    def read(self, path: str) -> bytes | None:
        entry = self.entries.get(path)
        if entry is None:
            return None
        if "link" in entry:
            return None
        if entry.get("unpacked"):
            unpacked = self.unpacked_root / path
            return unpacked.read_bytes() if unpacked.is_file() else None
        size = int(entry.get("size", 0))
        offset = int(entry.get("offset", "0"))
        self.file.seek(self.data_start + offset)
        data = self.file.read(size)
        if len(data) != size:
            raise ValueError(f"short read for {path}: {len(data)} != {size}")
        return data


def classify_internal_source(path: str) -> bool:
    p = normalize_source_path(path)
    return any(marker in p for marker in INTERNAL_PATH_MARKERS)


def target_name(path: str) -> str | None:
    p = normalize_source_path(path)
    for suffix in TARGET_PATH_SUFFIXES:
        if p.endswith(suffix):
            return suffix
    return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("asar", type=Path)
    parser.add_argument("--version", required=True)
    parser.add_argument("--build-id", required=True)
    parser.add_argument("--dmg-sha256", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    reader = AsarReader(args.asar)
    try:
        entries = sorted(reader.entries)
        source_files = [p for p in entries if p.startswith("src/") and p.endswith((".ts", ".tsx", ".js", ".jsx"))]
        source_file_hashes: dict[str, str] = {}
        for path in source_files:
            data = reader.read(path)
            if data is not None:
                source_file_hashes[path] = sha256_bytes(data)

        package_info: dict[str, Any] = {}
        package_raw = reader.read("package.json")
        if package_raw:
            try:
                package = json.loads(package_raw.decode("utf-8"))
                package_info = {
                    "name": package.get("name"),
                    "version": package.get("version"),
                    "private": package.get("private"),
                    "license": package.get("license"),
                }
            except Exception as exc:  # evidence should record parse failure, not hide it
                package_info = {"parse_error": str(exc)}

        map_paths = [p for p in entries if p.endswith(".map")]
        maps_parsed = 0
        maps_with_sources_content = 0
        unique_map_sources: set[str] = set()
        sources_with_content: set[str] = set()
        internal_with_content: dict[str, dict[str, Any]] = {}
        target_hits: dict[str, list[dict[str, Any]]] = {name: [] for name in TARGET_PATH_SUFFIXES}

        for map_path in map_paths:
            raw = reader.read(map_path)
            if not raw:
                continue
            try:
                payload = json.loads(raw.decode("utf-8"))
            except Exception:
                continue
            maps_parsed += 1
            sources = payload.get("sources") or []
            contents = payload.get("sourcesContent") or []
            if contents:
                maps_with_sources_content += 1
            for index, source in enumerate(sources):
                if not isinstance(source, str):
                    continue
                normalized = normalize_source_path(source)
                unique_map_sources.add(normalized)
                content = contents[index] if index < len(contents) else None
                if isinstance(content, str):
                    sources_with_content.add(normalized)
                    if classify_internal_source(normalized):
                        digest = sha256_bytes(content.encode("utf-8"))
                        internal_with_content.setdefault(
                            normalized,
                            {"sha256": digest, "bytes": len(content.encode("utf-8")), "maps": []},
                        )["maps"].append(map_path)
                    target = target_name(normalized)
                    if target:
                        target_hits[target].append(
                            {
                                "source_path": normalized,
                                "sha256": sha256_bytes(content.encode("utf-8")),
                                "bytes": len(content.encode("utf-8")),
                                "map": map_path,
                            }
                        )

        result = {
            "scope": "metadata-only census of public/shipped Paper Desktop artifact",
            "version": args.version,
            "build_id": args.build_id,
            "dmg_sha256": args.dmg_sha256,
            "asar": {
                "bytes": args.asar.stat().st_size,
                "sha256": sha256_file(args.asar),
                "entries": len(entries),
            },
            "package": package_info,
            "first_party_source": {
                "count": len(source_file_hashes),
                "paths": source_file_hashes,
            },
            "source_maps": {
                "count": len(map_paths),
                "parsed": maps_parsed,
                "with_sources_content": maps_with_sources_content,
                "unique_source_paths": len(unique_map_sources),
                "source_paths_with_content": len(sources_with_content),
                "internal_paths_with_content": internal_with_content,
                "target_hits": target_hits,
            },
            "raw_source_emitted": False,
        }
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    finally:
        reader.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
