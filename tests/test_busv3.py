"""v3 시간표 수집·계산(v3/busv3) 검사: cd v3 && python -m pytest tests -q
원본(collector/)의 리뷰 문제를 고친 별도 구현이다. 원본 파일은 읽기만 한다."""
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from busv3 import rules, records, resolve, store, update  # noqa: E402

KST = timezone(timedelta(hours=9))


def t(h, m, s=0, day=25):
    return datetime(2026, 10, day, h, m, s, tzinfo=KST)


def snap(when, obs, complete=True):
    return records.Snap(when, {rid: (no, eta) for rid, no, eta in obs}, complete)


# ---- 노선 규칙(원본 collector/config.py 와 같은 결과) ----
def test_rules_match_original_allowlist():
    assert rules.is_allowed("CGB30010", "300", "dongmyeong") is True       # 학명리 건너2 는 전부 동명행
    assert rules.is_allowed("CGB30010", "300", "hakmyeong") is False       # 학명리 지나 멀어지는 300
    assert rules.is_allowed("CGB30020", "300", "hakmyeong") is True
    assert rules.is_allowed("DGB4090003014", "칠곡3", "hakmyeong") is True
    assert rules.is_allowed("DGB4090003023", "칠곡3", "hakmyeong") is False
    assert rules.is_allowed("DGB3000527000", "527", "hakmyeong") is False


# ---- 기록 변환 ----
def test_cloud_snapshot_becomes_per_direction_records_with_best_eta_and_completeness():
    s = {"fetched_at": "2026-10-25T01:05:00.120Z", "results": {
        "22:DGB7181001900": {"ok": True, "items": [{"routeid": "DGB1000009300", "routeno": "급행9-3", "arrtime": 300},
                                                   {"routeid": "DGB1000009300", "routeno": "급행9-3", "arrtime": 900}]},
        "37390:CGB2479": {"ok": False, "error": "TAGO 23"},
        "37390:CGB2142": {"ok": True, "items": [{"routeid": "DGB3000527000", "routeno": "527", "arrtime": 60},
                                               {"routeid": "CGB30020", "routeno": "300", "arrtime": 120}]},
    }}
    got = records.from_cloud(s)
    assert got["dongmyeong"].t == t(10, 5)                       # 초 버림(같은 회차 맞추기용)
    assert got["dongmyeong"].obs == {"DGB1000009300": ("급행9-3", 5.0)}
    assert got["dongmyeong"].complete is False                    # 2479 실패 + 나머지 정류소 응답 없음
    assert got["hakmyeong"].obs == {"CGB30020": ("300", 2.0)}     # 527 은 학명리행 아님


def test_cloud_snapshot_outside_hours_is_skipped():
    assert records.from_cloud({"fetched_at": "2026-10-24T13:30:00Z", "results": {}}) == {}   # 22:30 KST


def test_original_local_record_is_refiltered_with_current_rules():
    rec = {"polled_at": "2026-10-24T14:00:04+09:00", "errors": [], "observations": [
        {"routeid": "CGB30010", "routeno": "300", "eta_min": 3.0, "toward": True},   # 예전엔 허용, 지금 규칙은 반대 방향
        {"routeid": "CGB30020", "routeno": "300", "eta_min": 4.0, "toward": True},
        {"routeid": "CGB30020", "routeno": "300", "eta_min": 9.0, "toward": True}]}
    s = records.from_local(rec, "hakmyeong")
    assert s.obs == {"CGB30020": ("300", 4.0)} and s.complete is True and s.t == t(14, 0, day=24)


# ---- 도착 판정(리뷰 문제: 오류 회차 통째로 버림) ----
def test_incomplete_snapshot_keeps_seen_buses_and_does_not_count_missing_as_arrived():
    snaps = [snap(t(10, 0), [("R", "300", 8.0)]),
             snap(t(10, 5), [("R", "300", 3.0)], complete=False),   # 원본은 이 회차를 버려서 마지막 값 8분 -> '잡음'으로 버렸다
             snap(t(10, 10), [])]
    got = resolve.arrivals(snaps)
    assert [(a.when, a.routeno) for a in got] == [(t(10, 8), "300")]


