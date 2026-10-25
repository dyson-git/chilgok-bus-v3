"""수집 한 회차 = Snap(시각, {노선id: (번호, 남은 분)}, complete). complete=False 면 그 방향 정류소 중 못 받은 곳이 있다
(그때 안 보인 버스는 '지나갔다'고 판단하면 안 된다)."""
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from busv3 import rules

KST = timezone(timedelta(hours=9))


@dataclass
class Snap:
    t: datetime
    obs: dict
    complete: bool


def _best(pairs, direction):
    best = {}
    for rid, no, eta in pairs:
        if not rules.is_allowed(rid, no, direction):
            continue
        if rid not in best or eta < best[rid][1]:
            best[rid] = (no, eta)
    return best


def from_cloud(snapshot) -> dict:
    """Worker KV 스냅숏({fetched_at, results:{"도시:정류소": {ok, items|error}}}) -> {방향: Snap}. 수집 시간 밖이면 {}."""
    when = datetime.fromisoformat(snapshot["fetched_at"].replace("Z", "+00:00")).astimezone(KST).replace(second=0, microsecond=0)
    if not rules.in_hours(when):
        return {}
    results = snapshot.get("results") or {}
    out = {}
    for direction, regs in rules.REGISTRATIONS.items():
        pairs, complete = [], True
        for reg in regs:
            r = results.get(reg)
            if not r or not r.get("ok"):
                complete = False
                continue
            for i in r.get("items") or []:
                try:
                    pairs.append((str(i["routeid"]), str(i["routeno"]), float(i["arrtime"]) / 60))
                except (KeyError, TypeError, ValueError):
                    continue  # 시간 없는 줄 하나 때문에 회차 전체를 버리지 않는다
        out[direction] = Snap(when, _best(pairs, direction), complete)
    return out


def from_local(record, direction) -> Snap:
    """원본 PC 수집 기록 한 줄(data/observations/<방향>/<날짜>.jsonl) -> Snap. 지금 규칙으로 다시 거른다."""
    when = datetime.fromisoformat(record["polled_at"])
    when = when.replace(tzinfo=KST) if when.tzinfo is None else when.astimezone(KST)
    when = when.replace(second=0, microsecond=0)
    pairs = []
    for o in record.get("observations") or []:
        try:
            pairs.append((str(o["routeid"]), str(o["routeno"]), float(o["eta_min"])))
        except (KeyError, TypeError, ValueError):
            continue
    return Snap(when, _best(pairs, direction), not record.get("errors"))
