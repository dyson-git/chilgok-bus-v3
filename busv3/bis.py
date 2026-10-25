"""칠곡·대구 버스정보시스템(중계 /bis, /dgb) 기록. TAGO 가 빠뜨리는 버스(예: 10/25 300번)도 시간표에 남기려고 따로 모은다.

정류장·노선 규칙은 v3/stops.js(화면)와 같다 - 바뀌면 둘 다 고친다.
- 동명행: 학명리 건너2 에서 받은 시간 그대로.
- 학명리행: 학명리 정류소 시간에서 몇 분 빼는 건 짐작이라(10/25 9-3: 우체국에 서 있는데 '3분 뒤') 쓰지 않는다.
  정류장 수(실제 값)를 동명 승차 정류장까지로 바꿔, 승차 정류장에 있으면 0분·1정류장 전이면 1분으로 두고 그보다 멀면 FAR(아직 멂).
  기준 승차 정류장을 지난 차는 그다음 동명 정류장(alts) 기준, 동명을 다 지난 차·정류장 수 모르는 차는 뺀다.
  그래서 학명리행 도착 = 버스가 동명 승차 정류장에 닿은 때(2분마다 보므로 몇십 초~2분 오차).
"""
import html
import json
import re
from datetime import datetime
from pathlib import Path

from busv3.records import KST, Snap

RELAY_URL = "https://chilgok-bus-relay.wisdomdy.workers.dev"
FAR = 99.0  # 학명리행: 동명 승차 정류장에서 2정류장 이상 남은 차(시간을 만들지 않고 '아직 멂'으로만)


def _gap(stops, alt=None):
    """gaps[노선] = 학명리 정류소에서 기준 동명 승차 정류장까지 정류장 수, alts = 그다음 동명 정류장(동명교통)."""
    return {"stops": stops, "alts": [alt] if alt else []}


_HAK = {rid: _gap(n, alt=n - 1) for rid, n in {"칠곡330": 8, "칠곡338": 8, "칠곡332": 8, "칠곡337": 12, "30020": 9, "3420": 9,
                                                "34-120": 9, "88520": 9}.items()}
_HAK.update({"3620": _gap(8), "36-120": _gap(8)})
_C3 = {"dgb:4090003001": _gap(8, alt=7), "dgb:4090003011": _gap(8, alt=7), "dgb:4090003014": _gap(8, alt=7), "dgb:4090003015": _gap(8, alt=7)}

STOPS = {
    "2479": {"direction": "dongmyeong", "route_ids": None},
    "2483": {"direction": "hakmyeong", "offset": 10, "gaps": _HAK},
    "2485": {"direction": "hakmyeong", "offset": 3, "gaps": {"9-310": _gap(3)}},
    "dgb:7181001900": {"direction": "dongmyeong", "route_ids": None, "route_nos": {"칠곡3", "급행9-3"}},
    "dgb:3690003070": {"direction": "hakmyeong", "offset": 10, "gaps": _C3, "route_nos": {"칠곡3"}},
    "dgb:3690003090": {"direction": "hakmyeong", "offset": 3, "gaps": {"dgb:1000009300": _gap(3)}, "route_nos": {"급행9-3"}},
}


def _text(fragment):
    s = html.unescape(re.sub(r"<[^>]+>", " ", fragment)).replace("\xa0", " ")
    return re.sub(r"\s+", " ", s).strip()


def parse_chilgok(page):
    """정류장 팝업 HTML -> [{route_id, route_no, stops, minutes}] | None(줄이 없으면 오류 페이지)."""
    rows = []
    for m in re.finditer(r"<tr[^>]*\bid=[\"']([^\"']+)[\"'][^>]*>([\s\S]*?)</tr>", page or ""):
        body = m.group(2)
        th = re.search(r"<th[^>]*>([\s\S]*?)</th>", body)
        if not th:
            continue
        span = re.search(r"<span[^>]*>([\s\S]*?)</span>", th.group(1))
        cells = _text(" ".join(re.findall(r"<td[^>]*>([\s\S]*?)</td>", body)))
        none = not cells or "도착정보가 없습니다" in cells
        away, mins = re.search(r"(\d+)\s*정거장\s*전", cells), re.search(r"(\d+)\s*분\s*후", cells)
        rows.append({"route_id": m.group(1).split("_")[0], "route_no": _text(span.group(1)) if span else "",
                     "stops": None if none or not away else int(away.group(1)),
                     "minutes": None if none else int(mins.group(1)) if mins else (0 if "곧" in cells else None)})
    return rows or None


