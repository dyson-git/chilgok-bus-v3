// v3 서비스 워커: 크롬 "앱 설치"(홈 화면 설치) 조건을 맞추고, 인터넷이 끊겼을 때 마지막 화면 파일로 열리게 한다.
// 화면 파일은 항상 네트워크 먼저(새 버전 바로 반영), 실패할 때만 저장본. 버스 정보(중계)·시간표 데이터는 저장하지 않는다.
"use strict";
var CACHE = "v3-shell";
var SHELL = ["./", "index.html", "core.js", "app.js", "stops.js", "manifest.json", "icons/icon-192.png", "icons/icon-512.png"];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.indexOf("/data/") >= 0) return;
  e.respondWith(fetch(e.request).then(function (r) {
    if (r.ok && !url.search) { var copy = r.clone(); caches.open(CACHE).then(function (c) { c.put(e.request, copy); }); }
    return r;
  }).catch(function () { return caches.match(e.request, { ignoreSearch: true }); }));
});
