#!/usr/bin/env python3
"""Recover metadata lineage from historical publicly shipped Paper Desktop builds.

Raw DMGs/ASAR/source files are processed only inside the ephemeral CI runner. The
persisted report contains provenance, file paths, hashes, sizes, and cross-version
lineage—not proprietary source text.
"""

from __future__ import annotations

import csv
import hashlib
import json
import shutil
import subprocess
import urllib.parse
from collections import defaultdict
from pathlib import Path

ROOT = Path("paper-history")
RAW = ROOT / "raw"
EXTRACT = ROOT / "extract"
REPORT = ROOT / "report"
for p in (RAW, EXTRACT, REPORT):
    p.mkdir(parents=True, exist_ok=True)

APP_ID = "2601167vjw8xe"
BUILDS = [
    ("0.1.10", "26031739o5exfj4"),
    ("0.1.12", "2604116ylbmu5uc"),
    ("0.1.14", "260513c3lncpex8"),
    ("0.2.0", "2605227oebjghyb"),
    ("0.3.2", "260529m17bb6bkl"),
    ("0.4.4", "260706m7lwa680d"),
    ("0.5.0", "260718w0gs8apen"),
    ("0.5.7", "260904829lm19ta"),
    ("0.5.14", "260930cd6gd2j72"),
]


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def run(cmd: list[str], *, check: bool = False) -> subprocess.CompletedProcess:
    print("+", " ".join(cmd), flush=True)
    return subprocess.run(cmd, text=True, capture_output=True, check=check)


def curl(url: str, dest: Path) -> bool:
    cp = run([
        "curl", "-fL", "--retry", "3", "--retry-all-errors",
        "--connect-timeout", "20", "--max-time", "300",
        "-A", "Mozilla/5.0 Paper-Lilac-History/1.0",
        "-o", str(dest), "-sS", url,
    ])
    return cp.returncode == 0 and dest.exists() and dest.stat().st_size > 0


def write_tsv(path: Path, rows: list[dict], fields: list[str]) -> None:
    with path.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields, delimiter="\t")
        w.writeheader()
        w.writerows(rows)


def dmg_url(version: str, build_id: str) -> str:
    filename = f"Paper {version} - Build {build_id}-arm64.dmg"
    return f"https://download.todesktop.com/{APP_ID}/{urllib.parse.quote(filename)}"


def extract_dmg(dmg: Path, out: Path) -> bool:
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True, exist_ok=True)
    cp = run(["7z", "x", "-y", f"-o{out}", str(dmg)])
    return cp.returncode == 0


def find_asar(root: Path) -> Path | None:
    candidates = [p for p in root.rglob("app.asar") if p.is_file()]
    if not candidates:
        return None
    return max(candidates, key=lambda p: p.stat().st_size)


def list_asar(asar: Path) -> list[str]:
    cp = run(["asar", "list", str(asar)])
    if cp.returncode != 0:
        return []
    return [line.strip().lstrip("/") for line in cp.stdout.splitlines() if line.strip()]


def extract_asar(asar: Path, out: Path) -> bool:
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True, exist_ok=True)
    cp = run(["asar", "extract", str(asar), str(out)])
    return cp.returncode == 0


