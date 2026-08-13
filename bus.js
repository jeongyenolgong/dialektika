/* ─────────────────────────────────────────────────────────────────────────
   bus.js — 모두가 같은 장부 한 권을 본다

   **장부(book)** — 지금 판의 전부. 진행자 화면만 적고, 나머지는 읽기만 한다.
       { press: 0~7, players: [ {id, name, type, code} ] }
   **말(say)** — 스쳐 지나가는 한마디. 누구나 보낸다. 장부에 남지 않는다.
       {join:{id}} · {name:{id, name}}
   폰은 「나를 넣어 주세요」라고 말하고, **진행자 화면이 받아 적어 장부에 올린다.**
   유형 배정과 개인 코드가 한 곳에서 나와야 팀이 고르게 갈린다 (SSOT 2.1 · 5.5).

   ⭐ 장부를 어디에 두느냐가 셋이고 **스스로 고른다** (SSOT 2.4)
     ① 노트북       `server.py`가 켜져 있을 때. 인터넷 없이 돈다. 워크숍 당일용
     ② 인터넷 중계   그 밖의 모든 경우. 각자 어디서 접속하든, LTE여도 된다
     ③ 혼자         둘 다 안 닿을 때. 브라우저 한 대 안에서만

   화면 대응표(8.1)는 이 파일 한 곳에만 있다. 흩어 두면 어긋난다.
   ───────────────────────────────────────────────────────────────────────── */
