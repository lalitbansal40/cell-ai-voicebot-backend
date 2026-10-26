#!/usr/bin/env bash
# Run locally on the staging server after copying backend.env. Nothing is printed
# except completion. Existing compose credentials are preserved on every rerun.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=common.sh
source "${here}/common.sh"
python3 - "${CAV_ROOT}" <<'PY'
import os,pathlib,secrets,urllib.parse,base64
root=pathlib.Path(__import__('sys').argv[1]); env=root/'env'; env.mkdir(mode=0o700,exist_ok=True)
backend=env/'backend.env'
if not backend.is_file(): raise SystemExit('Copy the owner-provided backend.env first')
compose=env/'compose.env'
if not compose.exists():
    compose.write_text('MONGO_PASSWORD='+secrets.token_hex(32)+'\nREDIS_PASSWORD='+secrets.token_hex(32)+'\n')
values=dict(line.split('=',1) for line in compose.read_text().splitlines() if '=' in line and not line.startswith('#'))
if not all(values.get(k) for k in ['MONGO_PASSWORD','REDIS_PASSWORD']): raise SystemExit('compose.env has empty credentials')
replace={'MONGODB_URI':'mongodb://cav:'+urllib.parse.quote(values['MONGO_PASSWORD'],safe='')+'@127.0.0.1:27018/cell_ai_voicebot?replicaSet=rs0&authSource=admin', 'REDIS_URL':'redis://:'+urllib.parse.quote(values['REDIS_PASSWORD'],safe='')+'@127.0.0.1:6380'}
# An external database (MongoDB Atlas) the owner put in backend.env is kept as it is.
current=dict(line.split('=',1) for line in backend.read_text().splitlines() if '=' in line and not line.startswith('#'))
uri=current.get('MONGODB_URI','').strip()
if uri.startswith('mongodb') and '@127.0.0.1:27018/' not in uri: replace.pop('MONGODB_URI')
lines=[]
for line in backend.read_text().splitlines():
    key=line.partition('=')[0]
    if key in replace: lines.append(key+'='+replace.pop(key))
    else: lines.append(line)
lines.extend(k+'='+v for k,v in replace.items()); backend.write_text('\n'.join(lines)+'\n')
keyfile=env/'mongo-keyfile'
if not keyfile.exists(): keyfile.write_text(base64.b64encode(secrets.token_bytes(512)).decode())
for p in [compose,backend,keyfile]: os.chmod(p,0o600)
print('Staging database credentials ready (existing values preserved)')
PY
