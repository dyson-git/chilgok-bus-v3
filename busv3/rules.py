"""방향별 정류소 등록과 노선 허용 규칙. 원본 collector/config.py(2026-10-24, 사용자 확인 규칙)와 같은 결과를 내도록 옮겼다.
원본 규칙이 바뀌면 여기도 같이 고친다."""

KEEP_HOURS = (6, 22)  # 수집 시간(한국 06:00~22:00)

REGISTRATIONS = {
    # 동명 정류장(행정복지센터·우체국·동명교통)에서 학명리 쪽으로 가는 버스
    "hakmyeong": ["37390:CGB2142", "37050:GMB2142", "22:DGB7181001000",
                  "37390:CGB2141", "37050:GMB2141", "22:DGB3690003750",
                  "37390:CGB4870", "37390:CGB4871", "37050:GMB4871", "37100:GYB369007000",
                  "22:DGB7181007000", "22:DGB3690005830"],
    # 학명리 건너2 에서 동명 쪽으로 가는 버스
    "dongmyeong": ["37390:CGB2479", "37050:GMB2479", "37100:GYB369001900", "22:DGB7181001900"],
}

_ROUTENOS = {"885", "300", "34", "34-1", "36", "36-1", "9-3", "급행9-3"}
_CHILGOK3 = {"DGB4090003001", "DGB4090003011", "DGB4090003014", "DGB4090003015"}
_EXTRA = {"dongmyeong": {"routenos": {"885-1"}, "chilgok3": {"DGB4090003023"}}}
_ALL_ROUTES = {"dongmyeong"}          # 학명리 건너2 에서 잡히는 버스는 전부 동명행(사용자 확인)
_AWAY = {"hakmyeong": {"CGB30010", "CGB3410", "CGB34-110"}}  # 학명리를 지나 동명을 거쳐 멀어지는 방향


def is_allowed(routeid: str, routeno: str, direction: str) -> bool:
    if direction in _ALL_ROUTES:
        return True
    if routeid in _AWAY.get(direction, set()):
        return False
    extra = _EXTRA.get(direction, {})
    if routeno == "칠곡3":
        return routeid in _CHILGOK3 | extra.get("chilgok3", set())
    return routeno in _ROUTENOS | extra.get("routenos", set())


def in_hours(when) -> bool:
    minutes = when.hour * 60 + when.minute
    return KEEP_HOURS[0] * 60 <= minutes <= KEEP_HOURS[1] * 60
