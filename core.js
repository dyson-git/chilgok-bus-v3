// v3 핵심 규칙(순수 함수, 네트워크·화면 없음). 화면 연결은 app.js, 검사는 tests/check.html(bash v3/tests/run.sh).
//
// 시간 규칙(사용자 지시): 받은 시간에서 초 단위로 줄이고, 못 받아도 (받은 시간 - 지난 시간)으로 계속 줄이고(사라지지 않게),
// 새 값이 오면 그 값으로 갱신한다. "몇 정류장 전"은 시간이 있어도 없어도 항상 보인다. 예측을 만들어 내지 않는다.
// 두 버스정보시스템 모두 "N분" 단위라 같은 값이 여러 번 온다. 그래서
//   - 화면의 남은 시간이 받은 값과 1분 안쪽이면 그대로 줄인다(30초마다 받을 때 숫자가 되감기며 튀지 않게),
//   - 1분 넘게 벌어지면 받은 값으로 다시 맞춘다(차가 서 있어 같은 값이 계속 올 때 화면이 몇 분씩 앞서 가지 않게).
// 그래서 화면은 언제나 마지막으로 받은 값과 1분 안쪽이다.
(function (root) {
  "use strict";

  var HOLD_MS = 180000;        // 도착 시각이 지나도 새 정보가 없으면 이 시간까지 "곧 도착"으로 남긴다
  var SNAP_MS = 60000;         // 받은 값과 화면 남은 시간이 이보다 덜 벌어졌으면 화면 카운트다운을 그대로 둔다
  var FRESH_MS = 75000;        // 정류장 응답이 이보다 오래되면 "지금 값"이 아니라 "몇 시 기준"으로 보여준다
  var STOPS_KEEP_MS = 180000;  // 시간 없이 정류장 수만 있는 줄은 응답이 끊겨도 이 시간까지 "기준" 표시로 남긴다

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function clockHM(ms) { var d = new Date(ms); return pad2(d.getHours()) + ":" + pad2(d.getMinutes()); }
  function clockHMS(ms) { return clockHM(ms) + ":" + pad2(new Date(ms).getSeconds()); }
  function clean(s) { return String(s).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim(); }
  function decode(s) {
    return s.replace(/&(nbsp|amp|lt|gt|quot|#39|#\d+);/g, function (all, name) {
      if (name.charAt(0) === "#") return String.fromCharCode(Number(name.slice(1)));
      return { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"' }[name];
    });
  }
  function textOf(fragment) { return clean(decode(String(fragment).replace(/<[^>]+>/g, " "))); }
  function isNum(v) { return typeof v === "number" && isFinite(v); }

  // 칠곡 버스정보시스템 정류장 팝업 HTML -> [{route_id, route_no, name, ends, stops, minutes, bus, text}] (bis/parse.py 와 같은 규칙)
  // 버스가 없으면("도착정보가 없습니다") bus=false. 모르는 문구는 숫자로 바꾸지 않고 text 에만 남긴다("곧"만 0분).
  function parseChilgok(html) {
    var rows = [], re = /<tr[^>]*\bid=["']([^"']+)["'][^>]*>([\s\S]*?)<\/tr>/g, m;
    while ((m = re.exec(String(html || "")))) {
      var body = m[2], th = /<th[^>]*>([\s\S]*?)<\/th>/.exec(body);
      if (!th) continue;
      var span = /<span[^>]*>([\s\S]*?)<\/span>/.exec(th[1]), sub = /<sub[^>]*>([\s\S]*?)<\/sub>/.exec(th[1]);
      var p = /<p[^>]*>([\s\S]*?)<\/p>/.exec(span ? th[1].slice(span.index + span[0].length) : th[1]);
      var cells = [], tdRe = /<td[^>]*>([\s\S]*?)<\/td>/g, c;
      while ((c = tdRe.exec(body))) cells.push(textOf(c[1]));
      var joined = clean(cells.join(" ")), none = !joined || joined.indexOf("도착정보가 없습니다") >= 0;
      var away = /(\d+)\s*정거장\s*전/.exec(joined), mins = /(\d+)\s*분\s*후/.exec(joined);
      rows.push({
        route_id: m[1].split("_")[0],
        route_no: span ? textOf(span[1]) : "",
        name: p ? textOf(p[1].replace(/<sub[\s\S]*?<\/sub>/g, " ")) : "",
        ends: sub ? textOf(sub[1]).replace(/^\(\s*/, "").replace(/\s*\)$/, "") : "",
        stops: !none && away ? Number(away[1]) : null,
        minutes: none ? null : mins ? Number(mins[1]) : (/곧/.test(joined) ? 0 : null),
        bus: !none,
        text: none ? "" : joined
      });
    }
    return rows;
  }

  // 대구 버스정보시스템 도착정보 JSON -> parseChilgok 과 같은 모양(route_id 앞에 "dgb:"). 성공 표시가 없으면 null(실패).
  // "N분" = N분, "곧 도착" = 0분, "기점출발예정"(아직 안 떠난 차) = 시간 없음(받은 출발 시각이 있으면 depart 로만),
  // "운행종료" = 버스 없음(뺀다). bsGap 이 음수면 정류장 수 없음.
  function parseDaegu(json) {
    if (!json || typeof json !== "object" || !json.header || json.header.success !== true) return null;
    var list = json.body && Array.isArray(json.body.list) ? json.body.list : [];
    var out = [];
    list.forEach(function (r) {
      if (!r || typeof r !== "object") return;
      var st = clean(r.arrState || ""), gap = r.bsGap === null || r.bsGap === "" ? NaN : Number(r.bsGap);
      if (/운행\s*종료/.test(st)) return;
      var pending = /출발\s*예정/.test(st), m = /(\d+)\s*분/.exec(st), dep = /(\d{1,2}):(\d{2})/.exec(st);
      out.push({
        route_id: "dgb:" + r.routeId,
        route_no: clean(r.routeNo || ""),
        name: "", ends: "",
        stops: isNum(gap) && gap >= 0 ? gap : null,
        minutes: pending ? null : m ? Number(m[1]) : (/곧/.test(st) ? 0 : null),
        bus: true,
        text: st,
        pending: pending,
        depart: pending && dep ? pad2(Number(dep[1])) + ":" + dep[2] : null,
        vehicle: r.vhcNo2 ? clean(r.vhcNo2) : null,
        where: !pending && r.bsNm && !/출발|운행/.test(r.bsNm) ? clean(r.bsNm) : null  // 버스가 지금 있는 정류장
      });
    });
    return out;
  }

  // 한 정류장 응답(파싱한 줄) -> 화면 줄 [{key, dir, sid, route_id, route_no, label, board, stops, minutes, ref_min, base, where, turn, depart, vehicle, source}]
  // 허용 노선만, 같은 key 는 가장 빨리 오는 줄 하나. gaps 가 있는 정류장(학명리행)은 사용자 방식으로 동명 승차 정류장 기준으로 바꾼다:
  // 정류장 수 - gaps.stops, 분 - offset_min. 이미 기준 승차 정류장을 지났으면 아직 앞에 있는 더 가까운 동명 정류장(alts)에서 타고
  // 빼는 분은 정류장 수 비율로 줄인다(예: 9정류장 10분 -> 8정류장 9분). 동명을 다 지난 차·정류장 수를 모르는 차는 뺀다.
  function directionRows(cfg, sid, parsed) {
    var st = cfg && cfg.stops && cfg.stops[sid];
    if (!st || !Array.isArray(parsed)) return [];
    var best = {}, order = [];
    function rank(r) { return isNum(r.minutes) ? r.minutes : isNum(r.stops) ? 10000 + r.stops : 20000; }
    function put(r) {
      if (!best[r.key]) order.push(r.key);
      if (!best[r.key] || rank(r) < rank(best[r.key])) best[r.key] = r;
    }
    parsed.forEach(function (p) {
      if (!p || !p.bus) return;
      if (st.route_ids && st.route_ids.indexOf(p.route_id) < 0) return;
      if (st.route_nos && st.route_nos.indexOf(p.route_no) < 0) return;
      if (!isNum(p.minutes) && !isNum(p.stops) && !p.depart) return;
      var r = {
        key: st.direction + ":" + p.route_id, dir: st.direction, sid: sid, route_id: p.route_id, route_no: p.route_no,
        label: (cfg.labels && cfg.labels[p.route_id]) || (p.route_no === "칠곡3" && p.ends ? p.ends : null),
        board: st.name, stops: isNum(p.stops) ? p.stops : null, minutes: isNum(p.minutes) ? p.minutes : null,
        ref_min: null, base: null, where: p.where || null, turn: null,
        depart: p.depart || null, vehicle: p.vehicle || null, source: st.source === "daegu" ? "daegu" : "chilgok"
      };
      var gap = st.gaps && st.gaps[p.route_id];
      if (gap) {
        if (r.stops === null) return;
        var board = r.stops >= gap.stops ? gap : (gap.alts || []).filter(function (a) { return r.stops >= a.stops; })[0];
        if (!board) return;
        // 학명리 정류소 시간에서 몇 분 빼는 건 짐작이라(10/25 9-3: 우체국에 서 있는데 '3분 뒤') 세지 않는다.
        // 정류장 수(실제 값)만 승차 정류장 기준으로 바꾸고, 받은 시간은 "학명리 도착 N분(참고)"로만 둔다.
        r.stops -= board.stops;
        r.board = board.board;
        r.ref_min = r.minutes; r.minutes = null; r.base = st.name;
      }
      put(r);
    });
    (cfg.turnaround || []).forEach(function (t) {
      if (t.station !== sid) return;
      parsed.forEach(function (p) {
        if (!p || !p.bus || p.route_id !== t.route_id || !isNum(p.stops)) return;
        put({
          key: t.direction + ":" + t.route_id + ":turn", dir: t.direction, sid: sid, route_id: t.route_id, route_no: t.route_no || p.route_no,
          label: null, board: null, stops: p.stops + t.extra_stops, minutes: isNum(p.minutes) ? p.minutes : null,
          ref_min: null, base: null, where: p.where || null, turn: { terminal: t.terminal, pass: st.name },
          depart: null, vehicle: p.vehicle || null, source: st.source === "daegu" ? "daegu" : "chilgok"
        });
      });
    });
    return order.map(function (k) { return best[k]; });
  }

  // 칠곡 정류장 sid 를 TAGO 로 대신: 중계 /all 응답 -> 화면 줄(source "tago") | null(대신할 수 없음·전부 실패).
  // TAGO 노선 id 는 칠곡 버스정보시스템 id 에 도시 머리(CGB·GMB)가 붙은 모양(CGB30020 = 30020). 대구 노선(DGB)은 뺀다.
  function tagoItems(node) {
    var items = node && node.body && node.body.response && node.body.response.body && node.body.response.body.items;
    var list = items && items.item;
    if (list === undefined || list === null) return [];
    return Array.isArray(list) ? list : [list];
  }
  function tagoRows(cfg, sid, all) {
    var tc = cfg && cfg.tago && cfg.tago.stations && cfg.tago.stations[sid], st = cfg && cfg.stops && cfg.stops[sid];
    var results = all && all.results;
    if (!tc || !st || !results) return null;
    var parsed = [], anyOk = false;
    tc.nodes.forEach(function (id) {
      var node = results[id];
      if (!node || !node.ok) return;
      anyOk = true;
      tagoItems(node).forEach(function (it) {
        var rid = String((it && it.routeid) || "");
        if (!/^(CGB|GMB)/.test(rid)) return;
        var sec = Number(it.arrtime), cnt = Number(it.arrprevstationcnt);
        parsed.push({
          route_id: rid.slice(3), route_no: clean(it.routeno || ""), name: "", ends: "",
          stops: isFinite(cnt) && cnt >= 0 ? cnt : null, minutes: isFinite(sec) && sec >= 0 ? Math.round(sec / 60) : null,
          bus: true, text: "", board: (cfg.tago.names && cfg.tago.names[id]) || st.name
        });
      });
    });
    if (!anyOk) return null;
    var rows;
    if (tc.same_stop) rows = directionRows(cfg, sid, parsed);
    else {
      var best = {}, order = [];
      parsed.forEach(function (p) {
        if (st.route_ids && st.route_ids.indexOf(p.route_id) < 0) return;
        if (!isNum(p.minutes) && !isNum(p.stops)) return;
        var r = {
          key: st.direction + ":" + p.route_id, dir: st.direction, sid: sid, route_id: p.route_id, route_no: p.route_no,
          label: null, board: p.board, stops: p.stops, minutes: p.minutes, ref_min: null, base: null, where: null,
          turn: null, depart: null, vehicle: null
        };
        var b = best[r.key], rank = function (x) { return isNum(x.minutes) ? x.minutes : 10000 + x.stops; };
        if (!b) order.push(r.key);
        if (!b || rank(r) < rank(b)) best[r.key] = r;
      });
      rows = order.map(function (k) { return best[k]; });
    }
    rows.forEach(function (r) { r.source = "tago"; });
    return rows;
  }

  // 학명리행 승차 정류장(동명) 시간을 TAGO 에서 직접: 중계 /all -> 줄(key = 버스정보시스템 줄 key + ":direct") | null.
  // 노선은 학명리행 정류장 규칙(gaps)에 있는 것만 - 동명엔 다른 방향·다른 노선 버스가 많아서 규칙 밖은 쓰지 않는다.
  // TAGO 노선 id: CGB30020 -> 30020, GMB88520 -> 88520, DGB1000009300 -> dgb:1000009300. 동명 정류장 여러 곳 중 가장 빨리 닿는 곳.
  function tagoDirectRows(cfg, all) {
    var td = cfg && cfg.tago && cfg.tago.direct, results = all && all.results;
    if (!td || !results) return null;
    var allowed = {};
    Object.keys(cfg.stops).forEach(function (sid) {
      var st = cfg.stops[sid];
      if (st.direction === td.direction && st.gaps) Object.keys(st.gaps).forEach(function (id) { allowed[id] = true; });
    });
    var best = {}, order = [], anyOk = false;
    td.nodes.forEach(function (node) {
      var res = results[node];
      if (!res || !res.ok) return;
      anyOk = true;
      tagoItems(res).forEach(function (it) {
        var rid = String((it && it.routeid) || ""), id = /^DGB/.test(rid) ? "dgb:" + rid.slice(3) : /^(CGB|GMB)/.test(rid) ? rid.slice(3) : null;
        var sec = Number(it.arrtime), cnt = Number(it.arrprevstationcnt);
        if (!id || !allowed[id] || !isFinite(sec) || sec < 0) return;
        var base = td.direction + ":" + id, r = {
          key: base + ":direct", direct_of: base, dir: td.direction, sid: "tago:direct", route_id: id, route_no: clean(it.routeno || ""),
          label: null, board: (cfg.tago.names && cfg.tago.names[node]) || null, stops: isFinite(cnt) && cnt >= 0 ? cnt : null,
          minutes: Math.round(sec / 60), ref_min: null, base: null, where: null, turn: null, depart: null, vehicle: null, source: "tago"
        };
        if (!best[r.key]) order.push(r.key);
        if (!best[r.key] || r.minutes < best[r.key].minutes) best[r.key] = r;
      });
    });
    return anyOk ? order.map(function (k) { return best[k]; }) : null;
  }

  // 한 방향 카드에 영향을 주는 정류장들(그 방향 정류장 + 되돌이 노선을 보는 정류장)
  function stationsOf(cfg, dir) {
    var out = Object.keys(cfg.stops).filter(function (sid) { return cfg.stops[sid].direction === dir; });
    (cfg.turnaround || []).forEach(function (t) { if (t.direction === dir && out.indexOf(t.station) < 0) out.push(t.station); });
    return out;
  }

  // ---- 받은 시간 기억 ----
  // state.memo[key] = 화면 줄 + {end: 도착 시각 ms | null, seenAt: 마지막으로 응답에 있던 때, recvAt: 마지막으로 분을 받은 때}
  // state.stations[sid] = {okAt: 마지막 성공 응답 시각, failAt}
  function newState() { return { memo: {}, stations: {} }; }

  var FIELDS = ["key", "dir", "sid", "route_id", "route_no", "label", "board", "stops", "minutes", "ref_min", "base", "where", "direct_of", "turn", "depart", "vehicle", "source"];

  // 정류장 sid 의 성공 응답(directionRows 결과)을 시각 t 에 받았다.
  function ingest(state, sid, rows, t) {
    state.stations[sid] = { okAt: t, failAt: (state.stations[sid] || {}).failAt || null };
    (rows || []).forEach(function (r) {
      var m = state.memo[r.key];
      var end = m && isNum(m.end) && t - m.end <= HOLD_MS ? m.end : null, recvAt = m ? m.recvAt || null : null;
      if (isNum(r.minutes)) {
        var target = t + r.minutes * 60000;
        if (end === null || Math.abs(end - target) >= SNAP_MS) end = target;
        recvAt = t;
      }
      var e = {};
      FIELDS.forEach(function (f) { e[f] = r[f] === undefined ? null : r[f]; });
      e.end = end; e.seenAt = t; e.recvAt = recvAt;
      state.memo[r.key] = e;
    });
  }

  // 정류장 sid 응답 실패(시간 초과·오류). 받은 시간은 건드리지 않는다.
  function fail(state, sid, t) {
    state.stations[sid] = { okAt: (state.stations[sid] || {}).okAt || null, failAt: t };
  }

  // 방향 dir 의 화면 줄(빨리 오는 순). live = 이 줄이 그 정류장의 최신 응답(FRESH_MS 안)에 있었다. 아니면 "기준" 표시로 이어서 보여준다.
  // 시간이 있는 줄은 도착 시각 + HOLD_MS 까지, 시간 없는 줄은 마지막으로 본 때 + STOPS_KEEP_MS 까지 남기고 그 뒤엔 기억에서 지운다.
  function view(state, dir, now) {
    var out = [];
    Object.keys(state.memo).forEach(function (k) {
      var m = state.memo[k];
      if (!m || m.dir !== dir) return;
      var st = state.stations[m.sid] || {};
      var live = isNum(st.okAt) && m.seenAt === st.okAt && now - st.okAt <= FRESH_MS;
      if (isNum(m.end) ? now - m.end > HOLD_MS : !live && now - m.seenAt > STOPS_KEEP_MS) { delete state.memo[k]; return; }
      var r = {};
      for (var f in m) r[f] = m[f];
      r.live = live;
      out.push(r);
    });
    var byKey = {};
    out.forEach(function (r) { if (!r.direct_of) byKey[r.key] = r; });
    out = out.filter(function (r) {
      if (!r.direct_of) return true;
      var b = byKey[r.direct_of];
      if (b && r.live && isNum(r.end)) { b.end = r.end; b.board = r.board; if (isNum(r.stops)) b.stops = r.stops; b.time_src = "tago"; }
      return false;
    });
    function k1(r) { return isNum(r.end) ? r.end : 9e15; }
    function k2(r) { return isNum(r.stops) ? r.stops : 9e15; }
    out.sort(function (a, b) { return k1(a) - k1(b) || k2(a) - k2(b) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0); });
    return out;
  }

  // 기기에 저장(앱을 다시 열어도 받은 시간을 이어서 줄인다). 정류장 응답 상태는 저장하지 않는다(다시 열면 새로 받는다).
  // v2(10/25): 학명리행 줄에 '빼서 만든 시간'을 더는 쓰지 않는다 - 예전(v1) 기억은 버린다.
  function save(state) { return JSON.stringify({ v: 2, memo: state.memo }); }
  function restore(text, now) {
    var s = newState(), j;
    try { j = JSON.parse(text); } catch (e) { return s; }
    var memo = j && typeof j === "object" && !Array.isArray(j) && j.v === 2 && j.memo && typeof j.memo === "object" ? j.memo : {};
    Object.keys(memo).forEach(function (k) {
      var m = memo[k];
      if (!m || typeof m !== "object" || typeof m.dir !== "string" || !isNum(m.seenAt)) return;
      if (isNum(m.end) ? now - m.end <= HOLD_MS : now - m.seenAt <= STOPS_KEEP_MS) s.memo[k] = m;
    });
    return s;
  }

  // ---- 글자·화면 조각 ----
  function countdownText(end, now) {
    var sec = Math.round((end - now) / 1000);
    if (sec <= 0) return "곧 도착";
    if (sec < 60) return sec + "초 뒤";
    if (sec >= 3600) return Math.floor(sec / 3600) + "시간 " + Math.floor((sec % 3600) / 60) + "분 " + pad2(sec % 60) + "초 뒤";
    return Math.floor(sec / 60) + "분 " + pad2(sec % 60) + "초 뒤";
  }
  function stopsText(n) { return isNum(n) ? (n === 0 ? "정류장에 있음" : n + "정류장 전") : ""; }

  function renderRow(r, now) {
    var hasEnd = isNum(r.end), hasStops = isNum(r.stops), big = "", attr = "", sub = [];
    if (r.turn) {
      big = "종점까지 " + r.stops + "정류장";
      if (hasEnd) sub.push(esc(r.turn.pass + " 지나는 시간 ") + '<span role="timer" data-end="' + r.end + '">' + esc(countdownText(r.end, now)) + "</span>");
      sub.push(esc("구미에서 오는 버스 · " + r.turn.terminal + " 종점에서 바로 학명리 방향으로 출발"));
    } else {
      if (hasEnd) { big = countdownText(r.end, now); attr = ' role="timer" data-end="' + r.end + '"'; if (hasStops) sub.push(esc(stopsText(r.stops))); }
      else if (hasStops) big = stopsText(r.stops);
      else if (r.depart) big = "기점 " + r.depart + " 출발 예정";
      if (r.board) sub.push(esc(r.board + "에서 타기"));
      if (r.label) sub.push(esc(r.label));
      if (r.time_src === "tago" && r.board) sub.push(esc(r.board + " 도착 시간 TAGO"));
      if (r.where) sub.push(esc("지금 위치 " + r.where));
      if (isNum(r.ref_min) && r.base) sub.push(esc(r.base + " 도착 " + r.ref_min + "분(참고)"));
      if (r.vehicle) sub.push(esc("차량 " + r.vehicle));
      if (r.late) sub.push('<span class="late">' + esc(r.late) + "</span>");
    }
    if (r.source === "daegu") sub.push("대구 정보");
    if (r.source === "tago") sub.push("TAGO 정보(칠곡 시스템 대신)");
    if (!r.live) sub.push(esc(clockHM(r.seenAt) + " 기준"));
    return '<div class="bus' + (r.live ? "" : " carried") + '"><div class="top"><span class="no">' + esc(r.route_no) + '번</span><span class="when"' + attr + ">" +
      esc(big) + "</span></div>" + (sub.length ? '<div class="where">' + sub.join(" · ") + "</div>" : "") + "</div>";
  }

  var CARD = {
    dongmyeong: { title: "동명 가는 버스", sub: "학명리 건너2 정류장에서 타기" },
    hakmyeong: { title: "학명리 가는 버스", sub: "동명 정류장(행정복지센터·우체국·동명교통)에서 타기" }
  };

  // health = {ok, fail, total, waiting}: 이번 확인에서 그 방향 정류장 중 받은 수 / 못 받은 수 / 전체 / 아직 기다리는 수
  function renderCard(dir, rows, health, now) {
    var info = CARD[dir], h = "<h2>" + esc(info.title) + '</h2><p class="sub">' + esc(info.sub) + "</p>";
    if (rows.length) {
      h += rows.map(function (r) { return renderRow(r, now); }).join("");
      if (health.fail > 0) h += '<p class="note">일부 정류장 정보가 늦어서 직전 값을 이어서 보여줘요</p>';
      else if (health.waiting > 0) h += '<p class="note">새 정보 확인 중…</p>';
    } else if (health.ok === 0 && health.fail === 0) {
      h += '<p class="note">확인 중…</p>';
    } else if (health.ok === 0) {
      h += '<div class="warn">버스 정보를 못 받았어요. 잠시 후 다시 확인해요</div>';
    } else {
      h += '<div class="none">지금 오는 버스 없음</div>';
      if (health.fail > 0) h += '<p class="note">일부 정류장 정보가 늦어요</p>';
    }
    return h;
  }

  // 대구 예상이 이른 노선(cfg.late) -> "더 늦을 수 있음" 안내 글. 시간표(stats: 실제 통과 기록)에서 받은 도착 시각 -10분 뒤로
  // 가장 가까운 시각(60분 안)이 있으면 같이 쓴다. 남은 시간은 바꾸지 않는다(만들어 내지 않음).
  function lateNote(cfg, stats, dir, r) {
    var list = cfg && cfg.late && cfg.late[dir];
    if (!list || list.indexOf(r.route_no) < 0) return null;
    var note = "대구 예상보다 늦게 올 수 있음";
    if (!isNum(r.end) || !stats || !Array.isArray(stats[dir])) return note;
    var hm = clockHM(r.end).split(":"), at = Number(hm[0]) * 60 + Number(hm[1]), best = null;
    stats[dir].forEach(function (s) {
      var m = /^(\d\d):(\d\d)$/.exec((s && s.avg_time) || "");
      if (!s || s.routeno !== r.route_no || !m) return;
      var d = Number(m[1]) * 60 + Number(m[2]) - at;
      if (d >= -10 && d <= 60 && (best === null || d < best.d)) best = { d: d, s: s };
    });
    return best ? note + " · 시간표 " + best.s.avg_time + "(" + best.s.sample_count + "일 기록)" : note;
  }

  // 운행업체 시간표(timetable.json)에서 실시간 위치 없는 마을버스(cfg.village)의 오늘 남은 운행. 동명행은 동명·송산3리 도착이
  // 지나지 않은 운행, 학명리행은 동명·송산3리 출발이 10분 넘게 지나지 않은 운행. 실시간 줄이 있는 노선은 뺀다. 노선마다 1개, 최대 3개.
  function villageRows(cfg, tt, dir, now, liveNos) {
    var vc = cfg && cfg.village, rule = vc && vc[dir];
    if (!rule || !tt || !Array.isArray(tt.routes)) return [];
    var hm = clockHM(now).split(":"), cur = Number(hm[0]) * 60 + Number(hm[1]), out = [];
    function mins(t) { var m = /^(\d\d):(\d\d)$/.exec(t || ""); return m ? Number(m[1]) * 60 + Number(m[2]) : null; }
    tt.routes.forEach(function (r) {
      if (vc.routes.indexOf(r.routeno) < 0 || (liveNos || []).indexOf(r.routeno) >= 0) return;
      var next = null;
      (r.trips || []).forEach(function (t) {
        var key = rule.to ? (rule.to.indexOf(t.to) >= 0 ? mins(t.arrive) : null) : (rule.from.indexOf(t.from) >= 0 ? mins(t.depart) : null);
        if (key === null || key < cur - (rule.to ? 0 : 10)) return;
        if (!next || key < next.key) next = { key: key, route_no: r.routeno, from: t.from, depart: t.depart, to: t.to, arrive: t.arrive || null };
      });
      if (next) out.push(next);
    });
    out.sort(function (a, b) { return a.key - b.key; });
    return out.slice(0, 3);
  }
  function renderVillage(rows) {
    if (!rows.length) return "";
    return '<p class="note">실시간 위치가 없는 마을버스 · 운행업체 시간표</p>' + rows.map(function (v) {
      return '<div class="bus carried"><div class="top"><span class="no">' + esc(v.route_no) + '번</span><span class="when">시간표</span></div>' +
        '<div class="where">' + esc(v.from + " " + v.depart + " 출발 → " + v.to + (v.arrive ? " " + v.arrive + " 도착" : "")) + "</div></div>";
    }).join("");
  }

  // ---- 시간표(최근 실제 기록) ----
  function renderStats(rows) {
    if (!rows || !rows.length) return '<p class="note">아직 기록이 모이는 중이에요</p>';
    return '<table class="times"><thead><tr><th>버스</th><th>평균</th><th>최소~최대</th></tr></thead><tbody>' +
      rows.map(function (r) {
        return "<tr><td>" + (r.routeno ? esc(r.routeno) + "번" : "-") + "</td><td>" + esc(r.avg_time) + "</td><td>" +
          esc(r.min_time) + "~" + esc(r.max_time) + "<small>" + esc(r.sample_count) + "일 기록</small></td></tr>";
      }).join("") + "</tbody></table>";
  }
  // arrivals.json(수집 기록에서 확인한 실제 통과) -> 그날 그 방향 [[HH:MM, 노선번호]]
  function todayPassed(arrivals, dir, day) {
    var list = arrivals && arrivals[dir] && arrivals[dir][day];
    if (!Array.isArray(list)) return [];
    return list.map(function (a) { return [String((a && a.arrival_time) || "").slice(11, 16), String((a && a.routeno) || "")]; })
      .filter(function (x) { return /^\d\d:\d\d$/.test(x[0]); });
  }
  function kstDate(ms) { return new Date(ms + 9 * 3600000).toISOString().slice(0, 10); }

  // 운행업체 시간표(기점·종점 출발 시각, timetable.json) - 바꾸지 않고 원본 그대로
  function renderReference(tt) {
    if (!tt || !Array.isArray(tt.routes) || !tt.routes.length) return "";
    var h = tt.note ? '<p class="note">' + esc(tt.note) + "</p>" : "";
    h += tt.routes.map(function (r) {
      var trips = (r.trips || []).map(function (t) {
        return '<div class="trip">' + esc(t.from) + " <b>" + esc(t.depart) + "</b> → " + esc(t.to) + (t.arrive ? " " + esc(t.arrive) : "") +
          (t.variant ? " (" + esc(t.variant) + ")" : "") + "</div>";
      }).join("");
      var stops = (r.stop_times || []).map(function (s) {
        return '<div class="trip">' + esc(s.stop) + " (" + esc(s.direction) + ") 통과: " + (s.times || []).map(esc).join(", ") + "</div>";
      }).join("");
      return '<div class="rt"><b>' + esc(r.routeno) + '번</b> <span class="muted">' + esc(r.path || "") + "</span>" + trips + stops + "</div>";
    }).join("");
    if (tt.source) h += '<p class="note">' + esc(tt.source) + "</p>";
    return h;
  }

  var api = {
    HOLD_MS: HOLD_MS, SNAP_MS: SNAP_MS, FRESH_MS: FRESH_MS,
    esc: esc, clockHM: clockHM, clockHMS: clockHMS,
    parseChilgok: parseChilgok, parseDaegu: parseDaegu, directionRows: directionRows, tagoRows: tagoRows, tagoDirectRows: tagoDirectRows, stationsOf: stationsOf,
    newState: newState, ingest: ingest, fail: fail, view: view, save: save, restore: restore,
    countdownText: countdownText, stopsText: stopsText, renderRow: renderRow, renderCard: renderCard,
    renderStats: renderStats, todayPassed: todayPassed, kstDate: kstDate, renderReference: renderReference,
    lateNote: lateNote, villageRows: villageRows, renderVillage: renderVillage
  };
  root.V3 = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : this);
