#!/usr/bin/env node
// Records the two runs used in the comparison video, in real time, on one simulator:
//   classic: [think] tap process -> [think] screenshot        (2 tool calls per step)
//   simfast: [think] simfast tap  -> new screen as text        (1 tool call per step)
// "think" is a SIMULATED model round trip (--think seconds per tool call) so the video shows what
// the number of calls costs. Everything else is real tool time. Writes demo/out/{mode}.mp4 + .json.
//
//   node demo/record.mjs --udid <UDID> [--think 2] [--out demo/out]
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const UDID = opt("udid", process.env.SIMFAST_UDID);
const THINK = Number(opt("think", 2));
const OUT = opt("out", new URL("./out", import.meta.url).pathname);
if (!UDID) { console.error("pass --udid"); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });

const BIN = new URL("../bin/simfast.js", import.meta.url).pathname;
const sf = (...a) => spawnSync(process.execPath, [BIN, "--udid", UDID, ...a], { encoding: "utf8" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FLOW = ["General", "About", "General", "Settings", "Camera", "Settings"];

function coordsOf(label) {
  for (let i = 0; i < 8; i++) {
    const line = sf("see").stdout.split("\n").find((l) => l.split("\t")[2]?.toLowerCase().startsWith(label.toLowerCase()));
    const m = line?.match(/\((\d+),(\d+)\)\s*$/);
    if (m && (Number(m[1]) > 150 || /^(Settings|General|About)$/i.test(label))) return [m[1], m[2]];
    spawnSync("sleep", ["0.5"]);
  }
  throw new Error(`"${label}" not on screen`);
}
const imageTokens = (p) => {
  const o = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", p], { encoding: "utf8" });
  const [w, h] = [/pixelWidth: (\d+)/, /pixelHeight: (\d+)/].map((r) => Number(o.match(r)[1]));
  const k = Math.min(1, 1568 / Math.max(w, h));
  return Math.round((w * k * h * k) / 750);
};
const textTokens = (s) => Math.round(s.length / 3.5);

async function record(mode, body) {
  spawnSync("xcrun", ["simctl", "terminate", UDID, "com.apple.Preferences"]);
  sf("launch", "com.apple.Preferences");
  sf("see");
  const file = `${OUT}/${mode}.mp4`;
  const rec = spawn("xcrun", ["simctl", "io", UDID, "recordVideo", "--codec=h264", "--force", file]);
  await new Promise((res) => {
    const on = (d) => String(d).includes("Recording started") && res();
    rec.stdout.on("data", on); rec.stderr.on("data", on);
    setTimeout(res, 8000);
  });
  const t0 = performance.now();
  const events = [];
  const st = { calls: 0, tokens: 0 };
  const ev = (kind, text) => events.push({ t: +((performance.now() - t0) / 1000).toFixed(2), kind, text, calls: st.calls, tokens: st.tokens });
  const think = async (why, work) => { ev("think", why); const s = performance.now(); const r = work?.(); await sleep(Math.max(0, THINK * 1000 - (performance.now() - s))); return r; };
  await sleep(1200);
  ev("start", "");
  await body({ ev, think, st });
  ev("end", "");
  await sleep(1500);
  rec.kill("SIGINT");
  await new Promise((r) => rec.on("exit", r));
  fs.writeFileSync(`${OUT}/${mode}.json`, JSON.stringify({ mode, think: THINK, flow: FLOW, events }, null, 1));
  console.log(`${mode}: ${events.at(-1).t}s, ${st.calls} calls, ${st.tokens} tokens -> ${file}`);
}

await record("classic", async ({ ev, think, st }) => {
  for (const [i, label] of FLOW.entries()) {
    const [x, y] = await think(`model picks a point on screenshot`, () => (i === 0 ? coordsOf(label) : coordsOf(label)));
    st.calls++; ev("tool", `tap (${x},${y})`);
    execFileSync("axe", ["touch", "-x", x, "-y", y, "--down", "--up", "--delay", "0.12", "--udid", UDID], { stdio: "ignore" });
    await think("model waits for result");
    await sleep(400);
    st.calls++; ev("tool", "screenshot");
    const shot = `${OUT}/shot.png`;
    execFileSync("xcrun", ["simctl", "io", UDID, "screenshot", shot], { stdio: "ignore" });
    st.tokens += imageTokens(shot);
    ev("obs", `+${imageTokens(shot).toLocaleString("en")} tokens (image)`);
  }
});

await record("simfast", async ({ ev, think, st }) => {
  for (const label of FLOW) {
    await think("model reads the text listing");
    st.calls++; ev("tool", `simfast tap ${label}`);
    const r = sf("tap", label);
    if (r.status !== 0) throw new Error(r.stdout + r.stderr);
    const tk = textTokens(r.stdout);
    st.tokens += tk;
    ev("obs", `+${tk} tokens (text)`);
  }
});
