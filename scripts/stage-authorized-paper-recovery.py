#!/usr/bin/env python3
"""Stage authorized Paper source recovery in an ephemeral workspace.

This script is intentionally designed for a private/ephemeral runner. It recovers
source text from publicly shipped Paper artifacts only when the operator has the
necessary authorization. It does not upload or print recovered source. The caller
must encrypt the staged directory before any artifact leaves the runner.
"""
from __future__ import annotations

import csv
import hashlib
import json
import re
import shutil
import struct
import subprocess
import urllib.parse
import zipfile
from pathlib import Path

ROOT = Path("authorized-paper-recovery")
WORK = Path("authorized-paper-work")
ROOT.mkdir(parents=True, exist_ok=True)
WORK.mkdir(parents=True, exist_ok=True)

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
]
PLAYGROUND = "https://app.paper.design/playground/heatmap"
SNAPSHOT_ID = "lidfahaahiogmnlccifabccgplofocck"
TEXT_EXTS = {".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md", ".yml", ".yaml", ".toml", ".html", ".css", ".txt"}
MANIFEST_ROWS: list[dict[str, object]] = []


def run(args: list[str]) -> subprocess.CompletedProcess:
    print("+", " ".join(args[:3]) + (" ..." if len(args) > 3 else ""), flush=True)
    return subprocess.run(args, text=True, capture_output=True)


def download(url: str, dest: Path, fail: bool = True) -> bool:
    dest.parent.mkdir(parents=True, exist_ok=True)
    args = ["curl", "-L", "--retry", "3", "--retry-all-errors", "--connect-timeout", "20", "--max-time", "300", "-A", "Paper-Lilac-Authorized-Recovery/1.0", "-sS", "-o", str(dest)]
    if fail:
        args.insert(1, "-f")
    cp = run(args + [url])
    return cp.returncode == 0 and dest.exists() and dest.stat().st_size > 0


def sha_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def record(path: Path, *, origin: str, version: str) -> None:
    data = path.read_bytes()
    MANIFEST_ROWS.append({
        "path": path.relative_to(ROOT).as_posix(),
        "origin": origin,
        "version": version,
        "bytes": len(data),
        "sha256": sha_bytes(data),
    })


def write_bytes(rel: Path, data: bytes, *, origin: str, version: str) -> None:
    dest = ROOT / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    record(dest, origin=origin, version=version)


def safe_source_path(source: str) -> Path:
    source = source.replace("\\", "/")
    parts = [p for p in source.split("/") if p not in ("", ".", "..")]
    return Path(*parts) if parts else Path("unknown-source")


def dmg_url(version: str, build: str) -> str:
    filename = f"Paper {version} - Build {build}-arm64.dmg"
    return f"https://download.todesktop.com/{APP_ID}/{urllib.parse.quote(filename)}"


def extract_asar_from_dmg(version: str, build: str) -> Path | None:
    label = f"paper-{version}-{build}"
    dmg = WORK / f"{label}.dmg"
    if not download(dmg_url(version, build), dmg):
        return None
    out = WORK / f"{label}-dmg"
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True, exist_ok=True)
    # 7-Zip may return warning status because it intentionally refuses the
    # /Applications symlink; the Paper.app payload is still extracted.
    run(["7z", "x", "-y", f"-o{out}", str(dmg)])
    candidates = [p for p in out.rglob("app.asar") if p.is_file()]
    if not candidates:
        return None
    return max(candidates, key=lambda p: p.stat().st_size)


