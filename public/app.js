/* Who Does What - a shared calendar and task divider.
 *
 * The board is one JSON document. Every change is an op applied to that
 * document, so a save that loses a race can simply replay its own ops on top
 * of whichever version won. Ops are the only thing that mutates state.
 */
(function () {
  "use strict";

  var MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  var MON_S  = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  var DAY_S  = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  var SLOTS  = ["p1","p2","p3","p4","p5","p6"];

  var HOUR_PX = 48;            // must match --hh in app.css
  var STEP    = 30;            // minutes per slot in the week grid
  var SNAP    = 15;            // minutes a resize snaps to
  var DEFAULT_MINS = 60;

  var SEED = { v: 1, people: [], tasks: [], seq: 0 };

  /* ---------- which board ---------- */
  var boardName = (new URLSearchParams(location.search).get("board") || "main")
    .toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40) || "main";
  var API = "/api/board?board=" + encodeURIComponent(boardName);
  var LS_KEY = "wdw:" + boardName;

  /* ---------- state ---------- */
  var state = JSON.parse(JSON.stringify(SEED));
  var mode = "local";          // "local" until the API reports a store is connected
  var rev = 0;                 // server revision this page last saw
  var queued = [];             // ops not yet stored, replayed if a save conflicts
  var saveTimer = null, saving = false, saveState = "idle", lastSaved = "", deferSince = 0;
  var msg = "";

  var view = { scale: "month", month: null, anchor: null, aim: null, aimTime: null,
               held: null, scroll: null, menu: null };
  try {
    var savedView = JSON.parse(sessionStorage.getItem("wdw-view:" + boardName) || "null");
    if (savedView) {
      view.month = savedView.month || null;
      view.aim = savedView.aim || null;
      view.aimTime = savedView.aimTime || null;
      view.anchor = savedView.anchor || null;
      if (savedView.scale === "week") view.scale = "week";
      if (typeof savedView.scroll === "number") view.scroll = savedView.scroll;
    }
  } catch (e) {}
  function saveView() {
    try {
      sessionStorage.setItem("wdw-view:" + boardName, JSON.stringify({
        scale: view.scale, month: view.month, anchor: view.anchor,
        aim: view.aim, aimTime: view.aimTime, scroll: view.scroll
      }));
    } catch (e) {}
  }

  /* ---------- helpers ---------- */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;";
    });
  }
  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function isoOf(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function today() { return isoOf(new Date()); }
  function parseIso(s) { var p = s.split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function pretty(s) { var d = parseIso(s); return DAY_S[d.getDay()] + " " + d.getDate() + " " + MON_S[d.getMonth()]; }
  function clock() { return new Date().toTimeString().slice(0, 5); }
  function uid() { state.seq = (state.seq || 0) + 1; return "t" + Date.now().toString(36) + state.seq.toString(36); }

  /* ---------- times ---------- */
  function mins(hm) { return hm ? (+hm.slice(0, 2)) * 60 + (+hm.slice(3, 5)) : 0; }
  function hhmm(m) { m = (m % 1440 + 1440) % 1440; return pad(Math.floor(m / 60)) + ":" + pad(m % 60); }
  function fmtT(hm, compact) {
    var m = mins(hm), h = Math.floor(m / 60), mi = m % 60;
    var ap = h < 12 ? "am" : "pm", h12 = (h % 12) === 0 ? 12 : h % 12;
    var body = h12 + (mi ? ":" + pad(mi) : "");
    return compact ? body + ap : body + " " + ap.toUpperCase();
  }
  function taskMins(t) { return Math.max(SNAP, t.mins || DEFAULT_MINS); }
  function prettyWhen(day, time) {
    if (!day) return "Unscheduled";
    return pretty(day) + (time ? ", " + fmtT(time) : "");
  }
  function nowMins() { var d = new Date(); return d.getHours() * 60 + d.getMinutes(); }

  function person(id) {
    for (var i = 0; i < state.people.length; i++) if (state.people[i].id === id) return state.people[i];
    return null;
  }
  function task(id) {
    for (var i = 0; i < state.tasks.length; i++) if (state.tasks[i].id === id) return state.tasks[i];
    return null;
  }
  function initials(name) {
    var parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "?";
    return (parts[0].charAt(0) + (parts[1] ? parts[1].charAt(0) : "")).toUpperCase();
  }
  function openLoad(id) {
    var n = 0;
    state.tasks.forEach(function (t) { if (t.who === id && !t.done) n++; });
    return n;
  }
  function freeSlot() {
    var used = {};
    state.people.forEach(function (p) { used[p.id] = 1; });
    for (var i = 0; i < SLOTS.length; i++) if (!used[SLOTS[i]]) return SLOTS[i];
    return null;
  }
  // timed tasks first, in clock order, then the rest in the order they were added
  function byTime(a, b) {
    if (!!a.time !== !!b.time) return a.time ? -1 : 1;
    if (a.time && a.time !== b.time) return mins(a.time) - mins(b.time);
    return 0;
  }
  function onDay(iso, timed) {
    return state.tasks.filter(function (t) {
      return t.day === iso && (timed ? !!t.time : !t.time);
    }).sort(byTime);
  }

  /* ---------- ops ---------- */
  var OPS = {
    addTask: function (o) {
      if (task(o.task.id)) return false;
      state.tasks.push(JSON.parse(JSON.stringify(o.task)));
      return true;
    },
    setTask: function (o) {
      var t = task(o.id);
      if (!t) return false;
      var changed = false;
      for (var k in o.patch) if (t[k] !== o.patch[k]) { t[k] = o.patch[k]; changed = true; }
      return changed;
    },
    delTask: function (o) {
      var before = state.tasks.length;
      state.tasks = state.tasks.filter(function (t) { return t.id !== o.id; });
      return state.tasks.length !== before;
    },
    addPerson: function (o) {
      if (person(o.person.id)) return false;
      state.people.push(JSON.parse(JSON.stringify(o.person)));
      return true;
    },
    setPerson: function (o) {
      var p = person(o.id);
      if (!p || p.name === o.name) return false;
      p.name = o.name;
      return true;
    },
    delPerson: function (o) {
      var before = state.people.length;
      state.people = state.people.filter(function (p) { return p.id !== o.id; });
      var changed = state.people.length !== before;
      state.tasks.forEach(function (t) { if (t.who === o.id) { t.who = ""; changed = true; } });
      return changed;
    }
  };

  function run(op, silent) {
    var fn = OPS[op.type];
    if (!fn) return;
    fn(op);
    queued.push(op);
    if (!silent) render();
    scheduleSave();
  }
  function runMany(ops) {
    ops.forEach(function (op) {
      var fn = OPS[op.type];
      if (fn) { fn(op); queued.push(op); }
    });
    render();
    scheduleSave();
  }

  /* ---------- storage ---------- */
  function setSave(s) {
    saveState = s;
    var el = document.querySelector(".save");
    if (el) { el.setAttribute("data-state", s); el.textContent = saveLabel(); }
  }
  function saveLabel() {
    if (mode === "local") return "On this device";
    if (saveState === "saving") return "Saving…";
    if (saveState === "error") return "Not saved";
    return lastSaved ? "Saved " + lastSaved : "Shared board";
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    setSave("saving");
    saveTimer = setTimeout(flush, 700);
  }

  function flush() {
    if (saving || !queued.length) return;

    if (mode === "local") {
      try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) {}
      queued = [];
      lastSaved = clock();
      setSave("idle");
      return;
    }

    saving = true;
    setSave("saving");
    var sending = queued.slice();

    fetch(API, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rev: rev, state: state })
    }).then(function (res) {
      return res.json().then(function (body) { return { status: res.status, body: body }; });
    }).then(function (r) {
      saving = false;

      if (r.status === 200) {
        rev = r.body.rev;
        queued = queued.slice(sending.length);
        lastSaved = clock();
        setSave(queued.length ? "saving" : "idle");
        if (queued.length) scheduleSave();
        return;
      }

      if (r.status === 409) {
        // Someone saved first. Take their board and replay our own edits on it.
        rev = r.body.rev;
        if (r.body.state) state = r.body.state;
        queued.forEach(function (op) { var fn = OPS[op.type]; if (fn) fn(op); });
        render();
        scheduleSave();
        return;
      }

      setSave("error");
      say("Could not save: " + ((r.body && r.body.error) || r.status) + ". Your changes are still on this screen.");
    }).catch(function () {
      saving = false;
      setSave("error");
      say("Cannot reach the server. Your changes are still on this screen and will be sent when it comes back.");
      saveTimer = setTimeout(flush, 5000);
    });
  }

  // Pick up other people's changes.
  function poll() {
    if (mode !== "server" || saving || queued.length) return;
    var ae = document.activeElement;
    if (ae && ae.isContentEditable) return;   // never yank text out from under someone
    if (dragging) return;                     // nor out from under a resize

    fetch(API, { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j.configured || j.rev === rev) return;
      rev = j.rev;
      if (j.state) state = j.state;
      render();
    }).catch(function () {});
  }

  /* ---------- rendering: the month ---------- */
  function monthGrid(ym) {
    var y = +ym.slice(0, 4), m = +ym.slice(5, 7) - 1;
    var first = new Date(y, m, 1);
    var lead = (first.getDay() + 6) % 7;               // weeks start on Monday
    var start = new Date(y, m, 1 - lead);
    var last = new Date(y, m + 1, 0);
    var weeks = Math.ceil((lead + last.getDate()) / 7);
    var tod = today(), out = [], byDay = {};

    state.tasks.forEach(function (t) {
      if (!t.day) return;
      (byDay[t.day] = byDay[t.day] || []).push(t);
    });

    for (var i = 0; i < weeks * 7; i++) {
      var d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      var iso = isoOf(d);
      out.push(
        '<div class="cell" data-date="' + iso + '" data-out="' + (d.getMonth() === m ? "0" : "1") + '"'
        + (iso === tod ? ' data-today="1"' : "")
        + (iso === view.aim ? ' data-aim="1"' : "")
        + '><button class="dnum" type="button" data-week="' + iso + '" aria-label="Open the week of ' + pretty(iso) + '">'
        + d.getDate() + "</button>"
        + '<ul class="tasks">'
        + (byDay[iso] || []).sort(byTime).map(function (t) { return chip(t, true); }).join("")
        + "</ul></div>"
      );
    }
    return out.join("");
  }

  // The badge on a task: whose it is, and the way to hand it to somebody else.
  function whoButton(t, label) {
    var open = view.menu && view.menu.id === t.id;
    var name = t.who ? (person(t.who) || {}).name : null;
    return '<button class="who" type="button" aria-haspopup="true" aria-expanded="' + (open ? "true" : "false") + '"'
      + ' aria-label="' + esc(name ? name + " has this. Hand it to someone else" : "Nobody has this yet. Choose who does it") + '">'
      + esc(label) + "</button>";
  }

  // Anchored to the badge and fixed to the window, so nothing clips it - not the
  // week grid's scroller, not an event box with its own overflow.
  function whoMenu() {
    if (!view.menu) return "";
    var t = task(view.menu.id);
    if (!t) return "";
    var row = function (id, name, count) {
      return '<li><button type="button" data-assign="' + id + '" data-c="' + id + '"'
        + ((t.who || "") === id ? ' data-on="1"' : "") + ">"
        + '<span class="swatch"></span><span class="nm">' + esc(name) + "</span>"
        + (count === null ? "" : '<span class="load">' + count + "</span>")
        + "</button></li>";
    };
    return '<div class="whomenu" style="left:' + view.menu.x + "px;top:" + view.menu.y + 'px">'
      + '<span class="lbl">Who does “' + esc(t.title) + "”</span>"
      + "<ul>"
      +   state.people.map(function (p) { return row(p.id, p.name, openLoad(p.id)); }).join("")
      +   row("", "Nobody yet", null)
      + "</ul></div>";
  }

  // Keep it on screen when the task is near an edge.
  function fitMenu() {
    var m = document.querySelector(".whomenu");
    if (!m || !view.menu) return;
    var r = m.getBoundingClientRect();
    if (!r.width) return;                                  // no layout to work with
    var w = window.innerWidth, h = window.innerHeight;
    if (r.right > w - 8) m.style.left = Math.max(8, w - 8 - r.width) + "px";
    if (r.bottom > h - 8) m.style.top = Math.max(8, view.menu.y - r.height - 26) + "px";
  }

  function chip(t, withTime) {
    var who = t.who || "";
    var label = who ? initials((person(who) || {}).name) : "+";
    return '<li class="task" data-id="' + t.id + '" data-who="' + who + '" data-done="' + (t.done ? "1" : "0") + '"'
      + (view.held === t.id ? ' data-held="1"' : "")
      + ' draggable="true">'
      + '<button class="grip" type="button" aria-label="Pick up task">⠿</button>'
      + '<button class="dot" type="button" aria-label="' + (t.done ? "Mark as not done" : "Mark done") + '"></button>'
      + (withTime && t.time ? '<span class="at">' + esc(fmtT(t.time, true)) + "</span>" : "")
      + '<span class="ttl" contenteditable="true" draggable="false">' + esc(t.title) + "</span>"
      + whoButton(t, label)
      + '<button class="del" type="button" aria-label="Delete task">×</button>'
      + "</li>";
  }

  /* ---------- rendering: the week, hour by hour ---------- */
  function weekDays(anchor) {
    var d = parseIso(anchor || today());
    var lead = (d.getDay() + 6) % 7;
    var start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - lead);
    var out = [];
    for (var i = 0; i < 7; i++) out.push(isoOf(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)));
    return out;
  }

  // Anything that overlaps shares the width, side by side, the way a calendar does it.
  function lay(list) {
    var out = [], cluster = [], end = -1;
    function flush() {
      if (!cluster.length) return;
      var cols = [];
      cluster.forEach(function (it) {
        for (var c = 0; c < cols.length; c++) {
          if (cols[c] <= it.s) { it.col = c; cols[c] = it.e; return; }
        }
        it.col = cols.length;
        cols.push(it.e);
      });
      cluster.forEach(function (it) { it.cols = cols.length; });
      out = out.concat(cluster);
      cluster = []; end = -1;
    }
    list.forEach(function (t) {
      var it = { t: t, s: mins(t.time), e: mins(t.time) + taskMins(t) };
      if (cluster.length && it.s >= end) flush();
      cluster.push(it);
      end = Math.max(end, it.e);
    });
    flush();
    return out;
  }

  function ev(it) {
    var t = it.t, who = t.who || "";
    var label = who ? initials((person(who) || {}).name) : "+";
    var top = it.s / 60 * HOUR_PX;
    var h = Math.max((it.e - it.s) / 60 * HOUR_PX, 17);
    var w = 100 / it.cols;
    var span = fmtT(t.time, true) + " – " + fmtT(hhmm(it.e), true);
    return '<div class="task ev" data-id="' + t.id + '" data-who="' + who + '" data-done="' + (t.done ? "1" : "0") + '"'
      + (view.held === t.id ? ' data-held="1"' : "")
      + (it.e - it.s < 45 ? ' data-short="1"' : "")
      + ' draggable="true" style="top:' + top + "px;height:" + h + "px;left:" + (it.col * w) + "%;width:" + w + '%">'
      + '<button class="grip" type="button" aria-label="Pick up task">⠿</button>'
      + '<button class="dot" type="button" aria-label="' + (t.done ? "Mark as not done" : "Mark done") + '"></button>'
      + '<span class="ttl" contenteditable="true" draggable="false">' + esc(t.title) + "</span>"
      + '<span class="at">' + esc(span) + "</span>"
      + whoButton(t, label)
      + '<button class="del" type="button" aria-label="Delete task">×</button>'
      + '<span class="rsz" data-rsz="' + t.id + '" title="Drag to change how long it takes"></span>'
      + "</div>";
  }

  function dayCol(iso) {
    var s = "";
    for (var m = 0; m < 1440; m += STEP) {
      var hm = hhmm(m);
      s += '<div class="slot"' + (m % 60 ? ' data-half="1"' : "")
        + ' data-date="' + iso + '" data-time="' + hm + '"'
        + (view.aim === iso && view.aimTime === hm ? ' data-aim="1"' : "") + "></div>";
    }
    return '<div class="daycol" data-date="' + iso + '"' + (iso === today() ? ' data-today="1"' : "") + ">"
      + s + lay(onDay(iso, true)).map(ev).join("") + "</div>";
  }

  function weekGrid() {
    var days = weekDays(view.anchor), tod = today();

    var head = '<div class="wk-head"><div class="gut"></div>'
      + days.map(function (iso) {
          var d = parseIso(iso);
          return '<div class="wk-day"' + (iso === tod ? ' data-today="1"' : "") + ' data-date="' + iso + '">'
            + '<span class="wd">' + DAY_S[d.getDay()] + "</span>"
            + '<span class="wdn">' + d.getDate() + "</span></div>";
        }).join("") + "</div>";

    var allday = '<div class="wk-allday"><div class="gut"><span class="lbl">All day</span></div>'
      + days.map(function (iso) {
          return '<div class="ad-col" data-date="' + iso + '"'
            + (view.aim === iso && !view.aimTime ? ' data-aim="1"' : "") + ">"
            + '<ul class="tasks">' + onDay(iso, false).map(function (t) { return chip(t); }).join("")
            + "</ul></div>";
        }).join("") + "</div>";

    var hours = '<div class="gut hours">';
    for (var h = 0; h < 24; h++) {
      hours += '<div class="hr">' + (h ? "<span>" + fmtT(pad(h) + ":00") + "</span>" : "") + "</div>";
    }
    hours += "</div>";

    var now = "";
    if (days.indexOf(tod) > -1) {
      now = '<div class="nowline" style="top:' + Math.round(nowMins() / 60 * HOUR_PX * 10) / 10 + "px;--col:" + days.indexOf(tod) + '">'
          + '<span class="nowdot"></span></div>';
    }

    return '<div class="week">' + head + allday
      + '<div class="wk-body"><div class="wk-cols">' + hours + days.map(dayCol).join("") + now + "</div></div>"
      + "</div>";
  }

  function heading() {
    if (view.scale === "month") {
      return MONTHS[+view.month.slice(5, 7) - 1] + ' <span class="yr">' + view.month.slice(0, 4) + "</span>";
    }
    var days = weekDays(view.anchor);
    var a = parseIso(days[0]), b = parseIso(days[6]);
    var left = a.getDate() + (a.getMonth() === b.getMonth() ? "" : " " + MON_S[a.getMonth()]);
    return left + " – " + b.getDate() + " " + MON_S[b.getMonth()]
      + ' <span class="yr">' + b.getFullYear() + "</span>";
  }

  function render() {
    if (!view.month) view.month = today().slice(0, 7);
    if (!view.anchor) view.anchor = today();
    var week = view.scale === "week";
    var inbox = state.tasks.filter(function (t) { return !t.day; });
    var done = state.tasks.filter(function (t) { return t.done; }).length;
    var un = state.tasks.filter(function (t) { return !t.who && !t.done; }).length;

    var html = '<div class="wrap">'
      + '<header class="top">'
      +   "<h1>Who Does What</h1>"
      +   '<p class="tag">One shared board. Add the work, split it across the crew, drop it on a day and an hour.</p>'
      +   '<div class="right">'
      +     '<span class="sum">' + (state.tasks.length
              ? state.tasks.length + " tasks · " + done + " done · " + un + " unassigned"
              : "No tasks yet") + "</span>"
      +     '<span class="save" data-state="' + saveState + '">' + esc(saveLabel()) + "</span>"
      +   "</div>"
      + "</header>";

    if (mode === "local") {
      html += '<p class="warn">This board is saving to this browser only, so nobody else can see it. '
            + "Connect a KV store on Vercel to share it with the crew - the README has the two steps.</p>";
    }

    html += '<div class="layout"><div class="months-col">'
      + '<div class="monthbar">'
      +   '<button class="nav" type="button" data-nav="-1" aria-label="' + (week ? "Previous week" : "Previous month") + '">‹</button>'
      +   '<button class="nav" type="button" data-nav="1" aria-label="' + (week ? "Next week" : "Next month") + '">›</button>'
      +   "<h2>" + heading() + "</h2>"
      +   '<button class="today" type="button" data-nav="0">Today</button>'
      +   '<div class="scale" role="group" aria-label="Calendar scale">'
      +     '<button type="button" data-scale="month"' + (week ? "" : ' data-on="1"') + ">Month</button>"
      +     '<button type="button" data-scale="week"' + (week ? ' data-on="1"' : "") + ">Week</button>"
      +   "</div>"
      +   '<span class="hint">' + (week
              ? "Click a time slot to aim new tasks at it"
              : "Click a day to aim at it, or a date to open its week") + "</span>"
      + "</div>";

    html += week
      ? '<div class="months">' + weekGrid() + "</div>"
      : '<div class="months">'
        + '<div class="dow"><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span><span>Sun</span></div>'
        + '<div class="grid">' + monthGrid(view.month) + "</div></div>";

    html += "</div>";

    html += '<aside class="rail">'
      + '<section class="card">'
      +   '<span class="lbl">The crew</span>'
      +   '<ul class="crew">'
      +     state.people.map(function (p) {
              return '<li class="person" data-id="' + p.id + '">'
                + '<span class="swatch"></span>'
                + '<span class="name" contenteditable="true">' + esc(p.name) + "</span>"
                + '<span class="load">' + openLoad(p.id) + "</span>"
                + '<button class="del-p" type="button" aria-label="Remove this person">×</button>'
                + "</li>";
            }).join("")
      +   "</ul>"
      +   (state.people.length
              ? '<p class="empty">Tap the badge on any task to hand it over, or drop the task on a name.</p>'
              : '<p class="empty">Nobody on the board yet. Add the first name below.</p>')
      +   '<div class="mini" data-form="person"><input type="text" placeholder="Add a name" autocomplete="off"><button type="button" data-add="person">Add</button></div>'
      + "</section>"

      + '<section class="card" data-drop="inbox">'
      +   '<span class="lbl">Unscheduled</span>'
      +   '<ul class="inbox">' + inbox.map(function (t) { return chip(t); }).join("") + "</ul>"
      +   (inbox.length ? "" : '<p class="empty">Nothing waiting. Add a task below.</p>')
      +   '<div class="mini" data-form="task"><input type="text" placeholder="What needs doing?" autocomplete="off"><button type="button" data-add="task">Add</button></div>'
      +   '<p class="target-row">Goes to <b>' + esc(prettyWhen(view.aim, view.aimTime)) + "</b>"
      +     (view.aimTime ? ' <button class="unaim" type="button" data-unaim="1">drop the time</button>' : "")
      +   "</p>"
      + "</section>"

      + '<section class="card">'
      +   '<span class="lbl">Divide the work</span>'
      +   '<div class="acts">'
      +     '<button class="act primary" type="button" data-act="split">Split evenly by person<small>Hands every unassigned task to whoever is carrying the least</small></button>'
      +     '<button class="act" type="button" data-act="spread">Spread across weekdays<small>Deals the unscheduled pile onto the next ten weekdays</small></button>'
      +     '<button class="act" type="button" data-act="clear">Clear finished tasks<small>Removes everything already ticked off</small></button>'
      +   "</div>"
      +   '<span class="status">' + esc(msg) + "</span>"
      + "</section>"
      + "</aside></div>";

    html += '<footer class="note">'
          + (mode === "server"
              ? "Everyone with the link sees this board. Changes save themselves a moment after you stop, and other people's edits arrive within a few seconds. "
              : "")
          + "The scale you are on, the slot you have aimed at and the task you are holding stay yours alone."
          + (boardName === "main" ? " Add <code>?board=name</code> to the address for a second, separate board." : " You are on the <b>" + esc(boardName) + "</b> board.")
          + "</footer>" + whoMenu() + "</div>";

    document.getElementById("root").innerHTML = html;
    overEl = null;
    if (week) restoreScroll();
    fitMenu();
  }

  // The hour grid is a scroller and a re-render builds a fresh one, so put it back
  // where it was - or on the working day, if this is the first look at it.
  function restoreScroll() {
    var body = document.querySelector(".wk-body");
    if (!body) return;
    var want = view.scroll;
    if (want == null) want = Math.max(0, Math.min(nowMins() - 90, 8 * 60)) / 60 * HOUR_PX;
    try { body.scrollTop = want; } catch (e) {}
    body.addEventListener("scroll", function () { view.scroll = body.scrollTop; });
  }

  function tickNow() {
    var line = document.querySelector(".nowline");
    if (line) line.style.top = Math.round(nowMins() / 60 * HOUR_PX * 10) / 10 + "px";
  }

  function renderStatus() {
    var el = document.querySelector(".status");
    if (el) el.textContent = msg;
  }
  function say(t) { msg = t; renderStatus(); }

  /* ---------- held task, aimed slot ---------- */
  function pickUp(t) {
    var was = view.held === t.id;
    view.held = was ? null : t.id;
    render();
    say(was ? "Put back down." : "Holding “" + t.title + "”. Click a day, a time slot, or the Unscheduled box, to place it.");
  }
  // time: "HH:MM" to set one, null to clear it, undefined to leave it alone.
  function place(id, day, time, label) {
    var t = task(id);
    view.held = null;
    if (!t) { render(); return; }
    var sameTime = time === undefined || (t.time || null) === (time || null);
    if (t.day === day && sameTime) { render(); say("Already there."); return; }

    var patch = { day: day };
    if (time !== undefined) {
      patch.time = time || null;
      patch.mins = time ? taskMins(t) : null;
    }
    if (day) {
      if (view.scale === "week") view.anchor = day;
      else view.month = day.slice(0, 7);
    }
    saveView();
    run({ type: "setTask", id: id, patch: patch });
    say("Moved to " + label + ".");
  }
  // Hand a task to somebody, or to nobody. Works wherever the task is sitting.
  function assign(id, who) {
    var t = task(id);
    view.menu = null;
    view.held = null;
    if (!t) { render(); return; }
    var name = who ? (person(who) || {}).name : null;
    if ((t.who || "") === (who || "")) {
      render();
      say(name ? name + " already has “" + t.title + "”." : "“" + t.title + "” is already waiting for a name.");
      return;
    }
    run({ type: "setTask", id: t.id, patch: { who: who || "" } });
    say(name ? "“" + t.title + "” goes to " + name + "." : "“" + t.title + "” is back to nobody in particular.");
  }

  function openWho(t, btn) {
    if (view.menu && view.menu.id === t.id) { view.menu = null; render(); return; }
    if (!state.people.length) { say("Add someone to the crew first, then you can hand this to them."); return; }
    var r = btn.getBoundingClientRect ? btn.getBoundingClientRect() : { left: 0, bottom: 0 };
    view.menu = { id: t.id, x: Math.round(r.left), y: Math.round(r.bottom + 6) };
    render();
    var first = document.querySelector(".whomenu button");
    if (first) first.focus();
  }
  function aimAt(day, time) {
    var same = view.aim === day && (view.aimTime || null) === (time || null);
    view.aim = same ? null : day;
    view.aimTime = same ? null : (time || null);
    saveView(); render();
    say(view.aim ? "New tasks land on " + prettyWhen(view.aim, view.aimTime) + "." : "New tasks go to Unscheduled again.");
  }

  /* ---------- interactions (delegated, so a re-render never unhooks them) ---------- */
  document.addEventListener("click", function (e) {
    var el = e.target;
    if (!el || !el.closest) return;

    var pick = el.closest("[data-assign]");
    if (pick) { assign(view.menu ? view.menu.id : null, pick.dataset.assign); return; }

    // any click outside the open menu puts it away, then carries on as normal
    if (view.menu && !el.closest(".whomenu") && !el.closest(".who")) { view.menu = null; render(); }

    var chipEl = el.closest(".task");
    if (chipEl) {
      var t = task(chipEl.dataset.id);
      if (!t) return;
      if (el.closest(".dot")) { run({ type: "setTask", id: t.id, patch: { done: !t.done } }); return; }
      if (el.closest(".who")) { openWho(t, el.closest(".who")); return; }
      if (el.closest(".del")) {
        if (view.held === t.id) view.held = null;
        run({ type: "delTask", id: t.id });
        say("Task deleted.");
        return;
      }
      if (el.closest(".grip")) { pickUp(t); return; }
      return;
    }

    var pEl = el.closest(".person");
    if (pEl) {
      if (el.closest(".del-p")) {
        var p = person(pEl.dataset.id);
        run({ type: "delPerson", id: pEl.dataset.id });
        say((p ? p.name : "That person") + " is off the board. Their tasks are unassigned again.");
        return;
      }
      // holding a task and tapping a name hands it over, which is the phone gesture
      if (view.held) { assign(view.held, pEl.dataset.id); return; }
    }

    var add = el.closest("[data-add]");
    if (add) { addFrom(add.dataset.add); return; }

    var sc = el.closest("[data-scale]");
    if (sc) { setScale(sc.dataset.scale); return; }

    var nav = el.closest("[data-nav]");
    if (nav) { shiftView(+nav.dataset.nav); return; }

    var act = el.closest("[data-act]");
    if (act) { actions[act.dataset.act](); return; }

    if (el.closest("[data-unaim]")) {
      view.aimTime = null;
      saveView(); render();
      say("New tasks land on " + prettyWhen(view.aim, null) + ", with no time on them.");
      return;
    }

    var inboxCard = el.closest('[data-drop="inbox"]');
    if (inboxCard && !el.closest(".mini") && !el.closest(".task")) {
      if (view.held) place(view.held, null, null, "Unscheduled");
      return;
    }

    // a date in the month grid opens that week
    var wk = el.closest("[data-week]");
    if (wk) {
      view.anchor = wk.dataset.week;
      view.scroll = null;
      view.scale = "week";
      saveView(); render();
      say("Week of " + pretty(wk.dataset.week) + ".");
      return;
    }

    var slot = el.closest(".slot");
    if (slot) {
      if (view.held) place(view.held, slot.dataset.date, slot.dataset.time, prettyWhen(slot.dataset.date, slot.dataset.time));
      else aimAt(slot.dataset.date, slot.dataset.time);
      return;
    }

    var ad = el.closest(".ad-col");
    if (ad) {
      if (view.held) place(view.held, ad.dataset.date, null, pretty(ad.dataset.date) + ", all day");
      else aimAt(ad.dataset.date, null);
      return;
    }

    var cell = el.closest(".cell");
    if (cell) {
      var day = cell.dataset.date;
      if (view.held) { place(view.held, day, undefined, pretty(day)); return; }
      aimAt(day, null);
      return;
    }
  });

  function addFrom(which) {
    var box = document.querySelector('.mini[data-form="' + which + '"]');
    if (!box) return;
    var input = box.querySelector("input");
    var val = (input.value || "").trim();
    if (!val) return;
    input.value = "";

    if (which === "task") {
      var at = view.aim ? view.aimTime : null;
      var t = { id: uid(), title: val, who: "", day: view.aim || null, done: false,
                time: at || null, mins: at ? DEFAULT_MINS : null };
      run({ type: "addTask", task: t });
      say("Added to " + prettyWhen(t.day, t.time) + ".");
    } else {
      var slot = freeSlot();
      if (!slot) { say("Six people is the limit on this board."); return; }
      run({ type: "addPerson", person: { id: slot, name: val } });
      say(val + " joined the crew.");
    }
    refocus(which);
  }

  // the re-render replaces the box, so put the cursor back where it was
  function refocus(which) {
    var input = document.querySelector('.mini[data-form="' + which + '"] input');
    if (input) input.focus();
  }

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      if (view.menu) { view.menu = null; render(); return; }   // shut the picker, keep the rest
      view.held = null; view.aim = null; view.aimTime = null;
      saveView(); render(); say("");
      return;
    }
    if (e.key === "Enter" && e.target && e.target.isContentEditable) {
      e.preventDefault();
      e.target.blur();
      return;
    }
    if (e.key === "Enter" && e.target && e.target.tagName === "INPUT") {
      var box = e.target.closest(".mini");
      if (box) { e.preventDefault(); addFrom(box.dataset.form); }
    }
  });

  // Text edits patch the DOM in place rather than re-rendering: a re-render here
  // would rip out whatever the person is clicking on next.
  document.addEventListener("blur", function (e) {
    var el = e.target;
    if (!el || !el.classList) return;

    if (el.classList.contains("ttl")) {
      var host = el.closest(".task");
      var t = host && task(host.dataset.id);
      if (!t) return;
      var val = el.textContent.trim();
      if (!val) { el.textContent = t.title; return; }
      if (val !== t.title) run({ type: "setTask", id: t.id, patch: { title: val } }, true);
      return;
    }
    if (el.classList.contains("name")) {
      var ph = el.closest(".person");
      var p = ph && person(ph.dataset.id);
      if (!p) return;
      var nv = el.textContent.trim();
      if (!nv) { el.textContent = p.name; return; }
      if (nv === p.name) return;
      run({ type: "setPerson", id: p.id, name: nv }, true);
      var ini = initials(nv);
      Array.prototype.forEach.call(document.querySelectorAll('.task[data-who="' + p.id + '"] .who'), function (b) {
        b.textContent = ini;
      });
    }
  }, true);

  /* ---------- drag and drop ---------- */
  var overEl = null;
  function markOver(el) {
    if (overEl === el) return;
    if (overEl) overEl.removeAttribute("data-over");
    overEl = el;
    if (el) el.setAttribute("data-over", "1");
  }

  document.addEventListener("dragstart", function (e) {
    var c = e.target && e.target.closest ? e.target.closest(".task") : null;
    if (!c) return;
    view.held = c.dataset.id;
    if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", c.dataset.id); }
  });

  // Where a drop would land: somebody in the crew, a time slot, an all-day column,
  // a month cell, or the tray.
  function zone(e) {
    if (!e.target || !e.target.closest) return null;
    var pr = e.target.closest(".person");
    if (pr) return { el: pr, assign: pr.dataset.id };
    var slot = e.target.closest(".slot");
    if (slot) return { el: slot, day: slot.dataset.date, time: slot.dataset.time,
                       label: prettyWhen(slot.dataset.date, slot.dataset.time) };
    var ad = e.target.closest(".ad-col");
    if (ad) return { el: ad, day: ad.dataset.date, time: null, label: pretty(ad.dataset.date) + ", all day" };
    var cell = e.target.closest(".cell");
    if (cell) return { el: cell, day: cell.dataset.date, time: undefined, label: pretty(cell.dataset.date) };
    var tray = e.target.closest('[data-drop="inbox"]');
    if (tray) return { el: tray, day: null, time: null, label: "Unscheduled" };
    return null;
  }

  document.addEventListener("dragover", function (e) {
    var z = zone(e);
    if (!z || !view.held) return;
    e.preventDefault();
    markOver(z.el);
  });
  document.addEventListener("drop", function (e) {
    var z = zone(e);
    if (!z || !view.held) return;
    e.preventDefault();
    markOver(null);
    if (z.assign !== undefined) { assign(view.held, z.assign); return; }
    place(view.held, z.day, z.time, z.label);
  });
  document.addEventListener("dragend", function () {
    markOver(null);
    if (view.held) { view.held = null; render(); }
  });

  /* ---------- drag the bottom edge to change how long something takes ---------- */
  var dragging = null;
  document.addEventListener("mousedown", function (e) {
    var h = e.target && e.target.closest ? e.target.closest("[data-rsz]") : null;
    if (!h) return;
    var t = task(h.dataset.rsz);
    var box = h.closest(".ev");
    if (!t || !box) return;
    e.preventDefault();
    dragging = { id: t.id, box: box, y: e.clientY, from: taskMins(t), to: taskMins(t) };
    box.setAttribute("data-sizing", "1");
  });
  document.addEventListener("mousemove", function (e) {
    if (!dragging) return;
    var delta = (e.clientY - dragging.y) / HOUR_PX * 60;
    if (!isFinite(delta)) return;
    var t = task(dragging.id);
    if (!t) return;
    var next = Math.round((dragging.from + delta) / SNAP) * SNAP;
    next = Math.max(SNAP, Math.min(next, 1440 - mins(t.time)));
    if (next === dragging.to) return;
    dragging.to = next;
    dragging.box.style.height = Math.max(next / 60 * HOUR_PX, 17) + "px";
    say("“" + t.title + "” " + fmtT(t.time, true) + " – " + fmtT(hhmm(mins(t.time) + next), true));
  });
  document.addEventListener("mouseup", function () {
    if (!dragging) return;
    var d = dragging;
    dragging = null;
    d.box.removeAttribute("data-sizing");
    if (d.to === d.from) { render(); return; }
    run({ type: "setTask", id: d.id, patch: { mins: d.to } });
    var t = task(d.id);
    if (t) say("“" + t.title + "” now runs " + fmtT(t.time, true) + " – " + fmtT(hhmm(mins(t.time) + d.to), true) + ".");
  });

  /* ---------- moving around ---------- */
  function setScale(s) {
    if (s === view.scale) return;
    if (s === "week") {
      var t = today();
      view.anchor = (view.aim && view.aim.slice(0, 7) === view.month) ? view.aim
        : (t.slice(0, 7) === view.month ? t : view.month + "-01");
    } else {
      view.month = (view.anchor || today()).slice(0, 7);
    }
    view.scale = s;
    view.scroll = null;
    saveView(); render();
  }

  function shiftView(delta) {
    if (view.scale === "week") {
      if (delta === 0) view.anchor = today();
      else {
        var a = parseIso(view.anchor);
        view.anchor = isoOf(new Date(a.getFullYear(), a.getMonth(), a.getDate() + delta * 7));
      }
      view.month = view.anchor.slice(0, 7);
    } else if (delta === 0) {
      view.month = today().slice(0, 7);
      view.anchor = today();
    } else {
      var d = new Date(+view.month.slice(0, 4), +view.month.slice(5, 7) - 1 + delta, 1);
      view.month = d.getFullYear() + "-" + pad(d.getMonth() + 1);
      view.anchor = view.month + "-01";
    }
    saveView(); render();
  }

  /* ---------- dividing the work ---------- */
  var actions = {
    split: function () {
      if (!state.people.length) { say("Add someone to the crew first."); return; }
      var load = {};
      state.people.forEach(function (p) { load[p.id] = openLoad(p.id); });
      var pend = state.tasks.filter(function (t) { return !t.who && !t.done; });
      if (!pend.length) { say("Every open task already has a name on it."); return; }
      var ops = pend.map(function (t) {
        var pick = state.people[0].id;
        state.people.forEach(function (p) { if (load[p.id] < load[pick]) pick = p.id; });
        load[pick]++;
        return { type: "setTask", id: t.id, patch: { who: pick } };
      });
      runMany(ops);
      say(pend.length + " task" + (pend.length > 1 ? "s" : "") + " split across " + state.people.length + " people.");
    },

    spread: function () {
      var pool = state.tasks.filter(function (t) { return !t.day && !t.done; });
      if (!pool.length) { say("Nothing unscheduled to spread."); return; }
      var days = [], d = new Date(), guard = 0;
      while (days.length < 10 && guard++ < 40) {
        var wd = d.getDay();
        if (wd !== 0 && wd !== 6) days.push(isoOf(d));
        d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
      }
      var ops = pool.map(function (t, i) {
        return { type: "setTask", id: t.id, patch: { day: days[i % days.length] } };
      });
      view.month = days[0].slice(0, 7);
      view.anchor = days[0];
      saveView();
      runMany(ops);
      var used = Math.min(days.length, pool.length);
      say(pool.length + " task" + (pool.length > 1 ? "s" : "") + " spread over " + used + " weekday" + (used > 1 ? "s" : "") + ".");
    },

    clear: function () {
      var gone = state.tasks.filter(function (t) { return t.done; });
      if (!gone.length) { say("Nothing is ticked off yet."); return; }
      runMany(gone.map(function (t) { return { type: "delTask", id: t.id }; }));
      say(gone.length + " finished task" + (gone.length > 1 ? "s" : "") + " cleared.");
    }
  };

  /* ---------- get going ---------- */
  function bootLocal() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw) state = JSON.parse(raw);
    } catch (e) {}
  }

  render();
  setInterval(tickNow, 30000);

  fetch(API, { cache: "no-store" })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (j && j.configured) {
        mode = "server";
        rev = j.rev || 0;
        if (j.state) state = j.state;
        setInterval(poll, 5000);
      } else {
        bootLocal();
      }
    })
    .catch(function () { bootLocal(); })
    .then(function () { render(); });

  // don't leave an edit behind when the tab is closed or hidden
  ["pagehide", "visibilitychange"].forEach(function (ev) {
    window.addEventListener(ev, function () {
      if (document.visibilityState === "hidden" || ev === "pagehide") {
        if (saveTimer) clearTimeout(saveTimer);
        flush();
      }
    });
  });
})();