def read_package(root: Path) -> dict:
    path = root / "package.json"
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def main() -> None:
    build_rows: list[dict] = []
    source_rows: list[dict] = []
    all_entry_sets: dict[str, set[str]] = {}

    for version, build_id in BUILDS:
        label = f"paper-{version}-{build_id}"
        url = dmg_url(version, build_id)
        dmg = RAW / f"{label}.dmg"
        row = {
            "version": version,
            "build_id": build_id,
            "url": url,
            "downloaded": False,
            "dmg_bytes": 0,
            "dmg_sha256": "",
            "asar_bytes": 0,
            "asar_sha256": "",
            "asar_entries": 0,
            "src_files": 0,
            "src_ts": 0,
            "src_tsx": 0,
            "source_maps": 0,
            "package_name": "",
            "package_version": "",
            "license": "",
        }
        if not curl(url, dmg):
            build_rows.append(row)
            continue
        row["downloaded"] = True
        row["dmg_bytes"] = dmg.stat().st_size
        row["dmg_sha256"] = sha256(dmg)

        unpacked = EXTRACT / label
        if not extract_dmg(dmg, unpacked):
            build_rows.append(row)
            dmg.unlink(missing_ok=True)
            continue
        asar = find_asar(unpacked)
        if not asar:
            build_rows.append(row)
            shutil.rmtree(unpacked, ignore_errors=True)
            dmg.unlink(missing_ok=True)
            continue

        entries = list_asar(asar)
        all_entry_sets[version] = set(entries)
        row["asar_bytes"] = asar.stat().st_size
        row["asar_sha256"] = sha256(asar)
        row["asar_entries"] = len(entries)
        row["source_maps"] = sum(p.endswith(".map") for p in entries)

        asar_out = EXTRACT / f"{label}-asar"
        if extract_asar(asar, asar_out):
            pkg = read_package(asar_out)
            row["package_name"] = str(pkg.get("name", ""))
            row["package_version"] = str(pkg.get("version", ""))
            row["license"] = str(pkg.get("license", ""))

            src = asar_out / "src"
            if src.exists():
                src_files = sorted(p for p in src.rglob("*") if p.is_file())
                row["src_files"] = len(src_files)
                row["src_ts"] = sum(p.suffix == ".ts" for p in src_files)
                row["src_tsx"] = sum(p.suffix == ".tsx" for p in src_files)
                for p in src_files:
                    source_rows.append({
                        "version": version,
                        "build_id": build_id,
                        "path": p.relative_to(asar_out).as_posix(),
                        "bytes": p.stat().st_size,
                        "sha256": sha256(p),
                    })

        build_rows.append(row)
        shutil.rmtree(asar_out, ignore_errors=True)
        shutil.rmtree(unpacked, ignore_errors=True)
        dmg.unlink(missing_ok=True)

    build_fields = [
        "version", "build_id", "url", "downloaded", "dmg_bytes", "dmg_sha256",
        "asar_bytes", "asar_sha256", "asar_entries", "src_files", "src_ts", "src_tsx",
        "source_maps", "package_name", "package_version", "license",
    ]
    write_tsv(REPORT / "historical-builds.tsv", build_rows, build_fields)
    write_tsv(REPORT / "historical-src-lineage.tsv", source_rows, ["version", "build_id", "path", "bytes", "sha256"])

    by_path: dict[str, list[dict]] = defaultdict(list)
    for r in source_rows:
        by_path[r["path"]].append(r)
    version_index = {v: i for i, (v, _) in enumerate(BUILDS)}
    unique_rows = []
    for path, rows in sorted(by_path.items()):
        rows.sort(key=lambda r: version_index.get(r["version"], 999))
        versions = [r["version"] for r in rows]
        hashes = {r["sha256"] for r in rows}
        unique_rows.append({
            "path": path,
            "first_seen": versions[0],
            "last_seen": versions[-1],
            "versions_seen": len(set(versions)),
            "distinct_content_hashes": len(hashes),
            "latest_bytes": rows[-1]["bytes"],
            "latest_sha256": rows[-1]["sha256"],
        })
    write_tsv(
        REPORT / "historical-src-summary.tsv",
        unique_rows,
        ["path", "first_seen", "last_seen", "versions_seen", "distinct_content_hashes", "latest_bytes", "latest_sha256"],
    )

    delta_rows = []
    available_versions = [v for v, _ in BUILDS if v in all_entry_sets]
    for prev, cur in zip(available_versions, available_versions[1:]):
        a, b = all_entry_sets[prev], all_entry_sets[cur]
        delta_rows.append({
            "from": prev,
            "to": cur,
            "added_entries": len(b - a),
            "removed_entries": len(a - b),
            "added_src": len({p for p in b - a if p.startswith("src/")}),
            "removed_src": len({p for p in a - b if p.startswith("src/")}),
        })
    write_tsv(REPORT / "historical-entry-deltas.tsv", delta_rows, ["from", "to", "added_entries", "removed_entries", "added_src", "removed_src"])

    summary = {
        "scope": "historical public ToDesktop Paper Desktop artifacts; metadata/source hashes only",
        "raw_proprietary_source_retained": False,
        "requested_builds": len(BUILDS),
        "downloaded_builds": sum(bool(r["downloaded"]) for r in build_rows),
        "builds_with_src": sum(int(r["src_files"]) > 0 for r in build_rows),
        "unique_src_paths": len(unique_rows),
        "historically_changed_src_paths": sum(int(r["distinct_content_hashes"]) > 1 for r in unique_rows),
        "historical_only_src_paths": sum(r["last_seen"] != BUILDS[-1][0] for r in unique_rows),
        "builds": build_rows,
        "deltas": delta_rows,
    }
    (REPORT / "summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True), encoding="utf-8")
    (REPORT / "README.md").write_text(
        "# Paper Desktop historical archaeology\n\n"
        "This report compares publicly distributed Paper Desktop releases. Raw proprietary source text is not retained.\n\n"
        f"- Requested builds: {summary['requested_builds']}\n"
        f"- Downloaded builds: {summary['downloaded_builds']}\n"
        f"- Builds containing shipped `src/`: {summary['builds_with_src']}\n"
        f"- Unique historical `src/` paths: {summary['unique_src_paths']}\n"
        f"- Paths with changed content across releases: {summary['historically_changed_src_paths']}\n"
        f"- Historical-only paths absent from latest sampled release: {summary['historical_only_src_paths']}\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
