#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NAS="$ROOT/nas"
CACHE="$ROOT/.runtime-source"
UPSTREAM_REPO="${UPSTREAM_REPO:-https://github.com/zhangbaio/hongguo.git}"
# 使用完整提交值，避免 Git 服务拒绝按缩写 SHA 拉取。
UPSTREAM_SHA="${UPSTREAM_SHA:-5f8a58d10f48954bc9b6a58c9cd6418bf499feb9}"

python3 - "$CACHE" "$NAS/run" <<'PY'
from pathlib import Path
import shutil, sys
for value in sys.argv[1:]:
    path = Path(value)
    if path.exists():
        shutil.rmtree(path)
PY
git clone --filter=blob:none --no-checkout "$UPSTREAM_REPO" "$CACHE"
git -C "$CACHE" checkout --detach "$UPSTREAM_SHA"
mkdir -p "$NAS/run/sign" "$NAS/run/capture" "$NAS/run/app/web" "$NAS/run/app/downloads"
cp "$CACHE/windows-package-src/sign/unidbg-sign.jar" "$NAS/run/sign/"
cp -R "$CACHE/windows-package-src/capture/fq_oversea" "$NAS/run/capture/"
for file in server.py hongguo.py offline_dl.py apikeys.py safeguards.py downloader.py devicepool.py; do
  cp "$CACHE/$file" "$NAS/run/app/"
done
cp -R "$CACHE/frida" "$NAS/run/app/frida"
cp "$CACHE/web/index.html" "$NAS/run/app/web/index.html" 2>/dev/null || true
cp -R "$NAS/web/." "$NAS/run/app/web/"
python3 - "$CACHE" <<'PY'
from pathlib import Path
import shutil, sys
shutil.rmtree(Path(sys.argv[1]))
PY
printf 'NAS runtime prepared at %s\n' "$NAS/run"
