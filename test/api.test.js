/* Exercises api/board.js against a stand-in for the KV store's REST API,
 * including the compare-and-set that stops two saves overwriting each other.
 */
const path = require("path");

let failures = 0;
function ok(name, cond, extra) {
  if (cond) console.log("  PASS  " + name);
  else { failures++; console.log("  FAIL  " + name + (extra !== undefined ? "  ->  " + extra : "")); }
}

/* A very small Redis, speaking the bits of the REST protocol we use. */
function fakeRedis() {
  const kv = new Map();
  return {
    kv,
    handler: async (url, opts) => {
      const args = JSON.parse(opts.body).map(String);
      const cmd = args[0].toUpperCase();
      let result = null;

      if (cmd === "GET") {
        result = kv.has(args[1]) ? kv.get(args[1]) : null;
      } else if (cmd === "SET") {
        kv.set(args[1], args[2]);
        result = "OK";
      } else if (cmd === "EVAL") {
        // ["EVAL", script, "2", revKey, stateKey, expectedRev, payload]
        const revKey = args[3], stateKey = args[4];
        const expected = Number(args[5]), payload = args[6];
        const current = Number(kv.get(revKey) || "0");
        if (current !== expected) result = -1;
        else {
          kv.set(revKey, String(current + 1));
          kv.set(stateKey, payload);
          result = current + 1;
        }
      } else {
        return { ok: false, status: 400, text: async () => "unknown command " + cmd };
      }

      return { ok: true, status: 200, text: async () => JSON.stringify({ result }) };
    }
  };
}

function call(handler, { method = "GET", query = {}, body = undefined } = {}) {
  return new Promise((resolve) => {
    const res = {
      _status: 200,
      _headers: {},
      setHeader(k, v) { this._headers[k] = v; },
      status(c) { this._status = c; return this; },
      json(payload) { resolve({ status: this._status, headers: this._headers, body: payload }); }
    };
    handler({ method, query, body }, res);
  });
}

function loadHandler() {
  delete require.cache[require.resolve("../api/board.js")];
  return require("../api/board.js");
}

async function main() {
  console.log("\n=== no store connected ===");
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;

  let r = await call(loadHandler(), {});
  ok("reports itself unconfigured", r.status === 200 && r.body.configured === false, JSON.stringify(r.body));
  ok("says why", typeof r.body.reason === "string" && r.body.reason.length > 10);
  ok("never cached", r.headers["Cache-Control"] === "no-store");

  console.log("\n=== with a store (legacy KV_ variables) ===");
  process.env.KV_REST_API_URL = "https://fake.upstash.io/";
  process.env.KV_REST_API_TOKEN = "token";
  const redis = fakeRedis();
  global.fetch = redis.handler;
  let handler = loadHandler();

  r = await call(handler, {});
  ok("empty board reads as rev 0", r.status === 200 && r.body.configured === true && r.body.rev === 0 && r.body.state === null,
     JSON.stringify(r.body));

  const boardA = { v: 1, people: [{ id: "p1", name: "Van Zyl" }], tasks: [], seq: 0 };
  r = await call(handler, { method: "PUT", body: { rev: 0, state: boardA } });
  ok("first save accepted", r.status === 200 && r.body.rev === 1, JSON.stringify(r.body));

  r = await call(handler, {});
  ok("reads back what was written", r.body.rev === 1 && r.body.state.people[0].name === "Van Zyl", JSON.stringify(r.body.state));

  console.log("\n=== two people saving at once ===");
  const boardB = JSON.parse(JSON.stringify(boardA));
  boardB.tasks.push({ id: "t1", title: "Order the steel", who: "", day: null, done: false });
  r = await call(handler, { method: "PUT", body: { rev: 1, state: boardB } });
  ok("the first of them wins", r.status === 200 && r.body.rev === 2);

  const boardC = JSON.parse(JSON.stringify(boardA));
  boardC.tasks.push({ id: "t2", title: "Call the surveyor", who: "", day: null, done: false });
  r = await call(handler, { method: "PUT", body: { rev: 1, state: boardC } });
  ok("the stale one is refused", r.status === 409 && r.body.conflict === true, JSON.stringify(r.body).slice(0, 120));
  ok("and is handed the winning board", r.body.rev === 2 && r.body.state.tasks[0].id === "t1");

  r = await call(handler, {});
  ok("the loser did not overwrite anything", r.body.state.tasks.length === 1 && r.body.state.tasks[0].id === "t1");

  console.log("\n=== boards are kept apart ===");
  r = await call(handler, { query: { board: "site-b" } });
  ok("a named board starts empty", r.body.rev === 0 && r.body.state === null);
  await call(handler, { method: "PUT", query: { board: "site-b" }, body: { rev: 0, state: { v: 1, people: [], tasks: [], seq: 0 } } });
  r = await call(handler, {});
  ok("the main board is untouched", r.body.rev === 2 && r.body.state.tasks.length === 1);
  ok("odd board names are sanitised", (await call(handler, { query: { board: "../../etc/passwd" } })).status === 200);

  console.log("\n=== bad input ===");
  ok("rejects a missing revision", (await call(handler, { method: "PUT", body: { state: {} } })).status === 400);
  ok("rejects a missing board", (await call(handler, { method: "PUT", body: { rev: 0 } })).status === 400);
  ok("rejects other methods", (await call(handler, { method: "DELETE" })).status === 405);
  ok("accepts a JSON string body", (await call(handler, { method: "PUT", body: JSON.stringify({ rev: 2, state: boardB }) })).status === 200);

  console.log("\n=== the store falls over ===");
  global.fetch = async () => ({ ok: false, status: 500, text: async () => "boom" });
  r = await call(loadHandler(), {});
  ok("reports the failure rather than crashing", r.status === 502 && typeof r.body.error === "string", JSON.stringify(r.body));

  console.log("\n=== newer UPSTASH_ variables also work ===");
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash.io";
  process.env.UPSTASH_REDIS_REST_TOKEN = "token";
  global.fetch = fakeRedis().handler;
  r = await call(loadHandler(), {});
  ok("picked up", r.body.configured === true);

  console.log("\n" + (failures ? failures + " FAILURES" : "ALL CHECKS PASSED"));
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