def parse_daegu(j):
    """대구 도착정보 JSON -> 같은 모양(route_id 앞에 "dgb:") | None. 운행종료는 빼고, 출발예정은 시간 없음."""
    if not isinstance(j, dict) or not isinstance(j.get("header"), dict) or j["header"].get("success") is not True:
        return None
    out = []
    for r in ((j.get("body") or {}).get("list") or []):
        st = re.sub(r"\s+", " ", str(r.get("arrState") or "")).strip()
        if re.search(r"운행\s*종료", st):
            continue
        m = re.search(r"(\d+)\s*분", st)
        try:
            gap = int(r.get("bsGap"))
        except (TypeError, ValueError):
            gap = -1
        out.append({"route_id": "dgb:" + str(r.get("routeId")), "route_no": str(r.get("routeNo") or "").strip(),
                    "stops": gap if gap >= 0 else None,
                    "minutes": None if re.search(r"출발\s*예정", st) else int(m.group(1)) if m else (0 if "곧" in st else None)})
    return out


def _row_minutes(st, r):
    """한 줄 -> 그 방향 승차 정류장 기준 분 | None(뺄 줄)."""
    if st.get("route_nos") and r["route_no"] not in st["route_nos"]:
        return None
    gaps = st.get("gaps")
    if gaps is None:
        return None if r["minutes"] is None else float(r["minutes"])
    gap = gaps.get(r["route_id"])
    if gap is None or r["stops"] is None:
        return None
    board = gap["stops"] if r["stops"] >= gap["stops"] else next((a for a in gap["alts"] if r["stops"] >= a), None)
    if board is None:
        return None
    left = r["stops"] - board
    return float(left) if left <= 1 else FAR


def snaps_from_poll(got, when):
    """{정류장: 파싱한 줄 | None(실패)} -> {방향: Snap}. 실패한 정류장이 있으면 그 방향 complete=False."""
    out = {}
    for sid, st in STOPS.items():
        d = st["direction"]
        snap = out.setdefault(d, Snap(when, {}, True))
        rows = got.get(sid)
        if rows is None:
            snap.complete = False
            continue
        for r in rows:
            mins = _row_minutes(st, r)
            if mins is None:
                continue
            cur = snap.obs.get(r["route_id"])
            if cur is None or mins < cur[1]:
                snap.obs[r["route_id"]] = (r["route_no"], mins)
    return out


def raw_daegu(sid, j, when):
    """대구 응답을 그대로(필요한 칸만) 남긴다 - 받은 예상 시간과 실제 지나간 시각을 나중에 맞춰 보려고(종점 들렀다 오는 차 등)."""
    out = []
    for r in ((j or {}).get("body") or {}).get("list") or []:
        out.append({"t": when.isoformat(timespec="seconds"), "bs": sid[4:], "route": str(r.get("routeId")), "no": r.get("routeNo"),
                    "state": r.get("arrState"), "gap": r.get("bsGap"), "at": r.get("bsNm"), "dir": r.get("moveDir"), "car": r.get("vhcNo2")})
    return out


def fetch_poll(session=None, timeout=15, raw=None, when=None):
    import requests
    s = session or requests
    got = {}
    for sid in STOPS:
        try:
            if sid.startswith("dgb:"):
                r = s.get(RELAY_URL + "/dgb", params={"bs": sid[4:]}, timeout=timeout, headers={"User-Agent": "chilgok-bus-v3"})
                j = r.json() if r.ok else None
                got[sid] = parse_daegu(j)
                if raw is not None and got[sid] is not None:
                    raw.extend(raw_daegu(sid, j, when or datetime.now(KST)))
            else:
                r = s.get(RELAY_URL + "/bis", params={"stop": sid}, timeout=timeout, headers={"User-Agent": "chilgok-bus-v3"})
                got[sid] = parse_chilgok(r.text) if r.ok else None
        except Exception:
            got[sid] = None
    return got


def append_poll(path, snaps):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8", newline="\n") as f:
        for d, s in snaps.items():
            f.write(json.dumps({"dir": d, "t": s.t.isoformat(timespec="seconds"), "obs": {k: [v[0], v[1]] for k, v in s.obs.items()},
                                "complete": s.complete}, ensure_ascii=False) + "\n")


def read_polls(path):
    out = {}
    path = Path(path)
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            j = json.loads(line)
            out.setdefault(j["dir"], []).append(Snap(datetime.fromisoformat(j["t"]).astimezone(KST),
                                                     {k: (v[0], float(v[1])) for k, v in j["obs"].items()}, bool(j["complete"])))
    return out
