"""v3 시간표 갱신: python -m busv3.update  (v3 폴더에서, GitHub Actions .github/workflows/v3-timetable.yml 이 1시간마다 실행)

1. Worker KV 의 5분 수집 스냅숏(/obs, 읽기만)을 가져와 v3/data/obs 에 시각 기준으로 채운다(빠진 회차만).
2. v3 기록 + 원본 앱(dyson-git/chilgok-bus-eta) PC 수집 기록(orig/data/observations - 작업이 원본 저장소에서 그 폴더만 받아 둔다, 읽기만)을 합쳐 같은 회차는 하나로, 도착을 판정한다.
   칠곡·대구 버스정보시스템 기록(v3/data/bis, busv3.collect)은 따로 판정해 TAGO 에 없는 도착만 더한다(같은 번호 10분 안이면 하나).
3. v3/data/arrivals.json, stats.json, meta.json 을 쓴다. 원본 data/ 는 건드리지 않는다.
"""
import json
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

import requests

from busv3 import records, resolve, rules, store
from busv3.records import KST

RELAY_URL = "https://chilgok-bus-relay.wisdomdy.workers.dev"
KEEP_DAYS = 7          # Worker KV 보관 기간
WINDOW_DAYS = 30       # 시간표에 쓰는 최근 기간
SAME_BUS = timedelta(minutes=10)  # TAGO·버스정보시스템이 같은 버스를 각각 판정하면 시각이 몇 분 다를 수 있다
SPREAD_MIN = 30        # 시간표 한 줄 = 날짜가 달라도 30분 안의 같은 노선(사용자 지시 "비슷한 시간대끼리")
V3_DIR = Path(__file__).resolve().parents[1]


def hours_to_fetch(last, now):
    """마지막 클라우드 기록 한 시간 전부터 지금까지(처음이면 7일 전부터), 수집 시간(06~22시)만. 늦게 쓰인 회차도 다시 확인한다."""
    start = now - timedelta(days=KEEP_DAYS)
    if last is not None and last - timedelta(hours=1) > start:
        start = last - timedelta(hours=1)
    h, out = start.replace(minute=0, second=0, microsecond=0), []
    while h <= now:
        if rules.KEEP_HOURS[0] <= h.hour <= rules.KEEP_HOURS[1]:
            out.append(h.strftime("%Y-%m-%dT%H"))
        h += timedelta(hours=1)
    return out


def fetch_cloud(hours):
    snaps = []
    for hour in hours:
        r = requests.get(RELAY_URL + "/obs", params={"hour": hour}, timeout=30, headers={"User-Agent": "chilgok-bus-v3"})
        r.raise_for_status()
        snaps += r.json()
    return snaps


def load_original(orig_dir, direction):
    out = []
    for path in sorted((Path(orig_dir) / "observations" / direction).glob("*.jsonl")):
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                try:
                    out.append(records.from_local(json.loads(line), direction))
                except (KeyError, ValueError):
                    continue
    return out


def combine(tago, other):
    """TAGO 도착 + 버스정보시스템 도착 중 TAGO 에 없는 것(같은 노선 번호 10분 안이면 같은 버스)."""
    out = list(tago)
    for a in other:
        if not any(x.routeno == a.routeno and abs(x.when - a.when) <= SAME_BUS for x in out):
            a.source = "bis"
            out.append(a)
    return sorted(out, key=lambda a: a.when)


def _m(t):
    return t.hour * 60 + t.minute


def compute_stats(by_date, as_of):
    """노선 번호별로, 날짜가 달라도 30분 안의 도착끼리 한 줄(같은 날 두 대는 다른 줄). 원본 collector/stats.py 와 같은 묶기."""
    cutoff = as_of - timedelta(days=WINDOW_DAYS)
    per_route = defaultdict(list)
    for d, items in by_date.items():
        if d > cutoff:
            for a in items:
                per_route[a.routeno].append((a.when.time().replace(second=0, microsecond=0), d))
    rows = []
    for routeno, items in per_route.items():
        groups = []
        for tm, d in sorted(items):
            g = groups[-1] if groups else None
            if g and _m(tm) - _m(g[0][0]) <= SPREAD_MIN and d not in {x[1] for x in g}:
                g.append((tm, d))
            else:
                groups.append([(tm, d)])
        for i, g in enumerate(groups, 1):
            times = [x[0] for x in g]
            avg = round(sum(_m(x) for x in times) / len(times))
            rows.append({"routeno": routeno, "slot_index": i, "min_time": min(times).strftime("%H:%M"),
                         "max_time": max(times).strftime("%H:%M"), "avg_time": f"{avg // 60:02d}:{avg % 60:02d}",
                         "sample_count": len({x[1] for x in g})})
    rows.sort(key=lambda r: (r["avg_time"], r["routeno"], r["slot_index"]))
    return rows


def build(own_dir, orig_dir, as_of: date):
    own_dir = Path(own_dir)
    arrivals, stats, meta = {}, {}, {"built_at": datetime.now(KST).isoformat(timespec="seconds"), "rounds": {}, "arrivals": {}}
    for direction in rules.REGISTRATIONS:
        rounds = resolve.merge_rounds(store.load(own_dir, direction) + load_original(orig_dir, direction))
        found = combine(resolve.arrivals(rounds), resolve.arrivals(store.load(own_dir, direction, "bis")))
        by_date = defaultdict(list)
        for a in found:
            by_date[a.when.date()].append(a)
        arrivals[direction] = {d.isoformat(): [{"arrival_time": a.when.isoformat(timespec="seconds"), "routeid": a.routeid, "routeno": a.routeno,
                                                "source": a.source}
                                               for a in items] for d, items in sorted(by_date.items())}
        stats[direction] = compute_stats(by_date, as_of)
        meta["rounds"][direction] = len(rounds)
        meta["arrivals"][direction] = len(found)
    for name, obj in (("arrivals.json", arrivals), ("stats.json", stats), ("meta.json", meta)):
        (own_dir / name).write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8", newline="\n")
    return meta


def main() -> int:
    own, orig = V3_DIR / "data", V3_DIR / "orig" / "data"
    now = datetime.now(KST)
    # busv3.collect 가 받아 둔 버스정보시스템 기록(--bis 파일, 저장소 밖 임시 파일)을 먼저 채운다
    if "--bis" in sys.argv:
        from busv3 import bis
        polls = bis.read_polls(sys.argv[sys.argv.index("--bis") + 1])
        print("버스정보시스템 새 회차", sum(store.add(own, d, snaps, kind="bis") for d, snaps in polls.items()))
    hours = hours_to_fetch(store.last_time(own), now)
    added = {}
    for snap in fetch_cloud(hours):
        for direction, s in records.from_cloud(snap).items():
            added.setdefault(direction, []).append(s)
    n = sum(store.add(own, d, snaps) for d, snaps in added.items())
    meta = build(own, orig, now.date())
    print(f"{len(hours)}시간 확인, 새 회차 {n}개, 회차 {meta['rounds']}, 도착 {meta['arrivals']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
