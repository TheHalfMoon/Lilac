#!/usr/bin/env python3
"""Metadata-only census of publicly shipped Paper artifacts.

This script intentionally does not persist Paper proprietary source in the repository
or uploaded workflow artifact. Raw downloads/extractions live only in the ephemeral
GitHub Actions workspace. The retained report contains hashes, file names, counts,
package metadata, and public asset/source-map observations.
"""

from __future__ import annotations

import csv
import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import urllib.parse
import zipfile
from pathlib import Path

ROOT = Path("paper-census")
RAW = ROOT / "raw"
EXTRACT = ROOT / "extract"
REPORT = ROOT / "report"
for p in (RAW, EXTRACT, REPORT):
    p.mkdir(parents=True, exist_ok=True)

DOWNLOADS = {
    "desktop-windows-x64": "https://download.paper.design/windows/nsis/x64",
    "desktop-linux-appimage": "https://download.paper.design/linux/appImage",
    "desktop-linux-deb": "https://download.paper.design/linux/deb",
    "desktop-linux-rpm": "https://download.paper.design/linux/rpm",
    "desktop-macos-arm64": "https://download.paper.design/mac/dmg/arm64",
    "snapshot-crx": (
        "https://clients2.google.com/service/update2/crx?response=redirect"
        "&prodversion=152.0.0.0&acceptformat=crx2,crx3"
        "&x=id%3Dlidfahaahiogmnlccifabccgplofocck%26installsource%3Dondemand%26uc"
    ),
}

PUBLIC_REPOS = [
    "agent-plugins",
    "shaders",
    "paper-mono",
    "liquid-logo",
    "google-fonts-scripts",
    "opentype.js",
    "webmcp-agent-example",
]

PLAYGROUND = "https://app.paper.design/playground/heatmap"


def run(cmd: list[str], *, check: bool = True, stdout=None, stderr=None) -> subprocess.CompletedProcess:
    print("+", " ".join(cmd), flush=True)
    return subprocess.run(cmd, check=check, text=True, stdout=stdout, stderr=stderr)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def curl(url: str, dest: Path, *, fail: bool = True) -> bool:
    dest.parent.mkdir(parents=True, exist_ok=True)
    args = [
        "curl", "-L", "--retry", "3", "--retry-all-errors",
        "--connect-timeout", "20", "--max-time", "300",
        "-A", "Mozilla/5.0 Chrome/152 Paper-Lilac-Census/1.0",
        "-o", str(dest), "-sS",
    ]
    if fail:
        args.insert(1, "-f")
    cp = run(args + [url], check=False)
    return cp.returncode == 0 and dest.exists() and dest.stat().st_size > 0


def mime(path: Path) -> str:
    cp = subprocess.run(["file", "-b", "--mime-type", str(path)], text=True, capture_output=True)
    return cp.stdout.strip()


def write_tsv(path: Path, rows: list[dict], fields: list[str]) -> None:
    with path.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields, delimiter="\t")
        w.writeheader()
        w.writerows(rows)


def recursive_file_rows(root: Path, label: str) -> list[dict]:
    rows = []
    for p in sorted(x for x in root.rglob("*") if x.is_file()):
        rel = p.relative_to(root).as_posix()
        rows.append({
            "artifact": label,
            "path": rel,
            "bytes": p.stat().st_size,
            "sha256": sha256(p),
        })
    return rows


def extension_counts(root: Path) -> dict[str, int]:
    counts: dict[str, int] = {}
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        suffix = p.suffix.lower() or "<none>"
        counts[suffix] = counts.get(suffix, 0) + 1
    return dict(sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])))


def unpack_crx(crx: Path, out: Path) -> tuple[bool, str]:
    data = crx.read_bytes()
    if data[:4] != b"Cr24":
        return False, "not-crx"
    version = struct.unpack_from("<I", data, 4)[0]
    if version == 2:
        pub_len, sig_len = struct.unpack_from("<II", data, 8)
        offset = 16 + pub_len + sig_len
    elif version == 3:
        header_len = struct.unpack_from("<I", data, 8)[0]
        offset = 12 + header_len
    else:
        return False, f"unsupported-crx-version-{version}"
    zip_path = crx.with_suffix(".zip")
    zip_path.write_bytes(data[offset:])
    out.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as zf:
        zf.extractall(out)
    return True, f"crx{version}"


