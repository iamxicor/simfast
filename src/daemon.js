#!/usr/bin/env node
// Long-lived per-simulator process. It exists so SimGadget's idb_companion stays warm:
// without it every command pays an 8-48 s cold start, with it a tap costs ~100 ms.
import net from "node:net";
import fs from "node:fs";
import { Engine } from "./engine.js";
import { runDir, sockPath, logPath } from "./paths.js";

const udid = process.argv[2];
if (!udid) { console.error("usage: daemon.js <udid>"); process.exit(2); }

fs.mkdirSync(runDir(), { recursive: true });
const logFile = logPath(udid);
const log = (m) => fs.appendFileSync(logFile, `${new Date().toISOString()} ${m}\n`);
const idleMs = (Number(process.env.SIMFAST_IDLE_MIN) || 30) * 60_000;

const engine = new Engine(udid, { log });
const sock = sockPath(udid);
try { fs.unlinkSync(sock); } catch {}

let idle;
const bump = () => { clearTimeout(idle); idle = setTimeout(() => shutdown("idle"), idleMs); };
async function shutdown(why) {
  log(`shutdown: ${why}`);
  try { await engine.sg.backend.release?.(); } catch {}
  try { fs.unlinkSync(sock); } catch {}
  process.exit(0);
}

async function handle(msg) {
  switch (msg.cmd) {
    case "see": return { text: await engine.see() };
    case "step": return { text: await engine.step(msg.line) };
    case "do": return engine.batch(msg.lines);
    case "screenshot": return { text: await engine.screenshot(msg.path) };
    case "status": return { text: JSON.stringify(engine.status()) };
    case "stop": setTimeout(() => shutdown("requested"), 20); return { text: "stopped" };
    default: throw new Error(`unknown cmd ${msg.cmd}`);
  }
}

const server = net.createServer((conn) => {
  let buf = "";
  conn.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      bump();
      const msg = JSON.parse(line);
      engine
        .enqueue(() => handle(msg))
        .then((r) => conn.write(JSON.stringify({ ok: true, ...r }) + "\n"))
        .catch((e) => conn.write(JSON.stringify({ ok: false, error: e.message }) + "\n"));
    }
  });
  conn.on("error", () => {});
});
server.listen(sock, () => { log(`listening ${sock} pid=${process.pid}`); bump(); });
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
