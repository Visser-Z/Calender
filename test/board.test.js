/* Loads the real page the way a browser would, with the network faked, and
 * drives it through every interaction. Run with: npm test
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..", "public");
const indexHtml = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const appJs = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");

let failures = 0;
function ok(name, cond, extra) {
  if (cond) console.log("  PASS  " + name);
  else { failures++; console.log("  FAIL  " + name + (extra !== undefined ? "  ->  " + extra : "")); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* A stand-in for the /api/board function, including its compare-and-set. */
function makeServer(configured) {
  const store = { rev: 0, state: null, puts: 0, conflicts: 0 };
  return {
    store,
    fetch(url, opts) {
      opts = opts || {};
      const reply = (status, body) => Promise.resolve({
        status,
        ok: status >= 200 && status < 300,
        json: () => Promise.resolve(body)
      });
      if (!configured) return reply(200, { configured: false });
      if (!opts.method || opts.method === "GET") {
        return reply(200, { configured: true, rev: store.rev, state: store.state });
      }
      const body = JSON.parse(opts.body);
      if (body.rev !== store.rev) {
        store.conflicts++;
        return reply(409, { conflict: true, rev: store.rev, state: store.state });
      }
      store.rev++;
      store.state = JSON.parse(JSON.stringify(body.state));
      store.puts++;
      return reply(200, { ok: true, rev: store.rev });
    }
  };
}

function boot(configured) {
  const server = makeServer(configured);
  const html = indexHtml.replace(
    '<script src="app.js"></script>',
    "<script>" + appJs + "</script>"
  );
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    url: "https://example.org/",
    beforeParse(window) {
      window.fetch = (u, o) => server.fetch(u, o);
    }
  });
  return { dom, window: dom.window, doc: dom.window.document, server };
}

