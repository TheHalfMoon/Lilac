#!/usr/bin/env python3
"""Inventory authorized first-party Paper workspace sources embedded in a source map.

The script never emits source text. It records normalized source paths, byte sizes,
and SHA-256 hashes for clearly identified Paper workspace packages. Use it only on
artifacts you are authorized to inspect.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
from pathlib import Path, PurePosixPath

FIRST_PARTY_PREFIXES = {
    "assets": "../../assets/",
    "models": "../../models/",
    "client-desktop-types": "../../client-desktop-types/",
    "cli": "../../cli/",
}


def digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def inventory(map_path: Path) -> list[dict[str, object]]:
    data = json.loads(map_path.read_text(encoding="utf-8"))
    sources = data.get("sources") or []
    contents = data.get("sourcesContent") or []
    rows: list[dict[str, object]] = []
    for i, source in enumerate(sources):
        source = str(source)
        package = next((name for name, prefix in FIRST_PARTY_PREFIXES.items() if source.startswith(prefix)), None)
        if package is None:
            continue
        content = contents[i] if i < len(contents) else None
        rows.append({
            "package": package,
            "source_path": source,
            "embedded_content": content is not None,
            "utf8_bytes": len(content.encode("utf-8")) if isinstance(content, str) else 0,
            "sha256": digest(content) if isinstance(content, str) else "",
        })
    return rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("map", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    rows = inventory(args.map)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8", newline="") as f:
        fields = ["package", "source_path", "embedded_content", "utf8_bytes", "sha256"]
        w = csv.DictWriter(f, fieldnames=fields, delimiter="\t")
        w.writeheader()
        w.writerows(rows)
    print(json.dumps({
        "files": len(rows),
        "embedded": sum(bool(r["embedded_content"]) for r in rows),
        "packages": {name: sum(r["package"] == name for r in rows) for name in FIRST_PARTY_PREFIXES},
    }, sort_keys=True))


if __name__ == "__main__":
    main()
