from pathlib import Path
import hashlib,json,datetime,re,os,ctypes,subprocess,shutil,time
BASE=Path('/Users/nicolasdiprima/work/iog/midnight/passport/arc-passport/.worktrees/ledger-flex-account/contract')
EVIDENCE=BASE/'evidence/ledger-flex-account/keygen'
CURRENT=BASE/'contracts/managed/account'
STAGE=Path('/tmp/ledger-flex-account-finalized')
BACKUP=Path('/tmp/ledger-flex-account-before-native-finalization')
def sha(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
 return h.hexdigest()
def stamp():return datetime.datetime.now(datetime.timezone.utc).isoformat()
finalize=json.loads((EVIDENCE/'compiler-finalize.json').read_text());assert finalize['exit_code']==0
replay=json.loads((EVIDENCE/'cache-replay.json').read_text());assert replay['outcome']=='PASS'
receipt=json.loads((EVIDENCE/'cache-manifest.json').read_text())
assert replay['cache_manifest_sha256']==sha(EVIDENCE/'cache-manifest.json')
assert replay['adapter_sha256']==sha(EVIDENCE/'cache-adapter.py')
manifest_path=STAGE/'compiler/contract-manifest.json'
manifest=json.loads(manifest_path.read_text())
assert manifest['compiler-version']=='0.35.0' and manifest['runtime-version']=='0.20.0'
entries={}
def walk(node,prefix=''):
 for name,entry in node.items():
  if not isinstance(entry,dict):continue
  rel=prefix+name
  if entry.get('type')=='directory':walk(entry,rel+'/')
  elif entry.get('type')=='file':
   p=STAGE/rel
   assert p.is_file() and not p.is_symlink(),rel
   assert p.stat().st_size==entry['size'] and sha(p)==entry['hash'],rel
   entries[rel]=entry
for dirname in ['compiler','contract','zkir','keys']:assert manifest[dirname]['type']=='directory'
walk(manifest)
assert len(entries)==212,len(entries)
for rel,entry in receipt['files'].items():
 assert entries[rel]['hash']==entry['sha256'] and entries[rel]['size']==entry['size'],rel
report=json.loads((EVIDENCE/'keygen.json').read_text())
expected={r['circuit']:r['verifier_sha256'] for r in report['results']}
js=(STAGE/'contract/index.js').read_text()
match=re.search(r'export const expectedVk = \{(.*?)\};',js,re.S);assert match
pairs=re.findall(r"'([a-z_0-9]+)': '([a-f0-9]{64})',",match.group(1))
assert len(pairs)==52 and dict(pairs)==expected
assert re.sub(r"'([a-z_0-9]+)': '([a-f0-9]{64})',",'',match.group(1)).strip()==''
assert CURRENT.is_dir() and STAGE.is_dir() and not CURRENT.is_symlink() and not STAGE.is_symlink()
assert CURRENT.stat().st_dev==STAGE.stat().st_dev and not BACKUP.exists()
# macOS SDK sys/stdio.h: RENAME_SWAP=0x00000002. Swap complete directory trees atomically.
libc=ctypes.CDLL('/usr/lib/libSystem.B.dylib',use_errno=True)
rename=libc.renamex_np;rename.argtypes=[ctypes.c_char_p,ctypes.c_char_p,ctypes.c_uint];rename.restype=ctypes.c_int
result=rename(os.fsencode(CURRENT),os.fsencode(STAGE),0x00000002)
if result:raise OSError(ctypes.get_errno(),os.strerror(ctypes.get_errno()))
STAGE.rename(BACKUP)
summary={'outcome':'PASS','timestamp':stamp(),'current':str(CURRENT),'backup':str(BACKUP),'promotion':'macOS renamex_np RENAME_SWAP: atomic whole-directory exchange','checked_manifest_entries':len(entries),'expected_vk_count':len(expected),'compiler_manifest_sha256':sha(CURRENT/'compiler/contract-manifest.json'),'compiled_js_sha256':sha(CURRENT/'contract/index.js'),'cache_replay_sha256':sha(EVIDENCE/'cache-replay.json'),'compiler_finalization_sha256':sha(EVIDENCE/'compiler-finalize.json')}
(EVIDENCE/'finalized-artifacts.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps(summary,indent=2),flush=True)
shutil.copyfile('/tmp/ledger-flex-promote.py',EVIDENCE/'run-promote.py')
log=BASE/'evidence/ledger-flex-account/toolchain-offline.log'
start=time.monotonic()
with log.open('w') as handle:
 test=subprocess.run(['node','--import','tsx','src/tests/toolchain-offline.ts'],cwd=BASE,stdout=handle,stderr=subprocess.STDOUT)
print('toolchain-offline exit',test.returncode,'elapsed',round(time.monotonic()-start,3),flush=True)
print(log.read_text()[-6000:],flush=True)
raise SystemExit(test.returncode)
