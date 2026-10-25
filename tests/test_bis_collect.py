"""v3 칠곡·대구 버스정보시스템 기록(v3/busv3/bis.py) 검사. TAGO 가 빠뜨리는 날(예: 10/25 300번)도 시간표에 남기려는 것."""
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from busv3 import bis, records, resolve, store, update  # noqa: E402

KST = timezone(timedelta(hours=9))


def t(h, m, s=0, day=25):
    return datetime(2026, 10, day, h, m, s, tzinfo=KST)


def td(inner):
    return '<td width="15%" style="vertical-align:middle;">' + inner + "</td>"


def tr(rid, no, c1, c2=""):
    return ('<tr id="' + rid + "_" + rid + '"><th width="50%" align=left><p><span>' + no + "</span></p><p> 이름<br><sub>( 기점↔ 종점)<br></sub></p></th>"
            + td(c1) + td(c2) + "</tr>")


NONE = "<font color=#0165fc><b>도착정보가<br>없습니다.</b></font> "


def popup(*rows):
    return "<table summary=검색결과><tbody>" + "".join(rows) + "</tbody></table>"


def test_parse_chilgok_popup():
    rows = bis.parse_chilgok(popup(tr("30010", "300", "<b>32 정거장전</b>", "<b>52 분후 도착예정</b>"),
                                   tr("3410", "34", NONE, NONE), tr("88510", "885", "곧 도착")))
    assert [(r["route_id"], r["route_no"], r["stops"], r["minutes"]) for r in rows] == [
        ("30010", "300", 32, 52), ("3410", "34", None, None), ("88510", "885", None, 0)]
    assert bis.parse_chilgok("<html>500 error</html>") is None       # 줄이 없으면 오류 페이지


def test_parse_daegu_json():
    j = {"header": {"success": True}, "body": {"list": [
        {"routeId": "1000009300", "routeNo": "급행9-3", "arrState": "7분", "bsGap": 4},
        {"routeId": "4090003001", "routeNo": "칠곡3", "arrState": "곧 도착", "bsGap": 1},
        {"routeId": "4090003011", "routeNo": "칠곡3", "arrState": "기점출발예정", "bsGap": -1},
        {"routeId": "4090003014", "routeNo": "칠곡3", "arrState": "운행종료", "bsGap": -1}]}}
    assert [(r["route_id"], r["minutes"], r["stops"]) for r in bis.parse_daegu(j)] == [
        ("dgb:1000009300", 7, 4), ("dgb:4090003001", 0, 1), ("dgb:4090003011", None, None)]
    assert bis.parse_daegu({"header": {"success": False}}) is None


def test_poll_becomes_snaps_with_user_rules():
    got = {
        "2479": bis.parse_chilgok(popup(tr("30010", "300", "<b>3 정거장전</b>", "<b>4 분후</b>"), tr("3410", "34", "<b>2 정거장전</b>", "<b>3 분후</b>"))),
        "2483": bis.parse_chilgok(popup(tr("30020", "300", "<b>11 정거장전</b>", "<b>15 분후</b>"),     # 동명 2정류장 전 -> 15-10 = 5분
                                        tr("3620", "36", "<b>5 정거장전</b>", "<b>6 분후</b>"),        # 동명을 이미 지남 -> 뺀다
                                        tr("30010", "300", "<b>1 정거장전</b>", "<b>1 분후</b>"))),    # 학명리행 규칙에 없는 방향
        "2485": None,                                                                                # 실패
        "dgb:7181001900": bis.parse_daegu({"header": {"success": True}, "body": {"list": [
            {"routeId": "1000009300", "routeNo": "급행9-3", "arrState": "2분", "bsGap": 1},
            {"routeId": "3000527000", "routeNo": "527", "arrState": "1분", "bsGap": 1}]}}),
        "dgb:3690003070": bis.parse_daegu({"header": {"success": True}, "body": {"list": []}}),
        "dgb:3690003090": bis.parse_daegu({"header": {"success": True}, "body": {"list": []}}),
    }
    snaps = bis.snaps_from_poll(got, t(10, 0, 30))
    d, h = snaps["dongmyeong"], snaps["hakmyeong"]
    assert d.obs == {"30010": ("300", 4.0), "3410": ("34", 3.0), "dgb:1000009300": ("급행9-3", 2.0)} and d.complete is True
    assert h.obs == {"30020": ("300", 5.0)} and h.complete is False                 # 2485 실패
    assert d.t == t(10, 0, 30)


