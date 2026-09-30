#!/usr/bin/env python3
"""Stage public archived Paper web bundles for an authorized encrypted handoff.

Raw archived JavaScript is written only to the ephemeral runner. The workflow that
invokes this script must encrypt the directory before upload.
"""
from __future__ import annotations

import csv
import hashlib
import json
import subprocess
import urllib.parse
from pathlib import Path

ROOT = Path("authorized-paper-wayback-recovery")
WORK = Path("authorized-paper-wayback-work")
ROOT.mkdir(parents=True, exist_ok=True)
WORK.mkdir(parents=True, exist_ok=True)


def run(args: list[str]) -> subprocess.CompletedProcess:
    print("+", " ".join(args[:3]) + (" ..." if len(args) > 3 else ""), flush=True)
    return subprocess.run(args, text=True, capture_output=True)


def download(url: str, dest: Path) -> bool:
    dest.parent.mkdir(parents=True, exist_ok=True)
    cp = run(["curl", "-fL", "--retry", "2", "--retry-all-errors", "--connect-timeout", "15", "--max-time", "90", "-A", "Paper-Lilac-Authorized-Wayback/1.0", "-sS", "-o", str(dest), url])
    return cp.returncode == 0 and dest.exists() and dest.stat().st_size > 0


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


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
    cdx = WORK / "cdx.json"
    if not download(cdx_url, cdx):
        raise SystemExit("Wayback CDX unavailable")
    data = json.loads(cdx.read_text(encoding="utf-8"))
    records = data[1:] if isinstance(data, list) and data else []
    js = [r for r in records if len(r) >= 2 and urllib.parse.urlparse(str(r[1])).path.endswith((".js", ".mjs"))]
    rows = []
    for idx, rec in enumerate(js):
        timestamp = str(rec[0]); original = str(rec[1]); digest = str(rec[2]) if len(rec) > 2 else ""
        replay = f"https://web.archive.org/web/{timestamp}id_/{original}"
        basename = Path(urllib.parse.urlparse(original).path).name or f"bundle-{idx}.js"
        safe_name = f"{timestamp}-{idx:03d}-{basename}"
        dest = ROOT / "web-history" / safe_name
        if not download(replay, dest):
            dest.unlink(missing_ok=True)
            continue
        rows.append({
            "timestamp": timestamp,
            "original": original,
            "cdx_digest": digest,
            "path": dest.relative_to(ROOT).as_posix(),
            "bytes": dest.stat().st_size,
            "sha256": sha(dest),
        })
    with (ROOT / "MANIFEST.tsv").open("w", encoding="utf-8", newline="") as f:
        fields = ["timestamp", "original", "cdx_digest", "path", "bytes", "sha256"]
        w = csv.DictWriter(f, fieldnames=fields, delimiter="\t"); w.writeheader(); w.writerows(rows)
    summary = {
        "authorization_required": True,
        "cdx_js_records": len(js),
        "recovered_js_snapshots": len(rows),
        "unique_original_urls": len({r["original"] for r in rows}),
        "bytes": sum(int(r["bytes"]) for r in rows),
        "source": "public Wayback snapshots of app.paper.design assets",
    }
    (ROOT / "RECOVERY.json").write_text(json.dumps(summary, indent=2, sort_keys=True), encoding="utf-8")
    print(json.dumps(summary, sort_keys=True))


if __name__ == "__main__":
    main()