def test_bus_missing_from_an_incomplete_snapshot_stays_open_until_a_complete_one():
    snaps = [snap(t(10, 0), [("R", "300", 2.0)]), snap(t(10, 5), [], complete=False), snap(t(10, 10), [])]
    assert [a.when for a in resolve.arrivals(snaps)] == [t(10, 2)]


def test_far_bus_that_disappears_is_noise_and_repeat_within_6_minutes_is_one_arrival():
    snaps = [snap(t(9, 0), [("F", "885", 12.0)]), snap(t(9, 5), []),
             snap(t(10, 0), [("R", "36", 1.0)]), snap(t(10, 5), []), snap(t(10, 6), [("R", "36", 0.5)]), snap(t(10, 11), [])]
    assert [(a.when, a.routeno) for a in resolve.arrivals(snaps)] == [(t(10, 1), "36")]


def test_long_gap_closes_open_buses():
    snaps = [snap(t(10, 0), [("R", "300", 2.0)]), snap(t(11, 0), [], complete=False)]
    assert [a.when for a in resolve.arrivals(snaps)] == [t(10, 2)]


def test_same_round_from_two_sources_is_one_snapshot_preferring_complete():
    a = snap(t(10, 5, 0), [("R", "300", 3.0)], complete=False)
    b = snap(t(10, 5, 4), [("R", "300", 3.1)], complete=True)
    merged = resolve.merge_rounds([b, a])
    assert len(merged) == 1 and merged[0].complete is True


# ---- 저장(리뷰 문제: PC 켤 때 클라우드 기록 누락) ----
def test_store_fills_missing_rounds_by_time_not_only_after_the_last(tmp_path):
    store.add(tmp_path, "hakmyeong", [snap(t(15, 30), [])])
    added = store.add(tmp_path, "hakmyeong", [snap(t(15, 15), []), snap(t(15, 20), []), snap(t(15, 30), []), snap(t(15, 35), [])])
    assert added == 3
    assert [s.t for s in store.load(tmp_path, "hakmyeong")] == [t(15, 15), t(15, 20), t(15, 30), t(15, 35)]
    assert store.add(tmp_path, "hakmyeong", [snap(t(15, 20), [])]) == 0


def test_hours_to_fetch_goes_back_one_hour_from_last_and_only_collection_hours():
    assert update.hours_to_fetch(t(9, 40), t(11, 5)) == ["2026-10-25T08", "2026-10-25T09", "2026-10-25T10", "2026-10-25T11"]
    first = update.hours_to_fetch(None, t(7, 0))
    assert first[0] == "2026-10-18T07" and "2026-10-18T23" not in first


def test_build_writes_v3_files_only(tmp_path):
    own, orig = tmp_path / "own", tmp_path / "orig"
    store.add(own, "dongmyeong", [snap(t(10, 0), [("R", "885", 2.0)]), snap(t(10, 5), [])])
    (orig / "observations" / "dongmyeong").mkdir(parents=True)
    (orig / "observations" / "dongmyeong" / "2026-10-25.jsonl").write_text(json.dumps(
        {"polled_at": "2026-10-25T12:00:04+09:00", "errors": [], "observations": [{"routeid": "Q", "routeno": "300", "eta_min": 1.0}]})
        + "\n" + json.dumps({"polled_at": "2026-10-25T12:05:04+09:00", "errors": [], "observations": []}) + "\n", encoding="utf-8")
    meta = update.build(own, orig, as_of=t(13, 0).date())
    arr = json.loads((own / "arrivals.json").read_text(encoding="utf-8"))
    assert [(a["arrival_time"][11:16], a["routeno"]) for a in arr["dongmyeong"]["2026-10-25"]] == [("10:02", "885"), ("12:01", "300")]
    stats = json.loads((own / "stats.json").read_text(encoding="utf-8"))
    assert {r["routeno"] for r in stats["dongmyeong"]} == {"885", "300"}
    assert meta["rounds"]["dongmyeong"] == 4
    assert sorted(p.name for p in orig.rglob("*") if p.is_file()) == ["2026-10-25.jsonl"]   # 원본 쪽은 그대로
