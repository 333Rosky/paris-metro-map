// The relay as a plain Node server (no dependency): run it on any host that
// keeps one process alive. For AWS Lambda see lambda.mjs.
//
//   PRIM_API_KEY=… node relay/server.mjs      (or: npm run relay, which reads .env)
//
// Environment: PRIM_API_KEY (required), PORT (8787), REFRESH_SECONDS (90),
// MAX_STALE_SECONDS (300), PRIM_URL (tests only).

import { createServer } from "node:http";
import { Relay } from "./core.mjs";

const seconds = (name, fallback) => {
  const n = Number(process.env[name]);
  return (Number.isFinite(n) && n > 0 ? n : fallback) * 1000;
};

if (!process.env.PRIM_API_KEY) {
  console.error("PRIM_API_KEY is not set");
  process.exit(1);
}

const relay = new Relay({
  key: process.env.PRIM_API_KEY,
  url: process.env.PRIM_URL || undefined,
  refreshMs: seconds("REFRESH_SECONDS", 90),
  maxStaleMs: seconds("MAX_STALE_SECONDS", 300),
});
const port = Number(process.env.PORT) || 8787;

createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url ?? "/", "http://relay");
    const r = await relay.handle(req.method ?? "GET", pathname, req.headers);
    res.writeHead(r.status, r.headers).end(r.body);
  } catch (e) {
    console.error("unexpected error:", e instanceof Error ? e.message : e);
    res.writeHead(500, { "access-control-allow-origin": "*", "content-type": "application/json" }).end('{"error":"internal"}');
  }
}).listen(port, () => console.log(`relay listening on :${port}, one PRIM request per ${relay.refreshMs / 1000} s at most`));