(() => {
  const BUILD  = "260813-11";     /* 화면마다 조작줄에 뜹니다 — 폰이 옛 것을 물고 있는지 가릅니다 */
  const K_BOOK = "dlk.book", K_SAY = "dlk.say";
  const ROOM   = new URLSearchParams(location.search).get("room") || "nolgong";
  const BROKER = "wss://broker.emqx.io:8084/mqtt";
  const T_BOOK = `dialektika/${ROOM}/book`;
  const T_SAY  = `dialektika/${ROOM}/say`;

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

  const TYPE_NAMES = ["CULTURE VANGUARD", "CREATIVE RISK-TAKERS", "RELENTLESS INNOVATORS"];
  const here = location.pathname.split("/").pop() || "index.html";
  const role =
      here.startsWith("screen-")  ? "screen"
    : here === "host.html"        ? "host"
    : here === "reconnect.html"   ? null   /* 재접속은 코드부터 받는 화면이라 끌고 가지 않는다 */
    : /^p\d/.test(here)           ? "phone"
    : null;

  /* ⭐ 목업 전용 조작줄은 **폰에서만** 감춥니다 — 참가자가 보는 화면입니다.
     진행자 화면과 스크린은 그대로 둡니다(진행자가 계기판으로 씁니다).
     내가 검사할 때는 주소에 ?dev=1 을 붙여 다시 꺼냅니다.               */
  if (/^(p\d|reconnect)/.test(here) && !new URLSearchParams(location.search).get("dev")) {
    const css = document.createElement("style");
    css.textContent = ".ctl{display:none !important}";
    (document.head || document.documentElement).appendChild(css);
  }

  let book = { press: 0, players: [] };
  const outbox = [];                            /* 아직 장부에서 확인 못 한 말들 */
  const drop = it => { const i = outbox.indexOf(it); if (i >= 0) outbox.splice(i, 1); };
  const onBook = [], onPress = [], onSay = [];
  let mode = "찾는 중";

  /* ── 내 자리에서 지금 눌림 수에 맞는 화면으로 옮긴다 ───────────────── */
  function follow(n) {
    const table = role === "screen" ? SCREEN : role === "phone" ? PHONE : null;
    if (!table) return;
    let target = table[n];
    /* ⭐ 새 판이 열리면(누름 0) 뒷단계에 있던 폰은 처음 화면으로 돌아옵니다.
       판 번호를 못 봤어도 장부만 보고 판단하므로 놓치지 않습니다.
       ⛔대기 화면(P3)은 빼야 합니다 — 입장 중에 거기서 기다리는 게 정상입니다 */
    if (n === 0 && role === "phone" &&
        ["p4p5-collect.html", "p6-create.html", "p8p9-vote-result.html"].includes(here)) {
      target = "p1-identity.html";
    }
    if (!target) return;                          /* 그대로 둔다 */

    const now = new URLSearchParams(location.search);
    const url = new URL(target, location.href);

    /* ⭐ 화면을 옮길 때 떨어지면 안 되는 값 둘.
       room — 떨어지면 그 기기만 다른 장부를 보게 된다
       t    — p3 대기가 유형을 잃으면 엠블럼이 바뀐다                        */
    ["room", "t", "me", "dev"].forEach(k => {
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

  let lastGen = null;
  function gotBook(next) {
    if (!next || typeof next !== "object") return;
    /* ⭐ 진행자가 「종료」를 누르면 판 번호가 오릅니다 — 폰은 처음 화면으로 */
    if (typeof next.gen === "number") {
      if (lastGen !== null && next.gen !== lastGen && role === "phone") {
        try { localStorage.removeItem("dlk.pairs." + window.Bus.me()); } catch (e) {}
        lastGen = next.gen;
        return window.Bus.go("p1-identity.html");
      }
      lastGen = next.gen;
    }
    const before = book.press;
    book = { press: 0, players: [], ...next };
    outbox.slice().forEach(it => { try { if (it.isDone(book)) drop(it); } catch (e) {} });
    onBook.forEach(fn => fn(book));
    if (book.press !== before) {
      onPress.forEach(fn => fn(book.press));
      follow(book.press);
    }
  }
  const gotSay = msg => onSay.forEach(fn => fn(msg));

  /* ── 밖으로 내보내는 통로. 길이 정해지기 전에 부르면 담아 뒀다 보낸다 ── */
  let out = null;
  const waiting = [];
  const settle = (name, channel) => {
    mode = name; out = channel;
    waiting.splice(0).forEach(([kind, data]) => out[kind](data));
    onBook.forEach(fn => fn(book));            /* 길이 정해졌으니 화면에 지금 판을 한 번 준다 */
  };
  const push = (kind, data) => out ? out[kind](data) : waiting.push([kind, data]);

  window.Bus = {
    /* 읽기 */
    state:  () => book,
    press:  () => book.press,
    players: () => book.players || [],
    mode:   () => mode,
    build:  BUILD,
    room:   ROOM,
    role,

    /* 적기 — 진행자 화면만 */
    publish(patch) {
      book = { ...book, ...patch };
      onBook.forEach(fn => fn(book));
      push("book", book);
    },
    set(n) {                                   /* 「다음」 — press만 바꾸는 짧은 이름 */
      const before = book.press;
      this.publish({ press: n });
      if (n !== before) onPress.forEach(fn => fn(n));
    },

    /* 한마디 — 누구나 */
    say(msg) { push("say", msg); },

    /* ⭐ 닿을 때까지 말한다 — 진행자 화면이 그 순간 안 듣고 있으면
       한 번 보낸 말은 소리 없이 사라집니다. 장부에 반영된 것이 보일 때까지
       3초마다 다시 말하고, 보이면 그칩니다.                              */
    sayUntil(msg, isDone) {
      const item = { msg, isDone };
      outbox.push(item);
      push("say", msg);
      if (isDone(book)) drop(item);
    },
    /* 장부에서 나를 찾는다 */
    mine(b) { const id = this.me(); return ((b || book).players || []).find(p => p.id === id); },

    /* 5.5 — 어떤 유형이 10명을 넘으면 그 유형만 1·2로 갈립니다 */
    teams(P) {
      const out = [];
      [0, 1, 2].forEach(t => {
        const mine = (P || []).filter(p => p.type === t);
        if (mine.length > 10) {
          out.push({ t, n:1, label:TYPE_NAMES[t] + " 1", members:mine.filter(p => (p.idxInType||0) % 2 === 0) });
          out.push({ t, n:2, label:TYPE_NAMES[t] + " 2", members:mine.filter(p => (p.idxInType||0) % 2 === 1) });
        } else {
          out.push({ t, n:0, label:TYPE_NAMES[t], members:mine });
        }
      });
      return out;
    },

    /* ⭐ 6.12 순위 알림 — P4·P5·P6에 같은 것이 걸립니다.
       basis: 수집이면 "got", 창작이면 "sent".
       개인은 **1·2·3위에 들었을 때 그 세 사람에게만**,
       팀은 **우리 팀 순위가 바뀌었을 때 팀원 전원에게**.               */
    watchRank(basis, onSelf, onTeam) {
      let lastSelf = 0, lastTeam = 0;
      this.onState(b => {
        const P = (b.players || []).filter(p => p.name);
        const me = this.mine(b);
        if (!me || !P.length) return;

        const ranked = [...P].sort((x, y) => (y[basis]||0) - (x[basis]||0) || (x.at||0) - (y.at||0));
        const mineNo = ranked.findIndex(p => p.id === me.id) + 1;
        /* ⛔아직 하나도 못 모은 동안의 등수는 기억하지 않습니다 —
           기억해 버리면 첫 알림이 「바뀐 적 없다」로 막힙니다 */
        if ((me[basis]||0) > 0) {
          if (mineNo >= 1 && mineNo <= 3 && mineNo !== lastSelf) onSelf(mineNo);
          lastSelf = mineNo;
        }

        const cols = this.teams(P).map(c => ({ ...c,
          avg: c.members.length ? c.members.reduce((n, m) => n + (m[basis]||0), 0) / c.members.length : 0,
          at:  Math.max(0, ...c.members.map(m => m.at || 0)) }))
          .sort((a, c) => c.avg - a.avg || a.at - c.at);
        const teamNo = cols.findIndex(c => c.members.some(p => p.id === me.id)) + 1;
        if (teamNo > 0 && lastTeam > 0 && teamNo !== lastTeam) onTeam(cols[teamNo-1].label, lastTeam, teamNo);
        if (teamNo > 0) lastTeam = teamNo;
      });
    },

    /* 듣기 */
    onState(fn)  { onBook.push(fn); if (mode !== "찾는 중") fn(book); },
    onChange(fn) { onPress.push(fn); },
    onSay(fn)    { onSay.push(fn); },

    /* 이 폰의 이름표. 새로고침해도 같은 사람으로 남는다 (재접속의 뿌리) */
    me() {
      /* ?me= 로 박아 주면 한 노트북에서 여러 사람을 흉내 낼 수 있습니다 (검사용) */
      const forced = new URLSearchParams(location.search).get("me");
      if (forced) return forced;
      let id = localStorage.getItem("dlk.me");
      if (!id) { id = "p" + Math.random().toString(36).slice(2, 9); localStorage.setItem("dlk.me", id); }
      return id;
    },
    /* 화면을 옮긴다 — room을 떨어뜨리지 않는 유일한 통로 */
    go(file, params) {
      const url = new URL(file, location.href);
      Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
      if (ROOM !== "nolgong") url.searchParams.set("room", ROOM);
      const forced = new URLSearchParams(location.search).get("me");
      if (forced) url.searchParams.set("me", forced);
      location.replace(url.pathname.split("/").pop() + url.search);
    },

    /* 「스크린」 버튼이 새 창을 열 때 — room을 떨어뜨리면 그 창만 다른 장부를 본다 */
    screenAt(n) {
      const url = new URL(SCREEN[n] || SCREEN[0], location.href);
      if (ROOM !== "nolgong") url.searchParams.set("room", ROOM);
      return url.pathname.split("/").pop() + url.search;
    },
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
        let env; try { env = JSON.parse(e.data); } catch (err) { return; }
        if (env.book) gotBook(env.book);
        if (env.say)  gotSay(env.say);
        if (first) { first = false; ok(); }
      };
      es.onerror = () => { if (first) { clearTimeout(giveUp); es.close(); no(); } };
    });
  }
  const laptopChannel = {
    book: b => fetch("book", { method: "POST", body: JSON.stringify(b) }),
    say:  m => fetch("say",  { method: "POST", body: JSON.stringify(m) }),
  };

  /* ── ② 인터넷 중계 (계정 없이 쓰는 공개 중계기) ───────────────────── */
  function loadMqtt() {
    return new Promise((ok, no) => {
      if (window.mqtt) return ok();
      const s = document.createElement("script");
      s.src = "mqtt.min.js?b=260813-11"; s.onload = () => ok(); s.onerror = no;
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
        c.subscribe([T_BOOK, T_SAY], { qos: 1 });
        ok({
          /* 남겨 두고 보내므로(retain) 늦게 들어온 폰도 지금 판을 곧바로 받는다 */
          book: b => c.publish(T_BOOK, JSON.stringify(b), { qos: 0, retain: true }),
          say:  m => c.publish(T_SAY,  JSON.stringify(m), { qos: 1 }),
        });
      });
      c.on("message", (topic, buf) => {
        let d; try { d = JSON.parse(buf.toString()); } catch (e) { return; }
        topic === T_BOOK ? gotBook(d) : gotSay(d);
      });
      c.on("error", () => {});
    }));
  }

  /* ── ③ 혼자 — 브라우저 한 대 안에서만 ────────────────────────────── */
  function alone() {
    addEventListener("storage", e => {
      if (e.key === K_BOOK && e.newValue) { try { gotBook(JSON.parse(e.newValue)); } catch (x) {} }
      if (e.key === K_SAY  && e.newValue) { try { gotSay(JSON.parse(e.newValue).msg); } catch (x) {} }
    });
    try { gotBook(JSON.parse(localStorage.getItem(K_BOOK))); } catch (e) {}
    settle("혼자", {
      book: b => localStorage.setItem(K_BOOK, JSON.stringify(b)),
      /* 같은 값을 두 번 넣으면 storage 이벤트가 안 뜨므로 번호를 붙인다 */
      say:  m => localStorage.setItem(K_SAY, JSON.stringify({ n: Math.random(), msg: m })),
    });
    follow(book.press);
  }

  /* 3초마다 아직 확인 안 된 말을 다시 보냅니다 */
  setInterval(() => outbox.forEach(it => push("say", it.msg)), 3000);

  tryLaptop()
    .then(() => settle("노트북", laptopChannel))
    .catch(() => tryRelay()
      .then(ch => settle("인터넷 중계", ch))
      .catch(() => alone()));
})();
