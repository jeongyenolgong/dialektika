/* ─────────────────────────────────────────────────────────────────────────
   bus.js — 창 셋을 한 판으로 묶는 신호선

   ① 한 대에서 「다음」 한 번이 진행자 화면 · 스크린 · 참가자 폰을 같이 움직인다.
   장부는 localStorage 한 곳(본부의 장부)이고 BroadcastChannel이 종을 친다.
   지금 장부에 적히는 것은 **「다음」을 몇 번 눌렀나** 하나뿐이다 (0 ~ 7).

   ⛔ file:// 로 열면 창끼리 장부를 나누지 못한다. 로컬 서버로 연다:
        cd mockup && python3 -m http.server 8000
        http://localhost:8000/host.html

   대응표는 SSOT 8.1 「다음 여섯 번과 종료 한 번」을 그대로 옮긴 것이다.
   ───────────────────────────────────────────────────────────────────────── */
(() => {
  const KEY = "dlk.press";
  const CH  = "dialektika";

  /* SSOT 8.1 표 — 누름 0(아직 안 누름) ~ 7(종료) */
  const SCREEN = [
    "screen-01-entry.html",     /* 0 · 입장 중 */
    "screen-02-collect.html",   /* 1 · 수집 시작 */
    null,                       /* 2 · 수집 종료 — 🔴 「대기」가 9장에 없다. 지금은 그대로 멈춘다 */
    "screen-03-create.html",    /* 3 · 창작 시작 */
    null,                       /* 4 · 창작 종료 — 🔴 위와 같은 자리 */
    "screen-04-vote.html",      /* 5 · 투표 시작 */
    "screen-05-result.html",    /* 6 · 투표 종료 + 결과 발표 */
    null,                       /* 7 · 종료 — 그대로 둔다 */
  ];
  const PHONE = [
    null,                          /* 0 · 참가자가 P1→P2→P3를 스스로 밟는 중이라 건드리지 않는다 */
    "p4p5-collect.html",           /* 1 · P4 ⇄ P5 */
    "p3-wait.html",                /* 2 · 대기② */
    "p6-create.html",              /* 3 · P6 */
    "p3-wait.html",                /* 4 · 대기③ */
    "p8p9-vote-result.html",       /* 5 · P8 */
    "p8p9-vote-result.html?v=9",   /* 6 · P9 */
    null,                          /* 7 · 종료 */
  ];

  const here = location.pathname.split("/").pop() || "host.html";
  const role =
      here.startsWith("screen-")                ? "screen"
    : here === "host.html"                      ? "host"
    : here === "reconnect.html"                 ? null   /* 재접속은 따라가지 않는다 — 코드부터 받는 화면 */
    : /^p\d/.test(here)                         ? "phone"
    : null;

  const read = () => { const v = parseInt(localStorage.getItem(KEY), 10); return isNaN(v) ? 0 : v; };

  let ch = null;
  try { ch = new BroadcastChannel(CH); } catch (e) { /* 지원 안 되면 storage 이벤트만으로 돈다 */ }

  const subs = [];

  /* 내 자리에서 지금 눌림 수에 해당하는 화면으로 옮긴다 */
  function follow(n) {
    const table = role === "screen" ? SCREEN : role === "phone" ? PHONE : null;
    if (!table) return;
    let target = table[n];
    if (!target) return;                          /* null = 그대로 둔다 */

    /* p3 대기는 유형(?t=)을 잃으면 엠블럼이 바뀐다 — 지금 창의 값을 이어 붙인다 */
    if (target === "p3-wait.html") {
      const t = new URLSearchParams(location.search).get("t");
      if (t !== null) target += "?t=" + t;
    }
    /* 이미 그 화면이면 옮기지 않는다 — 옮기면 ?n= 같은 주소 값이 떨어진다.
       다만 P8 → P9(?v=9)처럼 같은 파일 안에서 갈리는 자리는 주소까지 견준다 */
    const [file, query] = target.split("?");
    if (file === here && (!query || location.search === "?" + query)) return;
    location.replace(target);
  }

  function arrive(n) {
    subs.forEach(fn => fn(n));
    follow(n);
  }

  if (ch) ch.onmessage = e => arrive(+e.data);
  window.addEventListener("storage", e => { if (e.key === KEY) arrive(read()); });

  window.Bus = {
    press: read,
    /* 진행자 화면만 부른다 */
    set(n) { localStorage.setItem(KEY, String(n)); if (ch) ch.postMessage(n); subs.forEach(fn => fn(n)); },
    onChange(fn) { subs.push(fn); },
    screenAt: n => SCREEN[n] || SCREEN[0],
    role,
  };

  /* 창을 늦게 열었어도 지금 단계로 맞춰 놓는다 */
  if (role === "screen" || role === "phone") follow(read());
})();