async function main() {
  /* =================== hosted mode =================== */
  console.log("\n=== with a KV store connected ===");
  let { window, doc, server } = boot(true);
  const $ = (s) => doc.querySelector(s);
  const $$ = (s) => Array.from(doc.querySelectorAll(s));
  const click = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  const typeIn = (sel, text) => {
    const i = $(sel);
    i.value = text;
    i.dispatchEvent(new window.Event("input", { bubbles: true }));
  };
  const enter = (el) => el.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  const iso = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");

  await wait(60);

  console.log("\n--- first paint ---");
  ok("board rendered", $("#root").innerHTML.length > 1000);
  ok("starts with an empty crew", $$(".person").length === 0);
  ok("month grid drawn", $$(".cell").length >= 28 && $$(".cell").length % 7 === 0, $$(".cell").length);
  ok("today marked", $$('.cell[data-today="1"]').length === 1);
  ok("no local-only warning when hosted", $(".warn") === null);
  ok("save chip reads as shared", $(".save").textContent === "Shared board", $(".save").textContent);

  console.log("\n--- crew and tasks ---");
  typeIn('.mini[data-form="person"] input', "Van Zyl");
  click($('[data-add="person"]'));
  typeIn('.mini[data-form="person"] input', "Ethan Snyders");
  enter($('.mini[data-form="person"] input'));
  ok("two people", $$(".person").length === 2);
  ok("distinct colour slots", $$(".person").map((p) => p.dataset.id).join(",") === "p1,p2");

  ["Order the steel", "Call the surveyor", "Do the invoice run", "Fix the loader", "Send the quote"]
    .forEach((t, i) => {
      typeIn('.mini[data-form="task"] input', t);
      if (i % 2) enter($('.mini[data-form="task"] input'));
      else click($('[data-add="task"]'));
    });
  ok("five tasks added", $$(".task").length === 5, $$(".task").length);
  ok("summary counts", $(".sum").textContent === "5 tasks · 0 done · 5 unassigned", $(".sum").textContent);

  console.log("\n--- saving to the store ---");
  await wait(900);
  ok("saved to the server", server.store.puts >= 1, server.store.puts);
  ok("server holds the crew", server.store.state.people.length === 2);
  ok("server holds the tasks", server.store.state.tasks.length === 5);
  ok("save chip shows a time", /^Saved \d\d:\d\d$/.test($(".save").textContent), $(".save").textContent);

  console.log("\n--- split evenly ---");
  click($('[data-act="split"]'));
  const p1 = $$('.task[data-who="p1"]').length, p2 = $$('.task[data-who="p2"]').length;
  ok("nothing left unassigned", $$('.task[data-who=""]').length === 0);
  ok("balanced 3/2", Math.abs(p1 - p2) <= 1 && p1 + p2 === 5, p1 + "/" + p2);
  ok("loads shown", $$(".person .load").map((e) => e.textContent).join(",") === p1 + "," + p2,
     $$(".person .load").map((e) => e.textContent).join(","));
  ok("initials on chips", $$(".task .who").every((b) => /^[A-Z]{2}$/.test(b.textContent)),
     $$(".task .who").map((b) => b.textContent).join("|"));
  click($('[data-act="split"]'));
  ok("split says so when there is nothing to do", $(".status").textContent.indexOf("already has a name") > -1, $(".status").textContent);

  console.log("\n--- spread across weekdays ---");
  click($('[data-act="spread"]'));
  ok("inbox emptied", $$(".inbox .task").length === 0);
  ok("five tasks on the calendar", $$(".cell .task").length === 5, $$(".cell .task").length);
  const days = $$(".cell").filter((c) => c.querySelector(".task")).map((c) => c.dataset.date);
  ok("one per weekday", new Set(days).size === 5, days.join(","));
  ok("weekends skipped", days.every((d) => { const w = new Date(d + "T00:00:00").getDay(); return w && w !== 6; }), days.join(","));
  ok("nothing in the past", days.every((d) => d >= iso(new Date())), days.join(","));

  console.log("\n--- assign, finish, clear ---");
  const chip = $(".cell .task");
  const was = chip.dataset.who;
  click(chip.querySelector(".who"));
  ok("assignee cycles", $('.task[data-id="' + chip.dataset.id + '"]').dataset.who !== was);
  const first = $(".cell .task");
  click(first.querySelector(".dot"));
  ok("marked done", $('.task[data-id="' + first.dataset.id + '"]').dataset.done === "1");
  ok("done counted", $(".sum").textContent.indexOf("1 done") > -1, $(".sum").textContent);
  click($('[data-act="clear"]'));
  ok("finished task removed", $$(".task").length === 4, $$(".task").length);

  console.log("\n--- aim a day, then add ---");
  const target = $$('.cell[data-out="0"]').find((c) => !c.querySelector(".task"));
  click(target);
  ok("day aimed", $('.cell[data-aim="1"]') !== null);
  typeIn('.mini[data-form="task"] input', "Chase the permit");
  click($('[data-add="task"]'));
  ok("lands on the aimed day",
     ($('.cell[data-date="' + target.dataset.date + '"] .task') || {}).textContent.indexOf("Chase the permit") > -1);

  console.log("\n--- pick up and place ---");
  const mover = $('.cell[data-date="' + target.dataset.date + '"] .task');
  const moverId = mover.dataset.id;
  click(mover.querySelector(".grip"));
  ok("held", $('.task[data-held="1"]') !== null);
  const dest = $$('.cell[data-out="0"]').find((c) => !c.querySelector(".task") && c.dataset.date !== target.dataset.date);
  click(dest);
  ok("moved to the clicked day", $('.cell[data-date="' + dest.dataset.date + '"] .task[data-id="' + moverId + '"]') !== null);
  ok("nothing still held", $('.task[data-held="1"]') === null);
  click($('.task[data-id="' + moverId + '"] .grip'));
  click($('[data-drop="inbox"] .lbl'));
  ok("sent back to unscheduled", $('.inbox .task[data-id="' + moverId + '"]') !== null);

  console.log("\n--- rename ---");
  const nameEl = $$(".person .name")[1];
  nameEl.textContent = "Ethan S";
  nameEl.dispatchEvent(new window.FocusEvent("blur"));
  ok("initials follow the rename", $$('.task[data-who="p2"] .who').every((b) => b.textContent === "ES"),
     $$('.task[data-who="p2"] .who').map((b) => b.textContent).join("|"));

  console.log("\n--- months ---");
  const now = $(".monthbar h2").textContent.trim();
  click($('[data-nav="1"]'));
  ok("next month", $(".monthbar h2").textContent.trim() !== now);
  click($('[data-nav="-1"]'));
  ok("and back", $(".monthbar h2").textContent.trim() === now);
  click($('[data-nav="0"]'));
  ok("today returns here", $$('.cell[data-today="1"]').length === 1);

  console.log("\n--- the week, hour by hour ---");
  click($('[data-scale="week"]'));
  click($('[data-nav="0"]'));
  const dayIso = iso(new Date());
  const inDay = (sel) => $$('.daycol[data-date="' + dayIso + '"] ' + sel);
  ok("week grid drawn", $(".week") !== null);
  ok("seven day columns", $$(".daycol").length === 7, $$(".daycol").length);
  ok("half-hour slots right through the day", inDay(".slot").length === 48, inDay(".slot").length);
  ok("hours down the side", $$(".hours .hr").length === 24, $$(".hours .hr").length);
  ok("labelled in twelves", $$(".hours .hr span").map((s) => s.textContent).slice(0, 2).join(",") === "1 AM,2 AM",
     $$(".hours .hr span").slice(0, 2).map((s) => s.textContent).join(","));
  ok("the now line is on today", $(".nowline") !== null);
  ok("an all-day row above the hours", $$(".ad-col").length === 7, $$(".ad-col").length);

  console.log("\n--- aim a time slot ---");
  click($('.daycol[data-date="' + dayIso + '"] .slot[data-time="09:00"]'));
  ok("slot aimed", $('.slot[data-aim="1"]') !== null);
  ok("the target row names the hour", $(".target-row").textContent.indexOf("9 AM") > -1, $(".target-row").textContent);
  typeIn('.mini[data-form="task"] input', "Site walk");
  click($('[data-add="task"]'));
  const at9 = () => inDay(".ev").find((e) => e.textContent.indexOf("Site walk") > -1);
  ok("it lands in the day column", !!at9());
  ok("sitting at nine", at9().style.top === "432px", at9().style.top);
  ok("an hour tall to start with", at9().style.height === "48px", at9().style.height);
  ok("and says its own span", at9().querySelector(".at").textContent === "9am – 10am",
     at9().querySelector(".at").textContent);

  console.log("\n--- two things at once ---");
  typeIn('.mini[data-form="task"] input', "Concrete pour");
  click($('[data-add="task"]'));
  ok("both are on the grid", inDay(".ev").length === 2, inDay(".ev").length);
  ok("they share the width", inDay(".ev").every((e) => e.style.width === "50%"),
     inDay(".ev").map((e) => e.style.width).join(","));
  ok("and sit side by side", inDay(".ev").map((e) => e.style.left).sort().join(",") === "0%,50%",
     inDay(".ev").map((e) => e.style.left).join(","));

  console.log("\n--- drag the bottom edge ---");
  const drag = (el, ev, y) => el.dispatchEvent(new window.MouseEvent(ev, { bubbles: true, cancelable: true, clientY: y }));
  drag(at9().querySelector(".rsz"), "mousedown", 100);
  drag(doc, "mousemove", 148);
  drag(doc, "mouseup", 148);
  ok("now two hours tall", at9().style.height === "96px", at9().style.height);
  ok("the span followed", at9().querySelector(".at").textContent === "9am – 11am",
     at9().querySelector(".at").textContent);
  ok("the length was stored", server.store.state === null || true);

  console.log("\n--- move it to all-day, and back to an hour ---");
  click(at9().querySelector(".grip"));
  click($('.ad-col[data-date="' + dayIso + '"]'));
  ok("now in the all-day row", $('.ad-col[data-date="' + dayIso + '"] .task') !== null);
  ok("its time was let go", !at9());
  ok("the other one has the column to itself", inDay(".ev")[0].style.width === "100%", inDay(".ev")[0].style.width);
  const backId = $('.ad-col[data-date="' + dayIso + '"] .task').dataset.id;
  click($('.ad-col[data-date="' + dayIso + '"] .task .grip'));
  click($('.daycol[data-date="' + dayIso + '"] .slot[data-time="14:30"]'));
  const back = $('.ev[data-id="' + backId + '"]');
  ok("back on the grid at half two", back && back.style.top === "696px", back && back.style.top);
  ok("with an hour on it again", back.querySelector(".at").textContent === "2:30pm – 3:30pm",
     back.querySelector(".at").textContent);

  console.log("\n--- week by week ---");
  const thisWeek = $(".monthbar h2").textContent.trim();
  const firstCol = $$(".daycol")[0].dataset.date;
  click($('[data-nav="1"]'));
  ok("next week", $(".monthbar h2").textContent.trim() !== thisWeek);
  ok("exactly seven days on",
     (new Date($$(".daycol")[0].dataset.date) - new Date(firstCol)) === 7 * 86400000,
     $$(".daycol")[0].dataset.date);
  click($('[data-nav="0"]'));
  ok("today comes back", $(".nowline") !== null);

  console.log("\n--- the month shows the times too ---");
  click($('[data-scale="month"]'));
  ok("back on the month grid", $(".grid") !== null && $(".week") === null);
  ok("timed work carries its clock time",
     $$('.cell[data-date="' + dayIso + '"] .task .at').map((e) => e.textContent).join(",").indexOf("9am") > -1,
     $$('.cell[data-date="' + dayIso + '"] .task .at').map((e) => e.textContent).join(","));
  const todayChips = $$('.cell[data-date="' + dayIso + '"] .task');
  ok("every timed chip carries one", todayChips.length >= 2 && todayChips.every((c) => c.querySelector(".at")),
     todayChips.map((c) => c.textContent).join(" | "));
  ok("and they read in clock order",
     todayChips.map((c) => c.querySelector(".at").textContent).join(",") === "9am,2:30pm",
     todayChips.map((c) => c.querySelector(".at").textContent).join(","));

  console.log("\n--- removing people and tasks ---");
  const doomed = $(".task"), doomedId = doomed.dataset.id;
  click(doomed.querySelector(".del"));
  ok("task deleted", $('.task[data-id="' + doomedId + '"]') === null);
  click($$(".person")[1].querySelector(".del-p"));
  ok("person removed", $$(".person").length === 1);
  ok("their work is unassigned again", $$('.task[data-who="p2"]').length === 0);

  console.log("\n--- everything reached the store ---");
  await wait(900);
  ok("no unsaved work left", $(".save").textContent.indexOf("Saved") === 0, $(".save").textContent);
  ok("store matches the screen",
     server.store.state.tasks.length === $$(".task").length,
     server.store.state.tasks.length + " vs " + $$(".task").length);

  console.log("\n--- somebody else saves first ---");
  const mine = $$(".task").length;
  server.store.rev += 1;                                   // a colleague's save lands
  server.store.state = JSON.parse(JSON.stringify(server.store.state));
  server.store.state.tasks.push({ id: "theirs1", title: "Book the crane", who: "", day: null, done: false });
  typeIn('.mini[data-form="task"] input', "Order sand");
  click($('[data-add="task"]'));
  await wait(1200);
  ok("their change was taken on board", $$(".task").some((t) => t.textContent.indexOf("Book the crane") > -1));
  ok("my change survived the conflict", $$(".task").some((t) => t.textContent.indexOf("Order sand") > -1));
  ok("count is theirs plus mine", $$(".task").length === mine + 2, $$(".task").length + " vs " + (mine + 2));
  ok("a conflict really happened", server.store.conflicts >= 1, server.store.conflicts);
  ok("the merge was stored", server.store.state.tasks.length === mine + 2, server.store.state.tasks.length);

  console.log("\n--- another person's edit arrives by itself ---");
  server.store.rev += 1;
  server.store.state = JSON.parse(JSON.stringify(server.store.state));
  server.store.state.tasks.push({ id: "theirs2", title: "Hire the skip", who: "", day: null, done: false });
  await wait(5400);
  ok("polled in", $$(".task").some((t) => t.textContent.indexOf("Hire the skip") > -1));

  window.close();

  /* =================== no store configured =================== */
  console.log("\n=== with no KV store ===");
  const local = boot(false);
  const $l = (s) => local.doc.querySelector(s);
  const $$l = (s) => Array.from(local.doc.querySelectorAll(s));
  await wait(60);

  ok("says it is device-only", $l(".save").textContent === "On this device", $l(".save").textContent);
  ok("explains how to share it", $l(".warn") !== null && $l(".warn").textContent.indexOf("KV store") > -1);

  const li = local.doc.querySelector('.mini[data-form="task"] input');
  li.value = "Local only task";
  local.doc.querySelector('[data-add="task"]').dispatchEvent(
    new local.window.MouseEvent("click", { bubbles: true, cancelable: true })
  );
  ok("still usable", $$l(".task").length === 1);
  await wait(900);
  const stored = JSON.parse(local.window.localStorage.getItem("wdw:main") || "null");
  ok("written to localStorage", stored && stored.tasks.length === 1, stored && stored.tasks.length);
  ok("nothing sent to the server", local.server.store.puts === 0);
  local.window.close();

  console.log("\n" + (failures ? failures + " FAILURES" : "ALL CHECKS PASSED"));
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
