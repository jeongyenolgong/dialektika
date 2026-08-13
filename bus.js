/* ─────────────────────────────────────────────────────────────────────────
   bus.js — 모두가 같은 장부 한 권을 본다

   장부에 적히는 것은 지금 **「다음」을 몇 번 눌렀나** 하나뿐이다 (0 ~ 7).
   진행자가 「다음」을 누르면 장부가 바뀌고, 그 장부를 보고 있는 모든 기기가
   제 자리에 맞는 화면으로 옮겨 간다.

   ⭐ 장부를 어디에 두느냐가 셋이고, **스스로 고른다.**

     ① 노트북       `server.py`가 켜져 있으면 그 노트북이 장부를 든다.
                    인터넷이 없어도 돌아간다. **워크숍 당일에 쓰는 길이다.**
                    폰은 노트북과 같은 와이파이여야 한다.
     ② 인터넷 중계   그 밖의 모든 경우(깃헙 링크 포함). 각자 어디서 접속하든,
                    **누가 LTE를 쓰든 상관없다.** 계정도 가입도 없다.
     ③ 혼자         둘 다 닿지 않을 때. 브라우저 한 대 안에서만 돈다.

   대응표는 SSOT 8.1 「다음 여섯 번과 종료 한 번」을 그대로 옮긴 것이고,
   **이 파일 한 곳에만 있다.** 화면마다 흩어 두면 어긋난다.
   ───────────────────────────────────────────────────────────────────────── */