def recover_desktop_history() -> None:
    for version, build in BUILDS:
        asar = extract_asar_from_dmg(version, build)
        if asar is None:
            continue
        extracted = WORK / f"asar-{version}"
        shutil.rmtree(extracted, ignore_errors=True)
        extracted.mkdir(parents=True, exist_ok=True)
        if run(["asar", "extract", str(asar), str(extracted)]).returncode != 0:
            continue

        # Preserve the shipped first-party Desktop src tree for each sampled version.
        src = extracted / "src"
        if src.exists():
            for p in sorted(x for x in src.rglob("*") if x.is_file() and x.suffix.lower() in TEXT_EXTS):
                rel = Path("desktop-history") / version / p.relative_to(extracted)
                write_bytes(rel, p.read_bytes(), origin="desktop-asar-src", version=version)

        # Preserve useful textual build/config files outside vendor/build output.
        for p in sorted(x for x in extracted.rglob("*") if x.is_file()):
            rel0 = p.relative_to(extracted)
            if not rel0.parts:
                continue
            if rel0.parts[0] in {"node_modules", "dist", "src"}:
                continue
            if p.suffix.lower() not in TEXT_EXTS:
                continue
            # Avoid large/generated text payloads unrelated to first-party source.
            if p.stat().st_size > 2_000_000:
                continue
            rel = Path("desktop-history") / version / "root-text" / rel0
            write_bytes(rel, p.read_bytes(), origin="desktop-asar-text", version=version)

        # Old releases shipped source maps. Recover only non-node_modules sourcesContent.
        dist = extracted / "dist"
        if dist.exists():
            for mp in sorted(dist.glob("*.map")):
                try:
                    data = json.loads(mp.read_text(encoding="utf-8"))
                except Exception:
                    continue
                sources = data.get("sources") if isinstance(data.get("sources"), list) else []
                contents = data.get("sourcesContent") if isinstance(data.get("sourcesContent"), list) else []
                for i, source in enumerate(sources):
                    source = str(source)
                    if "node_modules" in source.replace("\\", "/").split("/"):
                        continue
                    content = contents[i] if i < len(contents) else None
                    if not isinstance(content, str):
                        continue
                    rel = Path("sourcemap-history") / version / mp.stem / safe_source_path(source)
                    write_bytes(rel, content.encode("utf-8"), origin=f"{mp.relative_to(extracted).as_posix()}:sourcesContent", version=version)

        # Delete bulky raw artifact/extraction as soon as this version is staged.
        shutil.rmtree(extracted, ignore_errors=True)
        shutil.rmtree(asar.parents[4] if len(asar.parents) > 4 and str(asar.parents[4]).startswith(str(WORK)) else WORK / f"paper-{version}-{build}-dmg", ignore_errors=True)
        (WORK / f"paper-{version}-{build}.dmg").unlink(missing_ok=True)


def unpack_crx(crx: Path, out: Path) -> bool:
    data = crx.read_bytes()
    if data[:4] != b"Cr24":
        return False
    version = struct.unpack_from("<I", data, 4)[0]
    if version == 2:
        pub_len, sig_len = struct.unpack_from("<II", data, 8)
        off = 16 + pub_len + sig_len
    elif version == 3:
        off = 12 + struct.unpack_from("<I", data, 8)[0]
    else:
        return False
    payload = WORK / "snapshot-payload.zip"
    payload.write_bytes(data[off:])
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(payload) as zf:
        zf.extractall(out)
    return True


def recover_snapshot() -> None:
    url = (
        "https://clients2.google.com/service/update2/crx?response=redirect"
        "&prodversion=152.0.0.0&acceptformat=crx2,crx3"
        f"&x=id%3D{SNAPSHOT_ID}%26installsource%3Dondemand%26uc"
    )
    crx = WORK / "snapshot.crx"
    if not download(url, crx, fail=False):
        return
    out = WORK / "snapshot"
    if not unpack_crx(crx, out):
        return
    version = "unknown"
    try:
        version = str(json.loads((out / "manifest.json").read_text(encoding="utf-8")).get("version", "unknown"))
    except Exception:
        pass
    for p in sorted(x for x in out.rglob("*") if x.is_file() and x.suffix.lower() in TEXT_EXTS):
        write_bytes(Path("snapshot-shipped") / version / p.relative_to(out), p.read_bytes(), origin="snapshot-crx", version=version)