def extract_desktop(label: str, path: Path) -> Path | None:
    out = EXTRACT / label
    out.mkdir(parents=True, exist_ok=True)
    try:
        if "appimage" in label:
            os.chmod(path, 0o755)
            cp = subprocess.run([str(path.resolve()), "--appimage-extract"], cwd=out, text=True, capture_output=True)
            if cp.returncode == 0 and (out / "squashfs-root").exists():
                return out / "squashfs-root"
            run(["7z", "x", "-y", f"-o{out}", str(path.resolve())], check=False)
            return out
        if label.endswith("-deb"):
            run(["dpkg-deb", "-x", str(path), str(out)], check=False)
            return out
        if label.endswith("-rpm"):
            cmd = f"rpm2cpio {shlex_quote(str(path))} | (cd {shlex_quote(str(out))} && cpio -idm --quiet)"
            subprocess.run(["bash", "-lc", cmd], check=False)
            return out
        # 7-Zip handles DMG and most NSIS payloads well enough for census purposes.
        run(["7z", "x", "-y", f"-o{out}", str(path)], check=False)
        return out
    except Exception as exc:
        print(f"extract failed for {label}: {exc}", file=sys.stderr)
        return None


def shlex_quote(s: str) -> str:
    import shlex
    return shlex.quote(s)


def inspect_asar(root: Path, label: str) -> dict:
    asars = list(root.rglob("app.asar"))
    result = {
        "artifact": label,
        "asar_count": len(asars),
        "asar_sha256": "",
        "asar_bytes": 0,
        "asar_entries": 0,
        "src_ts": 0,
        "src_tsx": 0,
        "source_maps": 0,
        "package_name": "",
        "package_version": "",
        "package_private": "",
        "package_license": "",
    }
    if not asars:
        return result
    asar = sorted(asars, key=lambda p: p.stat().st_size, reverse=True)[0]
    result["asar_sha256"] = sha256(asar)
    result["asar_bytes"] = asar.stat().st_size
    listing = subprocess.run(["asar", "list", str(asar)], text=True, capture_output=True)
    if listing.returncode == 0:
        entries = [x.strip().lstrip("/") for x in listing.stdout.splitlines() if x.strip()]
        result["asar_entries"] = len(entries)
        result["src_ts"] = sum(x.startswith("src/") and x.endswith(".ts") for x in entries)
        result["src_tsx"] = sum(x.startswith("src/") and x.endswith(".tsx") for x in entries)
        result["source_maps"] = sum(x.endswith(".map") for x in entries)
        (REPORT / f"{label}-app-asar-files.txt").write_text("\n".join(entries) + "\n", encoding="utf-8")
    asar_out = EXTRACT / f"{label}-asar"
    shutil.rmtree(asar_out, ignore_errors=True)
    asar_out.mkdir(parents=True, exist_ok=True)
    subprocess.run(["asar", "extract", str(asar), str(asar_out)], text=True, capture_output=True)
    pkg = asar_out / "package.json"
    if pkg.exists():
        try:
            data = json.loads(pkg.read_text(encoding="utf-8"))
            result["package_name"] = str(data.get("name", ""))
            result["package_version"] = str(data.get("version", ""))
            result["package_private"] = str(data.get("private", ""))
            result["package_license"] = str(data.get("license", ""))
        except Exception:
            pass
    return result


