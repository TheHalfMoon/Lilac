#!/usr/bin/env python3
"""Historical Paper Desktop archaeology, tolerant of 7-Zip HFS symlink warnings.

Public DMGs are processed ephemerally. Only provenance, file paths, hashes, sizes,
and cross-version lineage are retained; proprietary source text is not uploaded.
"""
from __future__ import annotations

import csv, hashlib, json, shutil, subprocess, urllib.parse
from collections import defaultdict
from pathlib import Path

ROOT=Path("paper-history"); RAW=ROOT/"raw"; EXT=ROOT/"extract"; REPORT=ROOT/"report"
for p in (RAW,EXT,REPORT): p.mkdir(parents=True,exist_ok=True)
APP="2601167vjw8xe"
BUILDS=[
("0.1.10","26031739o5exfj4"),("0.1.12","2604116ylbmu5uc"),("0.1.14","260513c3lncpex8"),
("0.2.0","2605227oebjghyb"),("0.3.2","260529m17bb6bkl"),("0.4.4","260706m7lwa680d"),
("0.5.0","260718w0gs8apen"),("0.5.7","260904829lm19ta"),("0.5.14","260930cd6gd2j72")]

def cmd(a):
 print("+"," ".join(a),flush=True); return subprocess.run(a,text=True,capture_output=True)
def sha(p):
 h=hashlib.sha256()
 with p.open("rb") as f:
  for b in iter(lambda:f.read(1024*1024),b""): h.update(b)
 return h.hexdigest()
def get(url,dst):
 r=cmd(["curl","-fL","--retry","3","--retry-all-errors","--connect-timeout","20","--max-time","300","-A","Paper-Lilac-History/2.0","-o",str(dst),"-sS",url])
 return r.returncode==0 and dst.exists() and dst.stat().st_size>0
def tsv(path,rows,fields):
 with path.open("w",encoding="utf-8",newline="") as f:
  w=csv.DictWriter(f,fieldnames=fields,delimiter="\t"); w.writeheader(); w.writerows(rows)
def url(v,b): return f"https://download.todesktop.com/{APP}/"+urllib.parse.quote(f"Paper {v} - Build {b}-arm64.dmg")
def unpack(dmg,out):
 shutil.rmtree(out,ignore_errors=True); out.mkdir(parents=True,exist_ok=True)
 r=cmd(["7z","x","-y",f"-o{out}",str(dmg)])
 # 7-Zip returns warning status for the intentional /Applications symlink even
 # when the HFS payload and Paper.app were successfully extracted.
 return any(out.iterdir()), r.returncode, (r.stderr+r.stdout)[-2000:]
def find_asar(root):
 c=[p for p in root.rglob("app.asar") if p.is_file()]; return max(c,key=lambda p:p.stat().st_size) if c else None
def asar_list(p):
 r=cmd(["asar","list",str(p)]); return [x.strip().lstrip("/") for x in r.stdout.splitlines() if x.strip()] if r.returncode==0 else []
def asar_extract(p,out):
 shutil.rmtree(out,ignore_errors=True); out.mkdir(parents=True,exist_ok=True); return cmd(["asar","extract",str(p),str(out)]).returncode==0