def is_html_fallback(data: bytes) -> bool:
    return data[:80].lower().lstrip().startswith(b"<!doctype html") or data[:80].lower().lstrip().startswith(b"<html")


def normalize_asset(ref: str) -> str | None:
    ref = ref.split("?", 1)[0].split("#", 1)[0]
    if ref.startswith("http://") or ref.startswith("https://"):
        p = urllib.parse.urlparse(ref)
        return ref if p.netloc == "app.paper.design" else None
    ref = ref.lstrip("./")
    if ref.startswith(("assets/", "static/")):
        return "https://app.paper.design/" + ref
    if ref.startswith(("/assets/", "/static/")):
        return "https://app.paper.design" + ref
    return None


def recover_current_web() -> None:
    html = WORK / "playground.html"
    if not download(PLAYGROUND, html):
        return
    text = html.read_text(encoding="utf-8", errors="ignore")
    seed = set(urllib.parse.urljoin(PLAYGROUND, x) for x in re.findall(r"(?:src|href)=[\"']([^\"']+)[\"']", text))
    queue = [u for u in sorted(seed) if urllib.parse.urlparse(u).netloc == "app.paper.design"]
    seen: set[str] = set()
    while queue and len(seen) < 350:
        url = queue.pop(0)
        if url in seen:
            continue
        seen.add(url)
        suffix = Path(urllib.parse.urlparse(url).path).suffix.lower()
        if suffix not in {".js", ".mjs", ".css", ".json"}:
            continue
        dest = WORK / "web" / f"{len(seen):03d}-{Path(urllib.parse.urlparse(url).path).name}"
        if not download(url, dest, fail=False):
            continue
        raw = dest.read_bytes()
        if is_html_fallback(raw):
            continue
        name = Path(urllib.parse.urlparse(url).path).name
        write_bytes(Path("web-shipped-current") / name, raw, origin=url, version="current")
        if suffix in {".js", ".mjs"}:
            js = raw.decode("utf-8", errors="ignore")
            refs = set(re.findall(r"(?:/)?(?:assets|static)/[A-Za-z0-9_./@+-]+\.(?:js|mjs|css|json)", js))
            refs.update(re.findall(r"https://app\.paper\.design/(?:assets|static)/[^\"'`\\\s)]+", js))
            for ref in refs:
                u = normalize_asset(ref)
                if u and u not in seen:
                    queue.append(u)


def finalize_manifest() -> None:
    MANIFEST_ROWS.sort(key=lambda r: str(r["path"]))
    with (ROOT / "MANIFEST.tsv").open("w", encoding="utf-8", newline="") as f:
        fields = ["path", "origin", "version", "bytes", "sha256"]
        w = csv.DictWriter(f, fieldnames=fields, delimiter="\t")
        w.writeheader(); w.writerows(MANIFEST_ROWS)
    counts: dict[str, int] = {}
    for row in MANIFEST_ROWS:
        top = str(row["path"]).split("/", 1)[0]
        counts[top] = counts.get(top, 0) + 1
    (ROOT / "RECOVERY.json").write_text(json.dumps({
        "authorization_required": True,
        "source": "publicly shipped Paper artifacts",
        "files": len(MANIFEST_ROWS),
        "bytes": sum(int(r["bytes"]) for r in MANIFEST_ROWS),
        "counts_by_surface": counts,
        "note": "Recovered source/code is for the authorized project owner; preserve provenance and third-party rights.",
    }, indent=2, sort_keys=True), encoding="utf-8")


def main() -> None:
    recover_desktop_history()
    recover_snapshot()
    recover_current_web()
    finalize_manifest()
    meta = json.loads((ROOT / "RECOVERY.json").read_text(encoding="utf-8"))
    print(json.dumps({"files": meta["files"], "bytes": meta["bytes"], "counts_by_surface": meta["counts_by_surface"]}, sort_keys=True))


if __name__ == "__main__":
    main()