(() => {
  const KEY    = "dlk.press";
  const ROOM   = new URLSearchParams(location.search).get("room") || "nolgong";
  const TOPIC  = `dialektika/${ROOM}/state`;
  const BROKER = "wss://broker.emqx.io:8084/mqtt";

  /* SSOT 8.1 표 — 누름 0(아직 안 누름) ~ 7(종료) */
  const SCREEN = [
    "screen-01-entry.html",     /* 0 · 입장 중 */
    "screen-02-collect.html",   /* 1 · 수집 시작 */
    null,                       /* 2 · 수집 종료 — 방금 끝난 판을 그대로 멈춰 둔다 */
    "screen-03-create.html",    /* 3 · 창작 시작 */
    null,                       /* 4 · 창작 종료 — 위와 같다 */
    "screen-04-vote.html",      /* 5 · 투표 시작 */
    "screen-05-result.html",    /* 6 · 투표 종료 + 결과 발표 */
    null,                       /* 7 · 종료 */
  ];
  const PHONE = [
    null,                          /* 0 · P1→P2→P3를 참가자가 스스로 밟는 중이라 안 건드린다 */
    "p4p5-collect.html",           /* 1 · P4 ⇄ P5 */
    "p3-wait.html",                /* 2 · 대기② */
    "p6-create.html",              /* 3 · P6 */
    "p3-wait.html",                /* 4 · 대기③ */
    "p8p9-vote-result.html",       /* 5 · P8 */
    "p8p9-vote-result.html?v=9",   /* 6 · P9 */
    null,                          /* 7 · 종료 */
  ];

  const here = location.pathname.split("/").pop() || "index.html";
  const role =
      here.startsWith("screen-")  ? "screen"
    : here === "host.html"        ? "host"
    : here === "reconnect.html"   ? null   /* 재접속은 코드부터 받는 화면이라 끌고 가지 않는다 */
    : /^p\d/.test(here)           ? "phone"
    : null;

  const subs  = [];
  let   press = 0;
  let   mode  = "찾는 중";

  /* ── 내 자리에서 지금 눌림 수에 맞는 화면으로 옮긴다 ───────────────── */
  function follow(n) {
    const table = role === "screen" ? SCREEN : role === "phone" ? PHONE : null;
    if (!table) return;
    const target = table[n];
    if (!target) return;                          /* 그대로 둔다 */

    const now = new URLSearchParams(location.search);
    const url = new URL(target, location.href);

    /* ⭐ 화면을 옮길 때 떨어지면 안 되는 값 둘.
       room — 떨어지면 그 기기만 다른 장부를 보게 된다 (테스트 판이 갈린다)
       t    — p3 대기가 유형을 잃으면 엠블럼이 바뀐다                        */
    ["room", "t"].forEach(k => {
      if (now.get(k) !== null && !url.searchParams.has(k)) url.searchParams.set(k, now.get(k));
    });

    /* 이미 그 화면이면 옮기지 않는다 — 옮기면 ?n= 같은 값이 떨어진다.
       다만 P8 → P9(?v=9)처럼 같은 파일 안에서 갈리는 자리는 주소까지 견준다 */
    const file = url.pathname.split("/").pop();
    if (file === here) {
      let same = true;
      url.searchParams.forEach((v, k) => { if (now.get(k) !== v) same = false; });
      if (same) return;
    }
    location.replace(file + url.search);
  }

  function arrive(next) {
    if (!next || typeof next.press !== "number" || next.press === press) return;
    press = next.press;
    subs.forEach(fn => fn(press));
    follow(press);
  }

  /* ── 밖으로 내보내는 통로. 길이 정해지기 전에 누르면 담아 뒀다 보낸다 ── */
  let send = null;
  const waiting = [];
  const settle = (name, fn) => {
    mode = name; send = fn;
    waiting.splice(0).forEach(fn);
    subs.forEach(s => s(press));
  };

  window.Bus = {
    press: () => press,
    /* 진행자 화면이 「다음」을 누를 때 부른다 */
    set(n) {
      press = n;
      subs.forEach(fn => fn(n));
      const packet = { press: n };
      send ? send(packet) : waiting.push(packet);
    },
    onChange(fn) { subs.push(fn); },
    /* 「스크린」 버튼이 새 창을 열 때 쓴다 — room을 떨어뜨리면 그 창만 다른 장부를 본다 */
    screenAt(n) {
      const url = new URL(SCREEN[n] || SCREEN[0], location.href);
      const room = new URLSearchParams(location.search).get("room");
      if (room) url.searchParams.set("room", room);
      return url.pathname.split("/").pop() + url.search;
    },
    mode: () => mode,
    room: ROOM,
    role,
  };

  /* ── ① 노트북 (server.py) ────────────────────────────────────────── */
  function tryLaptop() {
    return new Promise((ok, no) => {
      let es;
      try { es = new EventSource("events"); } catch (e) { return no(); }
      const giveUp = setTimeout(() => { es.close(); no(); }, 2500);
      let first = true;
      es.onmessage = e => {
        clearTimeout(giveUp);
        try { arrive(JSON.parse(e.data)); } catch (err) {}
        if (first) { first = false; ok(); }       /* 장부가 한 번 왔으면 이 길이 살아 있다 */
      };
      es.onerror = () => { if (first) { clearTimeout(giveUp); es.close(); no(); } };
    });
  }

  /* ── ② 인터넷 중계 (계정 없이 쓰는 공개 중계기) ───────────────────── */
  function loadMqtt() {
    return new Promise((ok, no) => {
      if (window.mqtt) return ok();
      const s = document.createElement("script");
      s.src = "mqtt.min.js"; s.onload = () => ok(); s.onerror = no;
      document.head.appendChild(s);
    });
  }

  function tryRelay() {
    return loadMqtt().then(() => new Promise((ok, no) => {
      const c = mqtt.connect(BROKER, {
        clientId: "dlk_" + Math.random().toString(16).slice(2, 10),
        connectTimeout: 8000, reconnectPeriod: 3000, clean: true,
      });
      const giveUp = setTimeout(() => { c.end(true); no(); }, 12000);
      c.on("connect", () => {
        clearTimeout(giveUp);
        c.subscribe(TOPIC, { qos: 0 });
        /* 남겨 두고 보내므로(retain) 늦게 들어온 폰도 지금 판을 곧바로 받는다 */
        ok(packet => c.publish(TOPIC, JSON.stringify(packet), { qos: 0, retain: true }));
      });
      c.on("message", (_, buf) => { try { arrive(JSON.parse(buf.toString())); } catch (e) {} });
      c.on("error", () => {});
    }));
  }

  /* ── ③ 혼자 — 브라우저 한 대 안에서만 ────────────────────────────── */
  function alone() {
    const read = () => { const v = parseInt(localStorage.getItem(KEY), 10); return isNaN(v) ? 0 : v; };
    addEventListener("storage", e => { if (e.key === KEY) arrive({ press: read() }); });
    press = read();
    settle("혼자", p => localStorage.setItem(KEY, String(p.press)));
    follow(press);
  }

  tryLaptop()
    .then(() => settle("노트북", p => fetch("state", { method: "POST", body: JSON.stringify(p) })))
    .catch(() => tryRelay()
      .then(pub => settle("인터넷 중계", pub))
      .catch(() => alone()));
})();
