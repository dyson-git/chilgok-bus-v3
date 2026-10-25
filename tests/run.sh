#!/bin/bash
# v3 검사(헤드리스 Edge, node 불필요): bash v3/tests/run.sh
# 결과: "PASS: n  FAIL: m". 실패하면 FAIL 줄과 got/want 가 같이 나오고 종료 코드 1.
EDGE="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
HERE="$(cd "$(dirname "$0")" && pwd)"
PROFILE="$(cygpath -m "${TEMP:-/tmp}")/v3-edge-check"
timeout 90 "$EDGE" --headless=new --disable-gpu --no-first-run --user-data-dir="$PROFILE" \
  --allow-file-access-from-files --virtual-time-budget=5000 \
  --dump-dom "file:///$(cygpath -m "$HERE/check.html")" 2>/dev/null | python -c "
import sys, re, html, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
d = sys.stdin.buffer.read().decode('utf-8', 'replace')
m = re.search(r'<pre id=\"out\">(.*?)</pre>', d, re.S)
L = (html.unescape(m.group(1)) if m else 'NO OUTPUT').splitlines()
print('\n'.join(l for l in L if not l.startswith('PASS'))[:6000])
p, f = sum(1 for l in L if l.startswith('PASS')), sum(1 for l in L if l.startswith('FAIL'))
print('PASS:', p, ' FAIL:', f)
sys.exit(0 if p and not f and m else 1)"
