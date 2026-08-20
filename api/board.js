// Shared board storage.
//
// Backed by a Redis-compatible KV store over its REST API, so this file has no
// npm dependencies at all. It works with a Vercel Marketplace "Upstash for
// Redis" store (or plain Upstash), whichever pair of environment variables the
// integration happens to inject.
//
// With no store configured the endpoint stays healthy and reports
// configured:false, and the page falls back to saving in the browser.

const REV_TTL_NONE = null;

function credentials() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ""), token };
}

async function command(creds, args) {
  const res = await fetch(creds.url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + creds.token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(args.map(String))
  });
  const text = await res.text();
  if (!res.ok) throw new Error("store responded " + res.status + ": " + text.slice(0, 300));
  let body;
  try { body = JSON.parse(text); } catch (e) { throw new Error("store sent malformed JSON"); }
  if (body.error) throw new Error(body.error);
  return body.result;
}

function boardName(req) {
  const raw = (req.query && req.query.board) || "main";
  const clean = String(raw).toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40);
  return clean || "main";
}

// Compare and set: only writes when the caller's revision is still current, so
// two people saving at the same moment cannot silently overwrite each other.
const CAS = [
  "local rev = tonumber(redis.call('GET', KEYS[1]) or '0')",
  "if rev ~= tonumber(ARGV[1]) then return -1 end",
  "redis.call('SET', KEYS[1], rev + 1)",
  "redis.call('SET', KEYS[2], ARGV[2])",
  "return rev + 1"
].join("\n");

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  const creds = credentials();
  if (!creds) {
    res.status(200).json({
      configured: false,
      reason: "No KV store connected. See the README to turn on shared saving."
    });
    return;
  }

  const name = boardName(req);
  const revKey = "wdw:" + name + ":rev";
  const stateKey = "wdw:" + name + ":state";

  try {
    if (req.method === "GET") {
      const [rev, state] = await Promise.all([
        command(creds, ["GET", revKey]),
        command(creds, ["GET", stateKey])
      ]);
      res.status(200).json({
        configured: true,
        rev: Number(rev || 0),
        state: state ? JSON.parse(state) : null
      });
      return;
    }

    if (req.method === "PUT" || req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
      const rev = Number(body.rev);
      const state = body.state;

      if (!Number.isFinite(rev) || rev < 0 || !state || typeof state !== "object") {
        res.status(400).json({ error: "Send { rev: number, state: object }." });
        return;
      }

      const payload = JSON.stringify(state);
      if (payload.length > 2_000_000) {
        res.status(413).json({ error: "That board is too large to save." });
        return;
      }

      const result = Number(await command(creds, ["EVAL", CAS, 2, revKey, stateKey, rev, payload]));

      if (result === -1) {
        // Somebody saved first. Hand back the winning board so the page can
        // replay its own unsaved edits on top of it.
        const [curRev, curState] = await Promise.all([
          command(creds, ["GET", revKey]),
          command(creds, ["GET", stateKey])
        ]);
        res.status(409).json({
          conflict: true,
          rev: Number(curRev || 0),
          state: curState ? JSON.parse(curState) : null
        });
        return;
      }

      res.status(200).json({ ok: true, rev: result });
      return;
    }

    res.setHeader("Allow", "GET, PUT");
    res.status(405).json({ error: "Use GET or PUT." });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
};
