#!/usr/bin/env python3
"""Inspect public Wayback snapshots of Paper web JS for source-map evidence.

No archived JavaScript or source text is retained. The report stores only archive
provenance, hashes, byte counts, source-map presence/counts, and source path names.
"""
from __future__ import annotations

import base64
import csv
import hashlib
import json
import re
import subprocess
import urllib.parse
from pathlib import Path

ROOT = Path("paper-wayback-census")
RAW = ROOT / "raw"
REPORT = ROOT / "report"
RAW.mkdir(parents=True, exist_ok=True)
REPORT.mkdir(parents=True, exist_ok=True)


def run(args: list[str]) -> subprocess.CompletedProcess:
    print("+", " ".join(args), flush=True)
    return subprocess.run(args, text=True, capture_output=True)


def download(url: str, path: Path) -> bool:
    cp = run(["curl", "-fL", "--retry", "2", "--retry-all-errors", "--connect-timeout", "15", "--max-time", "90", "-A", "Mozilla/5.0 Paper-Lilac-Wayback/1.0", "-sS", "-o", str(path), url])
    return cp.returncode == 0 and path.exists() and path.stat().st_size > 0


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_tsv(path: Path, rows: list[dict], fields: list[str]) -> None:
    with path.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields, delimiter="\t")
        w.writeheader()
        w.writerows(rows)


def parse_map(raw: bytes) -> dict:
    try:
        data = json.loads(raw.decode("utf-8", errors="strict"))
    except Exception:
        return {"valid": False, "sources": 0, "sources_content": 0, "source_paths": []}
    sources = data.get("sources") if isinstance(data.get("sources"), list) else []
    contents = data.get("sourcesContent") if isinstance(data.get("sourcesContent"), list) else []
    return {
        "valid": data.get("version") == 3 and bool(sources),
        "sources": len(sources),
        "sources_content": sum(x is not None for x in contents),
        "source_paths": [str(x) for x in sources],
    }


def main() -> None:
    cdx_url = "https://web.archive.org/cdx/search/cdx?" + urllib.parse.urlencode({
        "url": "app.paper.design/assets/*",
        "output": "json",
        "filter": "statuscode:200",
        "fl": "timestamp,original,digest,length,mimetype",
        "collapse": "digest",
        "from": "2025",
        "to": "2026",
        "limit": "5000",
    })
    cdx = RAW / "cdx.json"
    if not download(cdx_url, cdx):
        raise SystemExit("Wayback CDX unavailable")
    data = json.loads(cdx.read_text(encoding="utf-8"))
    records = data[1:] if isinstance(data, list) and data else []
    js_records = [r for r in records if len(r) >= 2 and urllib.parse.urlparse(str(r[1])).path.endswith((".js", ".mjs"))]

    rows: list[dict] = []
    map_source_rows: list[dict] = []
    for idx, rec in enumerate(js_records):
        timestamp = str(rec[0]); original = str(rec[1]); digest = str(rec[2]) if len(rec) > 2 else ""
        replay = f"https://web.archive.org/web/{timestamp}id_/{original}"
        js_path = RAW / f"js-{idx:03d}.bin"
        ok = download(replay, js_path)
        row = {
            "timestamp": timestamp,
            "original": original,
            "cdx_digest": digest,
            "retrieved": ok,
            "bytes": 0,
            "sha256": "",
            "source_map_kind": "none",
            "map_valid": False,
            "map_sources": 0,
            "map_sources_content": 0,
            "map_reference": "",
        }
        if not ok:
            rows.append(row); continue
        raw = js_path.read_bytes()
        row["bytes"] = len(raw); row["sha256"] = sha256_bytes(raw)
        text = raw.decode("utf-8", errors="ignore")
        matches = re.findall(r"sourceMappingURL=([^\s*]+)", text)
        if matches:
            ref = matches[-1].strip().strip("'\"")
            row["map_reference"] = ref[:500]
            info = {"valid": False, "sources": 0, "sources_content": 0, "source_paths": []}
            if ref.startswith("data:application/json"):
                row["source_map_kind"] = "inline"
                try:
                    payload = ref.split(",", 1)[1]
                    map_raw = base64.b64decode(payload) if ";base64," in ref else urllib.parse.unquote_to_bytes(payload)
                    info = parse_map(map_raw)
                except Exception:
                    pass
            else:
                row["source_map_kind"] = "external-reference"
                map_original = urllib.parse.urljoin(original, ref)
                map_replay = f"https://web.archive.org/web/{timestamp}id_/{map_original}"
                mp = RAW / f"map-{idx:03d}.bin"
                if download(map_replay, mp):
                    info = parse_map(mp.read_bytes())
            row["map_valid"] = info["valid"]
            row["map_sources"] = info["sources"]
            row["map_sources_content"] = info["sources_content"]
            if info["valid"]:
                for source in info["source_paths"]:
                    map_source_rows.append({"timestamp": timestamp, "bundle": original, "source_path": source})
        rows.append(row)
        js_path.unlink(missing_ok=True)

    write_tsv(REPORT / "archived-js.tsv", rows, ["timestamp", "original", "cdx_digest", "retrieved", "bytes", "sha256", "source_map_kind", "map_valid", "map_sources", "map_sources_content", "map_reference"])
    write_tsv(REPORT / "archived-map-source-paths.tsv", map_source_rows, ["timestamp", "bundle", "source_path"])
    summary = {
        "scope": "public Wayback snapshots only; raw JS/source text not retained",
        "cdx_records": len(records),
        "js_records": len(js_records),
        "retrieved_js_records": sum(bool(r["retrieved"]) for r in rows),
        "inline_source_maps": sum(r["source_map_kind"] == "inline" for r in rows),
        "external_map_references": sum(r["source_map_kind"] == "external-reference" for r in rows),
        "valid_maps_recovered": sum(bool(r["map_valid"]) for r in rows),
        "map_sources": sum(int(r["map_sources"]) for r in rows),
        "map_sources_content": sum(int(r["map_sources_content"]) for r in rows),
        "unique_bundle_urls": len({r["original"] for r in rows}),
    }
    (REPORT / "summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True), encoding="utf-8")
    (REPORT / "README.md").write_text(
        "# Paper Wayback JavaScript census\n\n"
        "Archived public JavaScript was inspected ephemerally; raw source is not retained.\n\n"
        + "\n".join(f"- {k}: {v}" for k, v in summary.items() if k != "scope") + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