def main():
 builds=[]; sources=[]; entrysets={}; diagnostics=[]
 for v,b in BUILDS:
  label=f"paper-{v}-{b}"; u=url(v,b); dmg=RAW/f"{label}.dmg"
  row={"version":v,"build_id":b,"url":u,"downloaded":False,"dmg_bytes":0,"dmg_sha256":"","extract_rc":"","asar_bytes":0,"asar_sha256":"","asar_entries":0,"src_files":0,"src_ts":0,"src_tsx":0,"source_maps":0,"package_name":"","package_version":"","license":""}
  if not get(u,dmg): builds.append(row); continue
  row.update(downloaded=True,dmg_bytes=dmg.stat().st_size,dmg_sha256=sha(dmg))
  out=EXT/label; ok,rc,tail=unpack(dmg,out); row["extract_rc"]=rc
  if not ok:
   diagnostics.append({"version":v,"status":"extract-empty","detail":tail.replace("\n"," ")}); builds.append(row); dmg.unlink(missing_ok=True); continue
  a=find_asar(out)
  if not a:
   top=sorted(p.relative_to(out).as_posix() for p in out.rglob("*") if p.is_file())[:80]
   diagnostics.append({"version":v,"status":"asar-not-found","detail":";".join(top)})
   builds.append(row); shutil.rmtree(out,ignore_errors=True); dmg.unlink(missing_ok=True); continue
  entries=asar_list(a); entrysets[v]=set(entries)
  row.update(asar_bytes=a.stat().st_size,asar_sha256=sha(a),asar_entries=len(entries),source_maps=sum(x.endswith(".map") for x in entries))
  ao=EXT/f"{label}-asar"
  if asar_extract(a,ao):
   pkg={}
   try: pkg=json.loads((ao/"package.json").read_text(encoding="utf-8"))
   except Exception: pass
   row.update(package_name=str(pkg.get("name","")),package_version=str(pkg.get("version","")),license=str(pkg.get("license","")))
   src=ao/"src"
   if src.exists():
    files=sorted(p for p in src.rglob("*") if p.is_file()); row["src_files"]=len(files); row["src_ts"]=sum(p.suffix==".ts" for p in files); row["src_tsx"]=sum(p.suffix==".tsx" for p in files)
    for p in files: sources.append({"version":v,"build_id":b,"path":p.relative_to(ao).as_posix(),"bytes":p.stat().st_size,"sha256":sha(p)})
  builds.append(row); shutil.rmtree(ao,ignore_errors=True); shutil.rmtree(out,ignore_errors=True); dmg.unlink(missing_ok=True)

 bf=["version","build_id","url","downloaded","dmg_bytes","dmg_sha256","extract_rc","asar_bytes","asar_sha256","asar_entries","src_files","src_ts","src_tsx","source_maps","package_name","package_version","license"]
 tsv(REPORT/"historical-builds.tsv",builds,bf); tsv(REPORT/"historical-src-lineage.tsv",sources,["version","build_id","path","bytes","sha256"]); tsv(REPORT/"diagnostics.tsv",diagnostics,["version","status","detail"])
 by=defaultdict(list)
 for r in sources: by[r["path"]].append(r)
 order={v:i for i,(v,_) in enumerate(BUILDS)}; summaryrows=[]
 for path,rs in sorted(by.items()):
  rs.sort(key=lambda r:order[r["version"]]); vs=[r["version"] for r in rs]; hs={r["sha256"] for r in rs}
  summaryrows.append({"path":path,"first_seen":vs[0],"last_seen":vs[-1],"versions_seen":len(set(vs)),"distinct_content_hashes":len(hs),"latest_bytes":rs[-1]["bytes"],"latest_sha256":rs[-1]["sha256"]})
 tsv(REPORT/"historical-src-summary.tsv",summaryrows,["path","first_seen","last_seen","versions_seen","distinct_content_hashes","latest_bytes","latest_sha256"])
 deltas=[]; av=[v for v,_ in BUILDS if v in entrysets]
 for x,y in zip(av,av[1:]):
  a,c=entrysets[x],entrysets[y]; deltas.append({"from":x,"to":y,"added_entries":len(c-a),"removed_entries":len(a-c),"added_src":len([p for p in c-a if p.startswith("src/")]),"removed_src":len([p for p in a-c if p.startswith("src/")])})
 tsv(REPORT/"historical-entry-deltas.tsv",deltas,["from","to","added_entries","removed_entries","added_src","removed_src"])
 latest=BUILDS[-1][0]
 s={"scope":"historical public ToDesktop Paper Desktop artifacts; metadata/source hashes only","raw_proprietary_source_retained":False,"requested_builds":len(BUILDS),"downloaded_builds":sum(bool(r["downloaded"]) for r in builds),"builds_with_asar":sum(int(r["asar_entries"])>0 for r in builds),"builds_with_src":sum(int(r["src_files"])>0 for r in builds),"unique_src_paths":len(summaryrows),"historically_changed_src_paths":sum(int(r["distinct_content_hashes"])>1 for r in summaryrows),"historical_only_src_paths":sum(r["last_seen"]!=latest for r in summaryrows),"builds":builds,"deltas":deltas}
 (REPORT/"summary.json").write_text(json.dumps(s,indent=2,sort_keys=True),encoding="utf-8")
 (REPORT/"README.md").write_text(f"# Paper Desktop historical archaeology\n\n- Downloaded: {s['downloaded_builds']}/{s['requested_builds']}\n- ASAR recovered: {s['builds_with_asar']}\n- Builds with shipped src/: {s['builds_with_src']}\n- Unique historical src paths: {s['unique_src_paths']}\n- Changed src paths: {s['historically_changed_src_paths']}\n- Historical-only src paths: {s['historical_only_src_paths']}\n",encoding="utf-8")
if __name__=="__main__": main()