def test_scaled_offset_when_past_main_boarding_stop():
    got = {"2483": bis.parse_chilgok(popup(tr("30020", "300", "<b>8 정거장전</b>", "<b>10 분후</b>")))}   # 행정복지센터(9) 지남, 동명교통(8) 앞
    h = bis.snaps_from_poll(got, t(10, 0))["hakmyeong"]
    assert h.obs == {"30020": ("300", 1.0)}                                         # 10 - round(10*8/9)=9


def test_poll_file_roundtrip(tmp_path):
    f = tmp_path / "bis.jsonl"
    s = bis.snaps_from_poll({"2479": bis.parse_chilgok(popup(tr("30010", "300", "<b>1 정거장전</b>", "<b>2 분후</b>")))}, t(10, 0))
    bis.append_poll(f, s)
    bis.append_poll(f, s)
    back = bis.read_polls(f)
    assert len(back["dongmyeong"]) == 2 and back["dongmyeong"][0].obs == {"30010": ("300", 2.0)}


def test_build_adds_bis_only_arrivals_and_skips_ones_tago_already_has(tmp_path):
    own, orig = tmp_path / "own", tmp_path / "orig"
    # TAGO: 300 이 10:02 도착
    store.add(own, "dongmyeong", [records.Snap(t(10, 0), {"CGB30010": ("300", 2.0)}, True), records.Snap(t(10, 5), {}, True)])
    # 칠곡 시스템: 같은 300(10:03) + TAGO 에 없는 34(11:31) + TAGO 가 놓친 오후 300(15:40)
    store.add(own, "dongmyeong", [
        records.Snap(t(10, 0), {"30010": ("300", 3.0)}, True), records.Snap(t(10, 6), {}, True),
        records.Snap(t(11, 28), {"3410": ("34", 3.0)}, True), records.Snap(t(11, 34), {}, True),
        records.Snap(t(15, 36), {"30010": ("300", 4.0)}, True), records.Snap(t(15, 42), {}, True)], kind="bis")
    update.build(own, orig, as_of=t(16, 0).date())
    arr = json.loads((own / "arrivals.json").read_text(encoding="utf-8"))["dongmyeong"]["2026-10-25"]
    assert [(a["arrival_time"][11:16], a["routeno"], a["source"]) for a in arr] == [
        ("10:02", "300", "tago"), ("11:31", "34", "bis"), ("15:40", "300", "bis")]
    stats = json.loads((own / "stats.json").read_text(encoding="utf-8"))["dongmyeong"]
    assert {r["routeno"] for r in stats} == {"300", "34"}


def test_combine_keeps_one_per_route_within_10_minutes():
    a = [resolve.Arrival(t(10, 2), "CGB30010", "300")]
    b = [resolve.Arrival(t(10, 9), "30010", "300"), resolve.Arrival(t(10, 30), "30010", "300")]
    got = update.combine(a, b)
    assert [(x.when, x.source) for x in got] == [(t(10, 2), "tago"), (t(10, 30), "bis")]


def test_negative_after_offset_is_dropped_not_held_at_zero():
    got = {"dgb:3690003070": bis.parse_daegu({"header": {"success": True}, "body": {"list": [
        {"routeId": "4090003001", "routeNo": "칠곡3", "arrState": "3분", "bsGap": 7}]}})}
    assert bis.snaps_from_poll(got, t(10, 0))["hakmyeong"].obs == {}
