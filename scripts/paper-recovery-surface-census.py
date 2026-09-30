#!/usr/bin/env python3
"""Deep metadata-only census of publicly shipped Paper recovery surfaces.

The script downloads public artifacts only and never uploads Paper source text.
Retained outputs are provenance, hashes, paths, package availability, source-map
structure, public web asset metadata, and runtime contract indicators.
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
import urllib.request
import zipfile
from collections import Counter
from pathlib import Path

ROOT = Path("paper-recovery-surface")
RAW = ROOT / "raw"
EXTRACT = ROOT / "extract"
REPORT = ROOT / "report"
for p in (RAW, EXTRACT, REPORT):
    p.mkdir(parents=True, exist_ok=True)

ORIGIN = "https://app.paper.design"
PLAYGROUND = ORIGIN + "/playground/heatmap"
SNAPSHOT_ID = "lidfahaahiogmnlccifabccgplofocck"
APP_ID = "2601167vjw8xe"
MAP_BUILD = ("0.5.7", "260904829lm19ta")
INTERNAL_NPM = [
    "@paper/models",
    "@paper/assets",
    "@paper/cli",
    "@paper/client-desktop-types",
    "@paper/desktop",
]
TOD_MANIFESTS = ["latest-mac.yml", "latest.yml", "latest-linux.yml", "latest-linux-arm64.yml"]


def run(args: list[str]) -> subprocess.CompletedProcess:
    print("+", " ".join(args), flush=True)
    return subprocess.run(args, text=True, capture_output=True)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for b in iter(lambda: f.read(1024 * 1024), b""):
            h.update(b)
    return h.hexdigest()


def download(url: str, dest: Path, fail: bool = True) -> bool:
    dest.parent.mkdir(parents=True, exist_ok=True)
    args = ["curl", "-L", "--retry", "2", "--retry-all-errors", "--connect-timeout", "15", "--max-time", "180", "-A", "Mozilla/5.0 Paper-Lilac-Recovery/1.0", "-sS", "-o", str(dest)]
    if fail:
        args.insert(1, "-f")
    cp = run(args + [url])
    return cp.returncode == 0 and dest.exists() and dest.stat().st_size > 0


def write_tsv(path: Path, rows: list[dict], fields: list[str]) -> None:
    with path.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields, delimiter="\t")
        w.writeheader()
        w.writerows(rows)


def mime(path: Path) -> str:
    cp = run(["file", "-b", "--mime-type", str(path)])
    return cp.stdout.strip()


def unpack_crx(crx: Path, out: Path) -> bool:
    data = crx.read_bytes()
    if data[:4] != b"Cr24":
        return False
    version = struct.unpack_from("<I", data, 4)[0]
    if version == 2:
        pub_len, sig_len = struct.unpack_from("<II", data, 8)
        off = 16 + pub_len + sig_len
    elif version == 3:
        header_len = struct.unpack_from("<I", data, 8)[0]
        off = 12 + header_len
    else:
        return False
    out.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(Path(str(crx) + ".zip"), "w") as _:
        pass
    zpath = Path(str(crx) + ".payload.zip")
    zpath.write_bytes(data[off:])
    with zipfile.ZipFile(zpath) as zf:
        zf.extractall(out)
    return True


def snapshot_census() -> dict:
    url = (
        "https://clients2.google.com/service/update2/crx?response=redirect"
        "&prodversion=152.0.0.0&acceptformat=crx2,crx3"
        f"&x=id%3D{SNAPSHOT_ID}%26installsource%3Dondemand%26uc"
    )
    crx = RAW / "snapshot.crx"
    if not download(url, crx, fail=False):
        return {"downloaded": False}
    out = EXTRACT / "snapshot"
    shutil.rmtree(out, ignore_errors=True)
    ok = unpack_crx(crx, out)
    result: dict = {"downloaded": True, "unpacked": ok, "bytes": crx.stat().st_size, "sha256": sha256(crx)}
    if not ok:
        return result
    manifest = {}
    try:
        manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    except Exception:
        pass
    result["version"] = manifest.get("version")
    result["manifest_version"] = manifest.get("manifest_version")
    result["permissions"] = manifest.get("permissions", [])
    result["optional_host_permissions"] = manifest.get("optional_host_permissions", [])
    js_files = sorted(out.rglob("*.js"))
    result["js_files"] = len(js_files)
    result["js_bytes"] = sum(p.stat().st_size for p in js_files)
    urls: set[str] = set()
    chrome_apis = Counter()
    keywords = ["clipboard", "offscreen", "scripting", "activeTab", "contextMenus", "runtime.sendMessage", "runtime.onMessage", "executeScript", "paper.design"]
    keyword_hits = Counter()
    for p in js_files:
        text = p.read_text(encoding="utf-8", errors="ignore")
        urls.update(re.findall(r"https?://[^\"'`\\\s)]+", text))
        for m in re.finditer(r"chrome\.([A-Za-z0-9_.]+)", text):
            chrome_apis[m.group(1)] += 1
        for k in keywords:
            if k in text:
                keyword_hits[k] += text.count(k)
    result["public_urls"] = sorted(u for u in urls if len(u) < 400)[:200]
    result["chrome_api_tokens"] = dict(chrome_apis.most_common(100))
    result["keyword_hits"] = dict(keyword_hits)
    rows = []
    for p in sorted(x for x in out.rglob("*") if x.is_file()):
        rows.append({"path": p.relative_to(out).as_posix(), "bytes": p.stat().st_size, "sha256": sha256(p)})
    write_tsv(REPORT / "snapshot-files.tsv", rows, ["path", "bytes", "sha256"])
    return result


def normalize_asset_ref(ref: str) -> str | None:
    ref = ref.split("?", 1)[0].split("#", 1)[0]
    if not ref.endswith((".js", ".mjs", ".css", ".wasm", ".json")):
        return None
    if ref.startswith("http://") or ref.startswith("https://"):
        p = urllib.parse.urlparse(ref)
        if p.netloc != "app.paper.design":
            return None
        return ref
    ref = ref.lstrip("./")
    if ref.startswith("assets/") or ref.startswith("static/"):
        return ORIGIN + "/" + ref
    if ref.startswith("/assets/") or ref.startswith("/static/"):
        return ORIGIN + ref
    return None


def web_asset_census() -> dict:
    web = RAW / "web"
    web.mkdir(parents=True, exist_ok=True)
    html_path = web / "index.html"
    if not download(PLAYGROUND, html_path):
        return {"downloaded": False}
    html = html_path.read_text(encoding="utf-8", errors="ignore")
    seed = set()
    for ref in re.findall(r"(?:src|href)=[\"']([^\"']+)[\"']", html):
        u = urllib.parse.urljoin(PLAYGROUND, ref)
        if urllib.parse.urlparse(u).netloc == "app.paper.design":
            seed.add(u)
    queue = list(sorted(seed))
    seen: set[str] = set()
    rows: list[dict] = []
    maps: list[dict] = []
    max_assets = 350
    while queue and len(seen) < max_assets:
        url = queue.pop(0)
        if url in seen:
            continue
        seen.add(url)
        path = web / f"{len(seen):03d}-{Path(urllib.parse.urlparse(url).path).name or 'asset'}"
        if not download(url, path, fail=False):
            continue
        kind = mime(path)
        # Reject SPA fallback HTML masquerading as missing assets.
        is_html = "text/html" in kind or path.read_bytes()[:40].lower().lstrip().startswith(b"<!doctype html")
        if is_html and urllib.parse.urlparse(url).path != urllib.parse.urlparse(PLAYGROUND).path:
            continue
        row = {"url": url, "bytes": path.stat().st_size, "sha256": sha256(path), "mime": kind}
        rows.append(row)
        if "javascript" in kind or urllib.parse.urlparse(url).path.endswith((".js", ".mjs")):
            text = path.read_text(encoding="utf-8", errors="ignore")
            # Vite chunks commonly use assets/<hashed-file> literals. Normalize
            # against the origin root, not against /assets/main-*.js.
            refs = set(re.findall(r"(?:/)?(?:assets|static)/[A-Za-z0-9_./@+-]+\.(?:js|mjs|css|wasm|json)", text))
            refs.update(re.findall(r"https://app\.paper\.design/(?:assets|static)/[^\"'`\\\s)]+", text))
            for ref in refs:
                u = normalize_asset_ref(ref)
                if u and u not in seen:
                    queue.append(u)
            map_url = url.split("?", 1)[0] + ".map"
            mp = web / f"map-{len(maps):03d}.json"
            ok = download(map_url, mp, fail=False)
            valid = False
            sources = 0
            sources_content = 0
            if ok:
                try:
                    data = json.loads(mp.read_text(encoding="utf-8"))
                    valid = data.get("version") == 3 and isinstance(data.get("sources"), list)
                    sources = len(data.get("sources", [])) if valid else 0
                    sources_content = sum(x is not None for x in (data.get("sourcesContent") or [])) if valid else 0
                except Exception:
                    pass
            maps.append({"asset_url": url, "map_url": map_url, "valid": valid, "sources": sources, "sources_content": sources_content})
    write_tsv(REPORT / "web-assets.tsv", rows, ["url", "bytes", "sha256", "mime"])
    write_tsv(REPORT / "web-source-maps.tsv", maps, ["asset_url", "map_url", "valid", "sources", "sources_content"])
    js = [r for r in rows if urllib.parse.urlparse(r["url"]).path.endswith((".js", ".mjs"))]
    return {
        "downloaded": True,
        "assets": len(rows),
        "js_assets": len(js),
        "js_bytes": sum(int(r["bytes"]) for r in js),
        "valid_source_maps": sum(bool(m["valid"]) for m in maps),
    }


def npm_census() -> list[dict]:
    rows = []
    for package in INTERNAL_NPM:
        encoded = urllib.parse.quote(package, safe="")
        url = "https://registry.npmjs.org/" + encoded
        dest = RAW / (package.replace("/", "__").replace("@", "") + ".json")
        ok = download(url, dest, fail=False)
        row = {"package": package, "public_registry_document": False, "latest": "", "versions": 0, "license": ""}
        if ok:
            try:
                data = json.loads(dest.read_text(encoding="utf-8"))
                # Registry 404s are JSON too; require a package name/document shape.
                if data.get("name") == package and isinstance(data.get("versions"), dict):
                    row["public_registry_document"] = True
                    row["latest"] = (data.get("dist-tags") or {}).get("latest", "")
                    row["versions"] = len(data.get("versions") or {})
                    if row["latest"] in (data.get("versions") or {}):
                        row["license"] = str(data["versions"][row["latest"]].get("license", ""))
            except Exception:
                pass
        rows.append(row)
    write_tsv(REPORT / "npm-internal-packages.tsv", rows, ["package", "public_registry_document", "latest", "versions", "license"])
    return rows


def todesktop_census() -> list[dict]:
    rows = []
    base = f"https://download.todesktop.com/{APP_ID}/"
    for name in TOD_MANIFESTS:
        dest = RAW / name
        ok = download(base + name, dest, fail=False)
        row = {"manifest": name, "available": False, "bytes": 0, "sha256": "", "version": "", "release_date": "", "file_urls": ""}
        if ok:
            text = dest.read_text(encoding="utf-8", errors="ignore")
            # A missing manifest may be an HTML/XML error body; only accept YAML-like updater docs.
            if re.search(r"(?m)^version:\s*", text):
                row["available"] = True
                row["bytes"] = dest.stat().st_size
                row["sha256"] = sha256(dest)
                m = re.search(r"(?m)^version:\s*['\"]?([^'\"\s]+)", text)
                row["version"] = m.group(1) if m else ""
                d = re.search(r"(?m)^releaseDate:\s*['\"]?([^'\"\s]+)", text)
                row["release_date"] = d.group(1) if d else ""
                urls = re.findall(r"(?m)^\s*-?\s*url:\s*([^\s]+)", text)
                row["file_urls"] = ";".join(urls[:20])
        rows.append(row)
    write_tsv(REPORT / "todesktop-manifests.tsv", rows, ["manifest", "available", "bytes", "sha256", "version", "release_date", "file_urls"])
    return rows


def extract_dmg_and_asar(dmg: Path, out: Path) -> Path | None:
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True, exist_ok=True)
    run(["7z", "x", "-y", f"-o{out}", str(dmg)])
    c = [p for p in out.rglob("app.asar") if p.is_file()]
    return max(c, key=lambda p: p.stat().st_size) if c else None


def historical_map_census() -> dict:
    version, build = MAP_BUILD
    filename = f"Paper {version} - Build {build}-arm64.dmg"
    url = f"https://download.todesktop.com/{APP_ID}/{urllib.parse.quote(filename)}"
    dmg = RAW / "map-build.dmg"
    if not download(url, dmg):
        return {"downloaded": False}
    asar = extract_dmg_and_asar(dmg, EXTRACT / "map-build")
    if not asar:
        return {"downloaded": True, "asar": False}
    out = EXTRACT / "map-asar"
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True, exist_ok=True)
    cp = run(["asar", "extract", str(asar), str(out)])
    if cp.returncode != 0:
        return {"downloaded": True, "asar": True, "extracted": False}
    maps = sorted(out.rglob("*.map"))
    parsed = 0
    with_sources_content = 0
    unique_sources: set[str] = set()
    content_sources: set[str] = set()
    paper_like: set[str] = set()
    paper_content_sources: set[str] = set()
    map_rows: list[dict] = []
    for mp in maps:
        try:
            data = json.loads(mp.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(data.get("sources"), list):
            continue
        parsed += 1
        sources = [str(x) for x in data.get("sources", [])]
        contents = data.get("sourcesContent") if isinstance(data.get("sourcesContent"), list) else []
        has_content = any(x is not None for x in contents)
        if has_content:
            with_sources_content += 1
        local_paper = []
        for i, s in enumerate(sources):
            unique_sources.add(s)
            c = contents[i] if i < len(contents) else None
            if c is not None:
                content_sources.add(s)
            low = s.lower()
            # First-party indicators are path/name evidence only; source text is not retained.
            is_paper = any(token in low for token in ("@paper/", "/paper/", "packages/desktop", "apps/desktop", "src/")) and "node_modules" not in low
            if is_paper:
                paper_like.add(s)
                local_paper.append(s)
                if c is not None:
                    paper_content_sources.add(s)
        if local_paper:
            map_rows.append({"map_path": mp.relative_to(out).as_posix(), "sources": len(sources), "sources_content": sum(x is not None for x in contents), "paper_like_sources": ";".join(sorted(set(local_paper))[:100])})
    write_tsv(REPORT / "historical-source-map-paper-paths.tsv", map_rows, ["map_path", "sources", "sources_content", "paper_like_sources"])
    (REPORT / "historical-source-map-sources.txt").write_text("\n".join(sorted(unique_sources)) + "\n", encoding="utf-8")
    return {
        "downloaded": True,
        "asar": True,
        "maps_found": len(maps),
        "maps_parsed": parsed,
        "maps_with_sources_content": with_sources_content,
        "unique_source_paths": len(unique_sources),
        "source_paths_with_embedded_content": len(content_sources),
        "paper_like_source_paths": len(paper_like),
        "paper_like_paths_with_embedded_content": len(paper_content_sources),
        "paper_like_examples": sorted(paper_like)[:100],
    }


def wayback_census() -> dict:
    # Metadata only. A failure/denial is retained honestly and does not fail the job.
    url = (
        "https://web.archive.org/cdx/search/cdx?"
        + urllib.parse.urlencode({
            "url": "app.paper.design/assets/*",
            "output": "json",
            "filter": "statuscode:200",
            "fl": "timestamp,original,digest,length,mimetype",
            "collapse": "digest",
            "from": "2025",
            "to": "2026",
            "limit": "5000",
        })
    )
    dest = RAW / "wayback.json"
    ok = download(url, dest, fail=False)
    result = {"request_succeeded": False, "records": 0, "js": 0, "maps": 0}
    if not ok:
        return result
    try:
        data = json.loads(dest.read_text(encoding="utf-8"))
        if isinstance(data, list) and data and isinstance(data[0], list):
            rows = data[1:]
            result["request_succeeded"] = True
            result["records"] = len(rows)
            originals = [str(r[1]) for r in rows if len(r) > 1]
            result["js"] = sum(urllib.parse.urlparse(u).path.endswith((".js", ".mjs")) for u in originals)
            result["maps"] = sum(urllib.parse.urlparse(u).path.endswith(".map") for u in originals)
            write_tsv(REPORT / "wayback-assets.tsv", [
                {"timestamp": r[0] if len(r)>0 else "", "url": r[1] if len(r)>1 else "", "digest": r[2] if len(r)>2 else "", "length": r[3] if len(r)>3 else "", "mimetype": r[4] if len(r)>4 else ""}
                for r in rows
            ], ["timestamp", "url", "digest", "length", "mimetype"])
    except Exception:
        pass
    return result


def main() -> None:
    snapshot = snapshot_census()
    web = web_asset_census()
    npm = npm_census()
    tod = todesktop_census()
    maps = historical_map_census()
    wayback = wayback_census()
    summary = {
        "scope": "publicly shipped/publicly indexed artifacts only; no access-control bypass",
        "raw_proprietary_source_retained": False,
        "snapshot": snapshot,
        "web": web,
        "npm": npm,
        "todesktop": tod,
        "historical_source_maps": maps,
        "wayback": wayback,
    }
    (REPORT / "summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True), encoding="utf-8")
    (REPORT / "README.md").write_text(
        "# Paper recovery surface census\n\n"
        "Only public/shipped artifacts were inspected. No authentication or access-control bypass was used. Raw Paper source text is not retained in this report.\n\n"
        f"- Current Snapshot extension version recovered: {snapshot.get('version', 'unknown')}\n"
        f"- Public editor JS assets verified: {web.get('js_assets', 0)}\n"
        f"- Public editor valid source maps: {web.get('valid_source_maps', 0)}\n"
        f"- Historical Desktop maps parsed ({MAP_BUILD[0]}): {maps.get('maps_parsed', 0)}\n"
        f"- Historical maps with embedded sourcesContent: {maps.get('maps_with_sources_content', 0)}\n"
        f"- Paper-like historical source paths with embedded content: {maps.get('paper_like_paths_with_embedded_content', 0)}\n"
        f"- Public internal @paper npm packages discovered: {sum(bool(x.get('public_registry_document')) for x in npm)}\n"
        f"- Wayback unique asset records: {wayback.get('records', 0)}\n",
        encoding="utf-8",
    )

if __name__ == "__main__":
    main()
