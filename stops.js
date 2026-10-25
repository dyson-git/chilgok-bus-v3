// v3 정류장 설정. bis/routes.json(2026-10-24 22:22 생성, python -m bis.build_routes)의 정류장·노선 규칙을 그대로 옮겼다.
// 바뀌면 그 파일을 다시 만든 뒤 여기 숫자도 같이 고친다(사용자가 확인한 규칙이라 새로 추론하지 않는다).
// - 동명행: 학명리 건너2 에서 탄다. 거기서 잡히는 버스는 노선과 무관하게 전부 동명행(사용자 확인 "무조건 100%").
// - 학명리행: 학명리 정류소 시간 −10분(사용자 방식), 정류장 수는 노선 정류장 순서로 동명 승차 정류장까지 실제 개수를 뺀다(gaps).
//   9-3 은 학명리 정류소에 안 서서 등골마을입구 시간 −3분.
// - 칠곡3·급행9-3 은 대구 시스템 버스라 칠곡 버스정보시스템에 실시간이 없어 대구 버스정보시스템("dgb:<bsId>")에서 받는다.
window.V3_STOPS = {
  stops: {
    "2479": { direction: "dongmyeong", name: "학명리 건너2", source: "chilgok", route_ids: null },
    "2483": {
      direction: "hakmyeong", name: "학명리", source: "chilgok", offset_min: 10,
      route_ids: ["칠곡330", "칠곡338", "칠곡332", "칠곡337", "30020", "3420", "34-120", "3620", "36-120", "88520"],
      gaps: {
        "칠곡330": { stops: 8, board: "동명면행정복지센터", alts: [{ stops: 7, board: "동명교통" }] },
        "칠곡338": { stops: 8, board: "동명면행정복지센터", alts: [{ stops: 7, board: "동명교통" }] },
        "칠곡332": { stops: 8, board: "동명면행정복지센터", alts: [{ stops: 7, board: "동명교통" }] },
        "칠곡337": { stops: 12, board: "동명면행정복지센터", alts: [{ stops: 11, board: "동명교통" }] },
        "30020": { stops: 9, board: "동명면행정복지센터", alts: [{ stops: 8, board: "동명교통" }] },
        "3420": { stops: 9, board: "동명면행정복지센터", alts: [{ stops: 8, board: "동명교통" }] },
        "34-120": { stops: 9, board: "동명면행정복지센터", alts: [{ stops: 8, board: "동명교통" }] },
        "3620": { stops: 8, board: "동명교통", alts: [] },
        "36-120": { stops: 8, board: "동명교통", alts: [] },
        "88520": { stops: 9, board: "동명면행정복지센터", alts: [{ stops: 8, board: "동명교통" }] }
      }
    },
    "2485": {
      direction: "hakmyeong", name: "학명리(등골마을입구)", source: "chilgok", offset_min: 3,
      route_ids: ["9-310"],
      gaps: { "9-310": { stops: 3, board: "동명면우체국", alts: [] } }
    },
    "dgb:7181001900": { direction: "dongmyeong", name: "학명리 건너2", source: "daegu", route_ids: null, route_nos: ["칠곡3", "급행9-3"] },
    "dgb:3690003070": {
      direction: "hakmyeong", name: "학명리", source: "daegu", offset_min: 10,
      route_nos: ["칠곡3"],
      route_ids: ["dgb:4090003001", "dgb:4090003011", "dgb:4090003014", "dgb:4090003015"],
      gaps: {
        "dgb:4090003001": { stops: 8, board: "동명면행정복지센터", alts: [{ stops: 7, board: "동명교통" }] },
        "dgb:4090003011": { stops: 8, board: "동명면행정복지센터", alts: [{ stops: 7, board: "동명교통" }] },
        "dgb:4090003014": { stops: 8, board: "동명면행정복지센터", alts: [{ stops: 7, board: "동명교통" }] },
        "dgb:4090003015": { stops: 8, board: "동명면행정복지센터", alts: [{ stops: 7, board: "동명교통" }] }
      }
    },
    "dgb:3690003090": {
      direction: "hakmyeong", name: "학명리(등골마을입구)", source: "daegu", offset_min: 3,
      route_nos: ["급행9-3"],
      route_ids: ["dgb:1000009300"],
      gaps: { "dgb:1000009300": { stops: 3, board: "동명면우체국", alts: [] } }
    }
  },
  // 885 는 구미에서 동명 종점까지 왔다가 바로 학명리 방향으로 되돌아간다(사용자 확인). 학명리 건너2 를 동명 쪽으로 지나는 885 를
  // 학명리행 카드에 "종점까지 몇 정류장"으로 보여준다(시간은 학명리 건너2 를 지나는 받은 값 그대로).
  turnaround: [
    { direction: "hakmyeong", station: "2479", route_id: "88510", route_no: "885", extra_stops: 9, terminal: "동명면우체국건너" }
  ],
  // 칠곡 버스정보시스템이 안 될 때(서버 오류 등) 그 정류장 대신 볼 TAGO(국토부) 정류소. 중계 /all 한 번으로 받는다.
  // - 학명리 건너2: 같은 정류장의 TAGO 등록(칠곡군·구미시). 값 그대로.
  // - 학명리행: TAGO 에는 학명리 정류소가 없어(중계 허용 목록) 동명 승차 정류장 값을 그대로 쓴다(빼기 없음). 노선은 그 정류장 규칙(route_ids)만.
  // 대구 버스(칠곡3·급행9-3)는 대구 버스정보시스템에서 따로 받으니 여기선 뺀다.
  tago: {
    names: {
      "37390:CGB2142": "동명면행정복지센터", "37050:GMB2142": "동명면행정복지센터",
      "37390:CGB2141": "동명면우체국", "37050:GMB2141": "동명면우체국",
      "37390:CGB4870": "동명교통", "37390:CGB4871": "동명교통", "37050:GMB4871": "동명교통"
    },
    stations: {
      "2479": { nodes: ["37390:CGB2479", "37050:GMB2479"], same_stop: true },
      "2483": { nodes: ["37390:CGB2142", "37050:GMB2142", "37390:CGB2141", "37050:GMB2141", "37390:CGB4870", "37390:CGB4871", "37050:GMB4871"] },
      "2485": { nodes: ["37390:CGB2142", "37050:GMB2142", "37390:CGB2141", "37050:GMB2141", "37390:CGB4870", "37390:CGB4871", "37050:GMB4871"] }
    }
  },
  // 칠곡3 변형(대구 노선 id) - collector/config.py 주석의 경로
  labels: {
    "dgb:4090003001": "예술대·경운대 경유",
    "dgb:4090003011": "경운대 경유",
    "dgb:4090003014": "경운대·예술대 경유",
    "dgb:4090003015": "하판 경유",
    "dgb:4090003023": "하판·기성 경유"
  }
};
