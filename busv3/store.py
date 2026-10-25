"""v3 자체 기록: <data>/<kind>/<방향>/<날짜>.jsonl (kind: obs = TAGO 클라우드, bis = 칠곡·대구 버스정보시스템), 한 줄 = {"t", "obs": {노선id: [번호, 분]}, "complete"}.
같은 시각(분 단위)이 이미 있으면 건너뛰고, 없으면 시각 순서와 상관없이 채운다(원본처럼 '마지막 기록 뒤만' 붙이지 않는다).
파일은 날짜마다 시각순으로 다시 쓴다."""
import json
from datetime import datetime
from pathlib import Path

from busv3.records import Snap


def _key(t):
    return t.strftime("%Y-%m-%dT%H:%M")


def _path(data_dir, direction, day, kind="obs"):
    return Path(data_dir) / kind / direction / f"{day}.jsonl"


def _read(path):
    if not path.exists():
        return []
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            j = json.loads(line)
            out.append(Snap(datetime.fromisoformat(j["t"]), {k: (v[0], float(v[1])) for k, v in j["obs"].items()}, bool(j["complete"])))
    return out


def load(data_dir, direction, kind="obs"):
    snaps = []
    for path in sorted((Path(data_dir) / kind / direction).glob("*.jsonl")):
        snaps += _read(path)
    return sorted(snaps, key=lambda s: s.t)


def add(data_dir, direction, snaps, kind="obs") -> int:
    by_day = {}
    for s in snaps:
        by_day.setdefault(s.t.date().isoformat(), []).append(s)
    added = 0
    for day, new in by_day.items():
        path = _path(data_dir, direction, day, kind)
        cur = {_key(s.t): s for s in _read(path)}
        for s in new:
            if _key(s.t) not in cur:
                cur[_key(s.t)] = s
                added += 1
        path.parent.mkdir(parents=True, exist_ok=True)
        lines = [json.dumps({"t": s.t.isoformat(timespec="seconds"), "obs": {k: [v[0], round(v[1], 2)] for k, v in sorted(s.obs.items())},
                             "complete": s.complete}, ensure_ascii=False) for s in sorted(cur.values(), key=lambda s: s.t)]
        path.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    return added


def last_time(data_dir):
    last = None
    for direction_dir in (Path(data_dir) / "obs").glob("*"):
        files = sorted(direction_dir.glob("*.jsonl"))
        if files:
            snaps = _read(files[-1])
            if snaps and (last is None or snaps[-1].t > last):
                last = snaps[-1].t
    return last
