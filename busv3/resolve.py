"""회차들 -> 실제 통과(도착) 판정.

원본(collector/rebuild.py)은 정류소 하나라도 오류가 난 회차를 통째로 버렸다. 그러면 버스가 가까이 보인 회차가 빠져
마지막 값이 먼 시간으로 남아 '잡음'으로 버려지는 일이 생긴다. 여기서는
- 불완전한 회차도 '보인 버스'는 반영하고, '안 보인 버스'를 지나갔다고 판정하는 것만 다음 완전한 회차로 미룬다.
- 기록이 20분 넘게 끊기면(수집 중단) 열린 버스를 그 자리에서 닫는다.
- 같은 노선이 6분 안에 두 번 판정되면 한 번으로 친다(지나간 뒤 같은 값을 잠깐 다시 주는 경우).
"""
from dataclasses import dataclass
from datetime import datetime, timedelta

NEAR_MIN = 5.0                     # 마지막으로 보인 남은 시간이 이 안이면 도착, 아니면 멀리서 사라진 잡음
GAP = timedelta(minutes=20)
REPEAT = timedelta(minutes=6)
SAME_ROUND = timedelta(seconds=90)  # PC 기록과 클라우드 기록이 같은 회차면 하나만 쓴다


@dataclass
class Arrival:
    when: datetime
    routeid: str
    routeno: str
    source: str = "tago"


def merge_rounds(snaps):
    """시각순 정렬 + 90초 안의 같은 회차는 하나로(완전한 쪽, 같으면 먼저 것)."""
    out = []
    for s in sorted(snaps, key=lambda s: s.t):
        if out and s.t - out[-1].t <= SAME_ROUND:
            if s.complete and not out[-1].complete:
                out[-1] = s
            continue
        out.append(s)
    return out


def arrivals(snaps):
    open_, found, last_t = {}, [], None

    def close(rid):
        seen, eta, no = open_.pop(rid)
        if eta <= NEAR_MIN:
            found.append(Arrival(seen + timedelta(minutes=eta), rid, no))

    for s in merge_rounds(snaps):
        if last_t is not None and s.t - last_t > GAP:
            for rid in list(open_):
                close(rid)
        for rid in list(open_):
            if rid not in s.obs and s.complete:
                close(rid)
        for rid, (no, eta) in s.obs.items():
            open_[rid] = (s.t, eta, no)
        last_t = s.t

    found.sort(key=lambda a: a.when)
    kept = []
    for a in found:
        if any(k.routeid == a.routeid and a.when - k.when <= REPEAT for k in kept):
            continue
        kept.append(a)
    return kept
