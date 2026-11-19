from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from datetime import datetime, timezone
import hashlib, json, os, subprocess, threading, time

base=Path('/Users/nicolasdiprima/work/iog/midnight/passport/arc-passport/.worktrees/ledger-flex-account/contract')
managed=base/'contracts/managed/account'
keys=managed/'keys'
keys.mkdir(exist_ok=True)
out=base/'evidence/ledger-flex-account/keygen'
out.mkdir(parents=True,exist_ok=True)
zkir=Path('/Users/nicolasdiprima/.compact/versions/0.35.0/aarch64-darwin/zkir-v3')
inputs=sorted((managed/'zkir').glob('*.zkir'))
assert len(inputs)==52, len(inputs)
assert not list(keys.glob('*.prover')), 'Refusing to mix existing prover keys with this fresh generation'
assert not list(keys.glob('*.verifier')), 'Refusing to mix existing verifier keys with this fresh generation'
lock=threading.Lock()
started=time.monotonic()
results=[]
env=os.environ.copy(); env['RAYON_NUM_THREADS']='2'
version=subprocess.check_output([str(zkir),'--version'],text=True).strip()
report={'started_at':datetime.now(timezone.utc).isoformat(),'zkir_binary':str(zkir),'zkir_version':version,'workers':2,'rayon_num_threads':2,'expected_circuits':52,'results':results}

def save():
 p=out/'keygen.json'
 t=out/'keygen.json.tmp'
 t.write_text(json.dumps(report,indent=2)+'\n'); t.replace(p)

def emit(message):
 text=datetime.now(timezone.utc).isoformat()+' '+message
 with lock:
  print(text,flush=True)
  with (out/'progress.log').open('a') as f: f.write(text+'\n')

def sha(path):
 h=hashlib.sha256()
 with path.open('rb') as f:
  for chunk in iter(lambda:f.read(1024*1024),b''): h.update(chunk)
 return h.hexdigest()

def generate(ir):
 name=ir.stem
 prover=keys/(name+'.prover.part'); verifier=keys/(name+'.verifier.part')
 begin=time.monotonic(); emit('START '+name)
 with (out/(name+'.log')).open('w') as log:
  done=subprocess.run([str(zkir),'compile',str(ir),str(prover),str(verifier)],stdout=log,stderr=subprocess.STDOUT,env=env,cwd=str(base))
 result={'circuit':name,'source_zkir_sha256':sha(ir),'elapsed_seconds':round(time.monotonic()-begin,3),'exit_code':done.returncode}
 if done.returncode==0 and prover.exists() and verifier.exists() and prover.stat().st_size and verifier.stat().st_size:
  finalp=keys/(name+'.prover'); finalv=keys/(name+'.verifier')
  prover.replace(finalp); verifier.replace(finalv)
  result.update({'outcome':'PASS','prover_bytes':finalp.stat().st_size,'verifier_bytes':finalv.stat().st_size,'prover_sha256':sha(finalp),'verifier_sha256':sha(finalv)})
 else: result['outcome']='FAIL'
 emit(result['outcome']+' '+name+' '+str(result['elapsed_seconds'])+'s')
 with lock:
  results.append(result); results.sort(key=lambda r:r['circuit']); save()
 return result

save()
with ThreadPoolExecutor(max_workers=2) as pool:
 fs=[pool.submit(generate,ir) for ir in inputs]
 for f in as_completed(fs):
  result=f.result()
  if result['outcome']!='PASS':
   for pending in fs: pending.cancel()
   raise SystemExit('Keygen failed: '+result['circuit']+'; see individual log')
report['elapsed_seconds']=round(time.monotonic()-started,3)
report['completed_at']=datetime.now(timezone.utc).isoformat()
report['outcome']='PASS'
save(); emit('COMPLETE 52/52 in '+str(report['elapsed_seconds'])+'s')
