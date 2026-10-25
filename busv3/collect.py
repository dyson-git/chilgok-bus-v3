"""칠곡·대구 버스정보시스템 받기: python -m busv3.collect <파일> [분=55] [간격초=120]
정해진 시간 동안 간격마다 6개 정류장을 받아 <파일>(저장소 밖 임시 파일)에 덧붙인다. 수집 시간(06~22시) 밖이면 받지 않는다.
GitHub Actions(.github/workflows/v3-timetable.yml)가 매시간 돌리고, 끝나면 python -m busv3.update --bis <파일> 로 기록·시간표를 만든다."""
import sys
import time
from datetime import datetime

import requests

from busv3 import bis, rules
from busv3.records import KST


def main() -> int:
    out = sys.argv[1]
    minutes = float(sys.argv[2]) if len(sys.argv) > 2 else 55
    every = float(sys.argv[3]) if len(sys.argv) > 3 else 120
    end, n, session = time.time() + minutes * 60, 0, requests.Session()
    while True:
        now = datetime.now(KST)
        if rules.in_hours(now):
            snaps = bis.snaps_from_poll(bis.fetch_poll(session), now)
            bis.append_poll(out, snaps)
            n += 1
            print(now.strftime("%H:%M:%S"), {d: (len(s.obs), s.complete) for d, s in snaps.items()}, flush=True)
        if time.time() + every > end:
            break
        time.sleep(every)
    print(f"{n}회 받음")
    return 0


if __name__ == "__main__":
    sys.exit(main())
