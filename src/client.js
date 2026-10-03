// Thin client: talk to the per-simulator daemon, starting it on first use.
import net from "node:net";
import fs from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runDir, sockPath, logPath } from "./paths.js";

const DAEMON = fileURLToPath(new URL("./daemon.js", import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** --udid flag > $SIMFAST_UDID > the only booted simulator. */
export function resolveUdid(explicit) {
  if (explicit) return explicit;
  if (process.env.SIMFAST_UDID) return process.env.SIMFAST_UDID;
  const out = JSON.parse(execFileSync("xcrun", ["simctl", "list", "devices", "booted", "-j"], { encoding: "utf8" }));
  const booted = Object.values(out.devices).flat();
  if (booted.length === 0) throw new Error("No booted simulator. Boot one (`xcrun simctl boot <udid>`) or pass --udid.");
  if (booted.length > 1) {
    throw new Error(`Several simulators are booted; pass --udid or set SIMFAST_UDID:\n${booted.map((d) => `  ${d.udid}  ${d.name}`).join("\n")}`);
  }
  return booted[0].udid;
}

const connect = (udid) =>
  new Promise((resolve, reject) => {
    const c = net.createConnection(sockPath(udid));
    c.once("connect", () => resolve(c));
    c.once("error", reject);
  });

async function ensureDaemon(udid) {
  try { return await connect(udid); } catch {}
  fs.mkdirSync(runDir(), { recursive: true });
  const out = fs.openSync(logPath(udid), "a");
  spawn(process.execPath, [DAEMON, udid], { detached: true, stdio: ["ignore", out, out] }).unref();
  for (let i = 0; i < 60; i++) {
    await sleep(100);
    try { return await connect(udid); } catch {}
  }
  throw new Error(`simfast daemon did not start; see ${logPath(udid)}`);
}

export async function call(udid, msg) {
  const conn = await ensureDaemon(udid);
  return new Promise((resolve, reject) => {
    let buf = "";
    conn.on("data", (d) => {
      buf += d;
      if (buf.includes("\n")) {
        conn.end();
        const r = JSON.parse(buf.trim());
        r.ok ? resolve(r) : reject(new Error(r.error));
      }
    });
    conn.on("error", reject);
    conn.write(JSON.stringify(msg) + "\n");
  });
}