def fetch_playground_assets() -> tuple[list[dict], list[dict]]:
    web = RAW / "web"
    web.mkdir(parents=True, exist_ok=True)
    html_path = web / "playground.html"
    if not curl(PLAYGROUND, html_path):
        return [], []
    html = html_path.read_text(encoding="utf-8", errors="ignore")
    initial = set()
    for value in re.findall(r'''(?:src|href)=["']([^"']+)["']''', html):
        if value.startswith(("data:", "blob:")):
            continue
        initial.add(urllib.parse.urljoin(PLAYGROUND, value))

    queue = list(sorted(initial))
    seen: set[str] = set()
    asset_rows: list[dict] = []
    local_for_url: dict[str, Path] = {}
    max_assets = 250
    while queue and len(seen) < max_assets:
        url = queue.pop(0)
        if url in seen:
            continue
        seen.add(url)
        parsed = urllib.parse.urlparse(url)
        if parsed.netloc != "app.paper.design":
            continue
        name = Path(parsed.path).name or f"asset-{len(seen)}"
        dest = web / f"{len(seen):03d}-{name}"
        if not curl(url, dest, fail=False):
            continue
        local_for_url[url] = dest
        kind = mime(dest)
        row = {
            "url": url,
            "bytes": dest.stat().st_size,
            "sha256": sha256(dest),
            "mime": kind,
        }
        asset_rows.append(row)
        if dest.suffix.lower() in {".js", ".mjs", ".css"} or "javascript" in kind or "text/css" in kind:
            text = dest.read_text(encoding="utf-8", errors="ignore")
            refs = re.findall(r'''["']((?:/)?assets/[^"'?# )]+(?:\?[^"' )]+)?)["']''', text)
            for ref in refs:
                queue.append(urllib.parse.urljoin(url, ref))

    map_rows = []
    for row in asset_rows:
        url = row["url"]
        if not urllib.parse.urlparse(url).path.endswith((".js", ".mjs")):
            continue
        map_url = url.split("?", 1)[0] + ".map"
        dest = web / (Path(urllib.parse.urlparse(map_url).path).name + ".probe")
        ok = curl(map_url, dest, fail=False)
        valid = False
        sources = 0
        if ok:
            try:
                data = json.loads(dest.read_text(encoding="utf-8"))
                valid = data.get("version") == 3 and isinstance(data.get("sources"), list)
                sources = len(data.get("sources", [])) if valid else 0
            except Exception:
                valid = False
        map_rows.append({
            "asset_url": url,
            "map_url": map_url,
            "http_body_bytes": dest.stat().st_size if dest.exists() else 0,
            "valid_source_map": valid,
            "sources": sources,
        })
    return asset_rows, map_rows


def fetch_public_repos() -> list[dict]:
    rows = []
    for repo in PUBLIC_REPOS:
        url = f"https://github.com/paper-design/{repo}/archive/refs/heads/main.tar.gz"
        dest = RAW / f"repo-{repo.replace('.', '_')}.tar.gz"
        if not curl(url, dest):
            rows.append({"repo": repo, "downloaded": False})
            continue
        out = EXTRACT / f"repo-{repo.replace('.', '_')}"
        out.mkdir(parents=True, exist_ok=True)
        run(["tar", "-xzf", str(dest), "-C", str(out)], check=False)
        counts = extension_counts(out)
        licenses = [p.relative_to(out).as_posix() for p in out.rglob("*") if p.is_file() and p.name.lower().startswith(("license", "notice", "copying"))]
        rows.append({
            "repo": repo,
            "downloaded": True,
            "archive_bytes": dest.stat().st_size,
            "archive_sha256": sha256(dest),
            "ts": counts.get(".ts", 0),
            "tsx": counts.get(".tsx", 0),
            "js": counts.get(".js", 0),
            "maps": counts.get(".map", 0),
            "licenses": ";".join(sorted(licenses)[:20]),
        })
    return rows


