// v3 화면 연결. 규칙은 core.js(순수 함수)에 있고 여기는 받기·그리기·저장만 한다.
// - 정류장 6곳을 따로 받아 오는 대로 그린다(느린 정류장 하나가 화면 전체를 붙잡지 않게). 정류장마다 9초 제한.
// - 칠곡 정류장을 못 받으면 TAGO 로 대신한다(정류장 9초 + TAGO 9초까지 기다릴 수 있게).
// - 확인이 어떤 이유로 끝나지 않아도 20초 뒤엔 새 확인을 시작한다("확인 중…"에 멈추지 않게).
// - 앱을 열면 저장해 둔 받은 시간을 먼저 보여주고(기준 표시), 30초마다·화면으로 돌아올 때·카드를 누르면 새로 받는다.
"use strict";
(function () {
  var V = window.V3, CFG = window.V3_STOPS;
  var RELAY = window.V3_RELAY || "https://chilgok-bus-relay.wisdomdy.workers.dev";
  var DIRS = ["dongmyeong", "hakmyeong"];
  var STATION_TIMEOUT_MS = 9000, STUCK_MS = 20000, REFRESH_MS = 30000, BACK_MIN_MS = 10000;
  var MEMO_KEY = "v3.memo", FOLD_KEY = "v3.fold";
  var SIDS = Object.keys(CFG.stops);

  var el = {
    card: { dongmyeong: document.getElementById("card-dongmyeong"), hakmyeong: document.getElementById("card-hakmyeong") },
    refresh: document.getElementById("refresh"), checked: document.getElementById("checked"), times: document.getElementById("times")
  };
  var state = V.restore(read(MEMO_KEY), Date.now());
  var round = { id: 0, startedAt: 0, doneAt: null, pending: {}, ok: {}, failed: {}, tago: {}, all: null };
  var times = { stats: null, arrivals: null, ref: null, fold: readFold() };

  function read(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function write(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* 저장 못 해도 동작은 한다 */ } }
  function readFold() {
    try { var f = JSON.parse(read(FOLD_KEY)); return f && typeof f === "object" ? f : {}; } catch (e) { return {}; }
  }

  // 미리보기(tests/preview.html)는 window.V3_FETCH 로 저장된 응답을 넣는다. 기본은 중계(Cloudflare Worker)에서 받는다.
  function fetchText(url, signal) {
    if (window.V3_FETCH) return window.V3_FETCH(url, signal);
    return fetch(url, { cache: "no-store", signal: signal }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.text();
    });
  }

  // 한 정류장 -> 파싱한 줄 | null(실패). 칠곡은 정류장 팝업 HTML(/bis), 대구는 JSON(/dgb).
  function fetchStation(sid) {
    var daegu = CFG.stops[sid].source === "daegu";
    var url = daegu ? RELAY + "/dgb?bs=" + encodeURIComponent(sid.slice(4)) : RELAY + "/bis?stop=" + encodeURIComponent(sid);
    var ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, STATION_TIMEOUT_MS);
    var timeout = new Promise(function (resolve) { setTimeout(function () { resolve(null); }, STATION_TIMEOUT_MS + 500); });
    var got = fetchText(url, ctl ? ctl.signal : undefined).then(function (text) {
      if (daegu) {
        var j;
        try { j = JSON.parse(text); } catch (e) { return null; }
        return V.parseDaegu(j);
      }
      var rows = V.parseChilgok(text);
      return rows.length ? rows : null;  // 칠곡 팝업은 버스가 없어도 노선 줄이 있다 - 줄이 0개면 오류 페이지
    }).catch(function () { return null; });
    return Promise.race([got, timeout]).then(function (rows) { clearTimeout(timer); return rows; });
  }

  // 칠곡 정류장을 못 받으면 TAGO(중계 /all, 한 확인에 한 번만 받는다)로 그 정류장을 대신한다. 대신도 못 하면 null.
  function fetchAll() {
    if (round.all) return round.all;
    var ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, STATION_TIMEOUT_MS);
    round.all = fetchText(RELAY + "/all", ctl ? ctl.signal : undefined)
      .then(function (text) { clearTimeout(timer); return JSON.parse(text); })
      .catch(function () { clearTimeout(timer); return null; });
    return round.all;
  }
  function viaTago(sid) {
    if (CFG.stops[sid].source === "daegu" || !(CFG.tago && CFG.tago.stations && CFG.tago.stations[sid])) return Promise.resolve(null);
    return fetchAll().then(function (all) { return V.tagoRows(CFG, sid, all); });
  }

  function check() {
    var now = Date.now();
    if (round.doneAt === null && round.startedAt && now - round.startedAt < STUCK_MS) return;  // 확인 중
    var id = ++round.id, left = SIDS.length;
    round.startedAt = now; round.doneAt = null; round.pending = {}; round.ok = {}; round.failed = {}; round.tago = {}; round.all = null;
    SIDS.forEach(function (sid) { round.pending[sid] = true; });
    fetchAll().then(function (all) {
      var rows = id === round.id ? V.tagoDirectRows(CFG, all) : null;
      if (rows) { V.ingest(state, "tago:direct", rows, Date.now()); drawCards(); }
    });
    drawCards();
    SIDS.forEach(function (sid) {
      fetchStation(sid).then(function (parsed) {
        if (parsed) return { rows: V.directionRows(CFG, sid, parsed) };
        return viaTago(sid).then(function (rows) { return rows ? { rows: rows, tago: true } : null; });
      }).then(function (got) {
        if (id !== round.id) return;
        var t = Date.now();
        if (got) { V.ingest(state, sid, got.rows, t); round.ok[sid] = true; if (got.tago) round.tago[sid] = true; }
        else { V.fail(state, sid, t); round.failed[sid] = true; }
        delete round.pending[sid];
        if (--left === 0) { round.doneAt = t; write(MEMO_KEY, V.save(state)); }
        drawCards();
      });
    });
  }

  function health(dir) {
    var h = { ok: 0, fail: 0, total: 0, waiting: 0 };
    V.stationsOf(CFG, dir).forEach(function (sid) {
      h.total++;
      if (round.ok[sid]) h.ok++; else if (round.failed[sid]) h.fail++; else h.waiting++;
    });
    return h;
  }

  function drawCards() {
    var now = Date.now();
    DIRS.forEach(function (d) {
      try {
        var rows = V.view(state, d, now);
        rows.forEach(function (r) { r.late = V.lateNote(CFG, times.stats, d, r); });
        var nos = rows.map(function (r) { return r.route_no; });
        var fixed = V.fixedDepartRows(CFG, times.ref, d, now, nos).concat(V.fixedArriveRows(CFG, d, now, nos));
        if (fixed.length) {
          rows = rows.concat(fixed);
          rows.sort(function (a, b) { return (typeof a.end === "number" ? a.end : 9e15) - (typeof b.end === "number" ? b.end : 9e15); });
        }
        el.card[d].innerHTML = V.renderCard(d, rows, health(d), now);
      } catch (e) {
        el.card[d].innerHTML = '<h2>' + V.esc(d === "dongmyeong" ? "동명 가는 버스" : "학명리 가는 버스") + '</h2><div class="warn">화면을 그리다 문제가 생겼어요. 새로고침 해주세요</div>';
        if (window.console) console.error(e);
      }
    });
    var busy = round.doneAt === null && !!round.startedAt;
    el.refresh.disabled = busy;
    el.refresh.textContent = busy ? "확인 중…" : "새로고침";
    el.checked.textContent = statusText(busy);
  }

  function statusText(busy) {
    if (!round.startedAt) return "";
    var src = { chilgok: [0, 0], daegu: [0, 0] };
    SIDS.forEach(function (sid) {
      var s = src[CFG.stops[sid].source === "daegu" ? "daegu" : "chilgok"];
      s[1]++;
      if (round.ok[sid]) s[0]++;
    });
    var subs = Object.keys(round.tago).length;
    var parts = ["칠곡 " + (src.chilgok[0] - subs) + "/" + src.chilgok[1] + (subs ? " (TAGO로 대신 " + subs + ")" : ""), "대구 " + src.daegu[0] + "/" + src.daegu[1]];
    return busy ? "확인 중… · " + parts.join(" · ") : V.clockHMS(round.doneAt) + " 확인 · " + parts.join(" · ");
  }

  // 1초마다 남은 시간 숫자만 바꾸고, 5초마다 카드를 다시 그려 '기준' 표시·지난 버스 정리를 반영한다.
  var ticks = 0;
  setInterval(function () {
    if (document.hidden) return;
    var now = Date.now();
    if (++ticks % 5 === 0) { drawCards(); return; }
    Array.prototype.forEach.call(document.querySelectorAll("[data-end]"), function (n) {
      n.textContent = V.countdownText(Number(n.getAttribute("data-end")), now);
    });
  }, 1000);

  // ---- 시간표 ----
  var CHEVRON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
  var TIME_TITLE = { dongmyeong: "동명행", hakmyeong: "학명리행" };

  function getJson(path) {
    return fetch(path + (path.indexOf("?") < 0 ? "?" : "&") + "t=" + Date.now(), { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }
  function loadTimes() {
    getJson("data/stats.json").then(function (j) { if (j) { times.stats = j; drawTimes(); drawCards(); } });
    getJson("data/arrivals.json").then(function (j) { if (j) { times.arrivals = j; drawTimes(); } });
  }
  function isOpen(id) { return id === "ref" ? times.fold.ref === true : times.fold[id] !== false; }
  function foldBox(id, title, body, small) {
    var open = isOpen(id);
    return '<section class="fold' + (small ? " small" : "") + '" data-fold="' + id + '" data-open="' + open + '"><button type="button" aria-expanded="' +
      open + '"><span>' + V.esc(title) + "</span>" + CHEVRON + "</button>" + (open ? '<div class="body">' + body + "</div>" : "") + "</section>";
  }
  function dirBody(d) {
    var passed = V.todayPassed(times.arrivals, d, V.kstDate(Date.now()));
    return '<p class="note">오늘 지나간 버스</p>' +
      (passed.length ? '<ul class="passed">' + passed.map(function (p) { return "<li>" + V.esc(p[0] + " " + p[1]) + "</li>"; }).join("") + "</ul>"
        : '<p class="note">오늘은 아직 기록이 없어요</p>') +
      '<p class="note">최근 30일, 비슷한 시각(30분 안)끼리 묶은 실제 통과 시각</p>' +
      (times.stats ? V.renderStats(times.stats[d]) : '<p class="note">불러오는 중…</p>');
  }
  function drawTimes() {
    var ref = V.renderReference(times.ref);
    el.times.innerHTML = DIRS.map(function (d) { return foldBox(d, TIME_TITLE[d], dirBody(d), false); }).join("") +
      (ref ? foldBox("ref", "운행업체 시간표 (기점·종점 출발 시각)", ref, true) : "") +
      '<p class="note">시간표 기록은 PC 수집 작업이 5분마다 받은 국토부 도착정보로 확인한 것이라, PC가 꺼져 있던 시간의 버스는 빠져 있어요.</p>';
  }
  el.times.addEventListener("click", function (e) {
    var btn = e.target.closest ? e.target.closest("[data-fold] > button") : null;
    if (!btn) return;
    var id = btn.parentNode.getAttribute("data-fold");
    times.fold[id] = !isOpen(id);
    write(FOLD_KEY, JSON.stringify(times.fold));
    drawTimes();
    var again = el.times.querySelector('[data-fold="' + id + '"] > button');
    if (again) again.focus();
  });

  // ---- 시작 ----
  el.refresh.addEventListener("click", check);
  DIRS.forEach(function (d) {
    el.card[d].addEventListener("click", check);
    el.card[d].addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); check(); } });
  });
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && (!round.startedAt || Date.now() - round.startedAt >= BACK_MIN_MS)) { check(); loadTimes(); }
  });
  window.addEventListener("pagehide", function () { write(MEMO_KEY, V.save(state)); });
  setInterval(function () { if (!document.hidden) check(); }, REFRESH_MS);
  setInterval(function () { if (!document.hidden) loadTimes(); }, 300000);

  drawCards();
  drawTimes();
  check();
  loadTimes();
  getJson("https://dyson-git.github.io/chilgok-bus-eta/timetable.json").then(function (j) { if (j) { times.ref = j; drawTimes(); drawCards(); } });
  // 크롬 '앱 설치' 조건(서비스 워커). 없어도 화면은 그대로 동작한다.
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(function () {});
})();
