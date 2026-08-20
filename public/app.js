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

  var view = { month: null, aim: null, held: null, over: null };
  try {
    var savedView = JSON.parse(sessionStorage.getItem("wdw-view:" + boardName) || "null");
    if (savedView) { view.month = savedView.month || null; view.aim = savedView.aim || null; }
  } catch (e) {}
  function saveView() {
    try { sessionStorage.setItem("wdw-view:" + boardName, JSON.stringify({ month: view.month, aim: view.aim })); } catch (e) {}
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

    fetch(API, { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j.configured || j.rev === rev) return;
      rev = j.rev;
      if (j.state) state = j.state;
      render();
    }).catch(function () {});
  }

  /* ---------- rendering ---------- */
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
        + (iso === view.over ? ' data-over="1"' : "")
        + '><span class="dnum">' + d.getDate() + "</span>"
        + '<ul class="tasks">' + (byDay[iso] || []).map(chip).join("") + "</ul></div>"
      );
    }
    return out.join("");
  }

  function chip(t) {
    var who = t.who || "";
    var label = who ? initials((person(who) || {}).name) : "+";
    return '<li class="task" data-id="' + t.id + '" data-who="' + who + '" data-done="' + (t.done ? "1" : "0") + '"'
      + (view.held === t.id ? ' data-held="1"' : "")
      + ' draggable="true">'
      + '<button class="grip" type="button" aria-label="Pick up task">⠿</button>'
      + '<button class="dot" type="button" aria-label="' + (t.done ? "Mark as not done" : "Mark done") + '"></button>'
      + '<span class="ttl" contenteditable="true" draggable="false">' + esc(t.title) + "</span>"
      + '<button class="who" type="button" aria-label="Assign to the next person">' + esc(label) + "</button>"
      + '<button class="del" type="button" aria-label="Delete task">×</button>'
      + "</li>";
  }

  function render() {
    if (!view.month) view.month = today().slice(0, 7);
    var y = view.month.slice(0, 4), m = +view.month.slice(5, 7) - 1;
    var inbox = state.tasks.filter(function (t) { return !t.day; });
    var done = state.tasks.filter(function (t) { return t.done; }).length;
    var un = state.tasks.filter(function (t) { return !t.who && !t.done; }).length;

    var html = '<div class="wrap">'
      + '<header class="top">'
      +   "<h1>Who Does What</h1>"
      +   '<p class="tag">One shared board. Add the work, split it across the crew, drop it on a day.</p>'
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
      +   '<button class="nav" type="button" data-nav="-1" aria-label="Previous month">‹</button>'
      +   '<button class="nav" type="button" data-nav="1" aria-label="Next month">›</button>'
      +   "<h2>" + MONTHS[m] + ' <span class="yr">' + y + "</span></h2>"
      +   '<button class="today" type="button" data-nav="0">Today</button>'
      +   '<span class="hint">Click a day to aim new tasks at it</span>'
      + "</div>"
      + '<div class="months">'
      +   '<div class="dow"><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span><span>Sun</span></div>'
      +   '<div class="grid">' + monthGrid(view.month) + "</div>"
      + "</div></div>";

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
      +   (state.people.length ? "" : '<p class="empty">Nobody on the board yet. Add the first name below.</p>')
      +   '<div class="mini" data-form="person"><input type="text" placeholder="Add a name" autocomplete="off"><button type="button" data-add="person">Add</button></div>'
      + "</section>"

      + '<section class="card" data-drop="inbox"' + (view.over === "inbox" ? ' data-over="1"' : "") + ">"
      +   '<span class="lbl">Unscheduled</span>'
      +   '<ul class="inbox">' + inbox.map(chip).join("") + "</ul>"
      +   (inbox.length ? "" : '<p class="empty">Nothing waiting. Add a task below.</p>')
      +   '<div class="mini" data-form="task"><input type="text" placeholder="What needs doing?" autocomplete="off"><button type="button" data-add="task">Add</button></div>'
      +   '<p class="target-row">Goes to <b>' + (view.aim ? pretty(view.aim) : "Unscheduled") + "</b></p>"
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
          + "The month you are looking at and the day you have aimed at stay yours alone."
          + (boardName === "main" ? " Add <code>?board=name</code> to the address for a second, separate board." : " You are on the <b>" + esc(boardName) + "</b> board.")
          + "</footer></div>";

    document.getElementById("root").innerHTML = html;
  }

  function renderStatus() {
    var el = document.querySelector(".status");
    if (el) el.textContent = msg;
  }
  function say(t) { msg = t; renderStatus(); }

  /* ---------- held task and aimed day ---------- */
  function pickUp(t) {
    var was = view.held === t.id;
    view.held = was ? null : t.id;
    render();
    say(was ? "Put back down." : "Holding “" + t.title + "”. Click a day, or the Unscheduled box, to place it.");
  }
  function place(id, day, label) {
    var t = task(id);
    view.held = null;
    if (!t) { render(); return; }
    if (t.day === day) { render(); say("Already there."); return; }
    if (day) view.month = day.slice(0, 7);
    saveView();
    run({ type: "setTask", id: id, patch: { day: day } });
    say("Moved to " + label + ".");
  }
  function cycleWho(t) {
    if (!state.people.length) { say("Add someone to the crew first."); return; }
    var order = [""].concat(state.people.map(function (p) { return p.id; }));
    var i = order.indexOf(t.who || "");
    run({ type: "setTask", id: t.id, patch: { who: order[(i + 1) % order.length] } });
  }

  /* ---------- interactions (delegated, so a re-render never unhooks them) ---------- */
  document.addEventListener("click", function (e) {
    var el = e.target;
    if (!el || !el.closest) return;

    var chipEl = el.closest(".task");
    if (chipEl) {
      var t = task(chipEl.dataset.id);
      if (!t) return;
      if (el.closest(".dot")) { run({ type: "setTask", id: t.id, patch: { done: !t.done } }); return; }
      if (el.closest(".who")) { cycleWho(t); return; }
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
    if (pEl && el.closest(".del-p")) {
      var p = person(pEl.dataset.id);
      run({ type: "delPerson", id: pEl.dataset.id });
      say((p ? p.name : "That person") + " is off the board. Their tasks are unassigned again.");
      return;
    }

    var add = el.closest("[data-add]");
    if (add) { addFrom(add.dataset.add); return; }

    var nav = el.closest("[data-nav]");
    if (nav) { shiftMonth(+nav.dataset.nav); return; }

    var act = el.closest("[data-act]");
    if (act) { actions[act.dataset.act](); return; }

    var inboxCard = el.closest('[data-drop="inbox"]');
    if (inboxCard && !el.closest(".mini") && !el.closest(".task")) {
      if (view.held) place(view.held, null, "Unscheduled");
      return;
    }

    var cell = el.closest(".cell");
    if (cell) {
      var day = cell.dataset.date;
      if (view.held) { place(view.held, day, pretty(day)); return; }
      view.aim = view.aim === day ? null : day;
      saveView(); render();
      say(view.aim ? "New tasks land on " + pretty(day) + "." : "New tasks go to Unscheduled again.");
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
      var t = { id: uid(), title: val, who: "", day: view.aim || null, done: false };
      run({ type: "addTask", task: t });
      say("Added to " + (t.day ? pretty(t.day) : "Unscheduled") + ".");
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
      view.held = null; view.aim = null;
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
  document.addEventListener("dragstart", function (e) {
    var c = e.target && e.target.closest ? e.target.closest(".task") : null;
    if (!c) return;
    view.held = c.dataset.id;
    if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", c.dataset.id); }
  });
  function zone(e) {
    if (!e.target || !e.target.closest) return null;
    var cell = e.target.closest(".cell");
    if (cell) return cell.dataset.date;
    return e.target.closest('[data-drop="inbox"]') ? "inbox" : null;
  }
  document.addEventListener("dragover", function (e) {
    var z = zone(e);
    if (!z || !view.held) return;
    e.preventDefault();
    if (view.over !== z) { view.over = z; render(); }
  });
  document.addEventListener("drop", function (e) {
    var z = zone(e);
    if (!z || !view.held) return;
    e.preventDefault();
    view.over = null;
    place(view.held, z === "inbox" ? null : z, z === "inbox" ? "Unscheduled" : pretty(z));
  });
  document.addEventListener("dragend", function () {
    if (view.over || view.held) { view.over = null; view.held = null; render(); }
  });

  /* ---------- dividing the work ---------- */
  function shiftMonth(delta) {
    if (delta === 0) view.month = today().slice(0, 7);
    else {
      var d = new Date(+view.month.slice(0, 4), +view.month.slice(5, 7) - 1 + delta, 1);
      view.month = d.getFullYear() + "-" + pad(d.getMonth() + 1);
    }
    saveView(); render();
  }

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