def main() -> None:
    download_rows = []
    downloaded: dict[str, Path] = {}
    for label, url in DOWNLOADS.items():
        suffix = {
            "desktop-windows-x64": ".exe",
            "desktop-linux-appimage": ".AppImage",
            "desktop-linux-deb": ".deb",
            "desktop-linux-rpm": ".rpm",
            "desktop-macos-arm64": ".dmg",
            "snapshot-crx": ".crx",
        }[label]
        path = RAW / f"{label}{suffix}"
        ok = curl(url, path, fail=False)
        row = {"artifact": label, "url": url, "downloaded": ok, "bytes": 0, "sha256": "", "mime": ""}
        if ok:
            downloaded[label] = path
            row.update({"bytes": path.stat().st_size, "sha256": sha256(path), "mime": mime(path)})
        download_rows.append(row)

    write_tsv(REPORT / "downloads.tsv", download_rows, ["artifact", "url", "downloaded", "bytes", "sha256", "mime"])

    desktop_rows = []
    for label in [x for x in downloaded if x.startswith("desktop-")]:
        root = extract_desktop(label, downloaded[label])
        if root:
            desktop_rows.append(inspect_asar(root, label))
    write_tsv(
        REPORT / "desktop-asar-comparison.tsv",
        desktop_rows,
        ["artifact", "asar_count", "asar_sha256", "asar_bytes", "asar_entries", "src_ts", "src_tsx", "source_maps", "package_name", "package_version", "package_private", "package_license"],
    )

    if "snapshot-crx" in downloaded:
        out = EXTRACT / "snapshot-extension"
        ok, crx_kind = unpack_crx(downloaded["snapshot-crx"], out)
        snapshot = {"unpacked": ok, "crx_kind": crx_kind, "counts": extension_counts(out) if ok else {}}
        manifest = out / "manifest.json"
        if manifest.exists():
            try:
                snapshot["manifest"] = json.loads(manifest.read_text(encoding="utf-8"))
            except Exception as exc:
                snapshot["manifest_error"] = str(exc)
        (REPORT / "snapshot-extension.json").write_text(json.dumps(snapshot, indent=2, sort_keys=True), encoding="utf-8")
        if ok:
            files = recursive_file_rows(out, "snapshot-extension")
            write_tsv(REPORT / "snapshot-files.tsv", files, ["artifact", "path", "bytes", "sha256"])

    assets, maps = fetch_playground_assets()
    write_tsv(REPORT / "public-web-assets.tsv", assets, ["url", "bytes", "sha256", "mime"])
    write_tsv(REPORT / "source-map-probes.tsv", maps, ["asset_url", "map_url", "http_body_bytes", "valid_source_map", "sources"])

    repos = fetch_public_repos()
    repo_fields = ["repo", "downloaded", "archive_bytes", "archive_sha256", "ts", "tsx", "js", "maps", "licenses"]
    normalized = [{k: r.get(k, "") for k in repo_fields} for r in repos]
    write_tsv(REPORT / "public-repos.tsv", normalized, repo_fields)

    summary = {
        "scope": "public/shipped Paper artifacts only; no authentication bypass",
        "raw_content_retained_in_artifact": False,
        "downloads": download_rows,
        "desktop": desktop_rows,
        "snapshot": json.loads((REPORT / "snapshot-extension.json").read_text()) if (REPORT / "snapshot-extension.json").exists() else None,
        "web_asset_count": len(assets),
        "web_js_count": sum(urllib.parse.urlparse(x["url"]).path.endswith((".js", ".mjs")) for x in assets),
        "web_asset_bytes": sum(int(x["bytes"]) for x in assets),
        "valid_source_maps": sum(bool(x["valid_source_map"]) for x in maps),
        "public_repos": repos,
    }
    (REPORT / "summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True), encoding="utf-8")

    md = [
        "# Paper public artifact census",
        "",
        "This report inventories only artifacts shipped publicly by Paper. Raw proprietary artifacts are not uploaded.",
        "",
        f"- Desktop variants downloaded: {sum(bool(x['downloaded']) for x in download_rows if str(x['artifact']).startswith('desktop-'))}/5",
        f"- Desktop app.asar variants inspected: {len(desktop_rows)}",
        f"- Public editor assets discovered: {len(assets)}",
        f"- Public editor JS assets discovered: {summary['web_js_count']}",
        f"- Valid published source maps discovered: {summary['valid_source_maps']}",
        f"- Public Paper repositories downloaded: {sum(bool(x.get('downloaded')) for x in repos)}/{len(PUBLIC_REPOS)}",
        "",
        "See TSV/JSON files in this artifact for hashes, inventories, package metadata, and source-map probes.",
    ]
    (REPORT / "README.md").write_text("\n".join(md) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
