# 동명 · 학명리 버스 v3

https://dyson-git.github.io/chilgok-bus-v3/

원본 앱(dyson-git/chilgok-bus-eta)을 리뷰한 뒤, 찾은 문제를 고쳐 따로 만든 버전. 원본과 따로 설치할 수 있게 별도 주소로 옮겼다.

- 실시간: 칠곡군·대구 버스정보시스템(중계 Worker `/bis`, `/dgb`). 칠곡 시스템이 안 되면 TAGO(`/all`)로 그 정류장을 대신한다.
- 시간표: `busv3/` - 매시간 GitHub Actions(`timetable.yml`)가 55분 동안 2분마다 버스정보시스템을 받고, Worker KV 의 TAGO 5분 수집을 가져와 `data/` 에 도착·시간표를 만든다. 원본 앱의 PC 수집 기록은 읽기만 한다.
- 검사: `python -m pytest tests -q`, `bash tests/run.sh`(헤드리스 Edge)
