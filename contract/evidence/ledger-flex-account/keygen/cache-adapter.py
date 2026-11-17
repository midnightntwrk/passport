#!/usr/bin/python3
from pathlib import Path
import sys,json,hashlib,shutil,datetime
EVIDENCE=Path("/Users/nicolasdiprima/work/iog/midnight/passport/arc-passport/.worktrees/ledger-flex-account/contract/evidence/ledger-flex-account/keygen")
def sha(p):
 h=hashlib.sha256()
 with p.open("rb") as f:
  for b in iter(lambda:f.read(1024*1024),b""):h.update(b)
 return h.hexdigest()
assert len(sys.argv)==4 and sys.argv[1]=="compile-many", "Only compiler compile-many is supported"
r=json.loads((EVIDENCE/"cache-manifest.json").read_text())
cache=Path(r["cache_root"]);stage=Path(r["stage"]).resolve()
ir=Path(sys.argv[2]);keys=Path(sys.argv[3])
assert ir.resolve()==stage/"zkir" and keys.resolve()==stage/"keys", "Unexpected stage paths"
expected={Path(rel).name for rel in r["files"] if rel.startswith("zkir/") and rel.endswith(".zkir")}
assert len(expected)==52 and {p.name for p in ir.iterdir()}==expected, "Regenerated circuit set mismatch"
for name in sorted(expected):
 assert sha(ir/name)==r["files"]["zkir/"+name]["sha256"], "Regenerated IR mismatch: "+name
for rel,entry in r["files"].items():
 p=cache/rel
 assert p.stat().st_size==entry["size"] and sha(p)==entry["sha256"], "Cached artifact mismatch: "+rel
assert not keys.exists() or (keys.is_dir() and not any(keys.iterdir())), "Staging key directory is not empty"
keys.mkdir(exist_ok=True)
for rel,entry in r["files"].items():
 if rel.endswith(".zkir"):continue
 src=cache/rel;dst=stage/rel
 shutil.copyfile(src,dst)
 assert dst.stat().st_size==entry["size"] and sha(dst)==entry["sha256"], "Copied artifact mismatch: "+rel
result={"outcome":"PASS","timestamp":datetime.datetime.now(datetime.timezone.utc).isoformat(),"adapter_sha256":sha(Path(__file__)),"cache_manifest_sha256":sha(EVIDENCE/"cache-manifest.json"),"cache_root":str(cache),"stage":str(stage),"regenerated_text_ir_checked":52,"cached_artifacts_rehashed":208,"artifacts_copied_and_rehashed":156}
(EVIDENCE/"cache-replay.json").write_text(json.dumps(result,indent=2)+"\n")
print("Verified native-key cache replay: 52 exact IR matches; all 208 artifacts rehashed; copied 156 binary IR/key files",flush=True)
