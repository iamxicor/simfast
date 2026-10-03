#!/usr/bin/env node
// Same Settings-app flow, three ways. Measures tool wall-time, tool calls (agent round trips) and
// observation size. LLM thinking time is NOT measured: it is modelled with --llm-seconds.
//
//   node bench/compare.mjs --udid <UDID> [--llm-seconds 3] [--json out.json]
//
// "classic" = what an agent does with a screenshot-driven tool: act (one process per call), then
// take a screenshot to see the result, as two separate tool calls.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const UDID = opt("udid", process.env.SIMFAST_UDID);
const LLM_S = Number(opt("llm-seconds", 3));
if (!UDID) { console.error("pass --udid"); process.exit(2); }
const BIN = new URL("../bin/simfast.js", import.meta.url).pathname;
const sf = (...a) => spawnSync(process.execPath, [BIN, "--udid", UDID, ...a], { encoding: "utf8" });
const now = () => performance.now();

// label -> the step an agent would take. Flow: root -> General -> About -> back -> Camera -> back
const FLOW = ["General", "About", "General", "Settings", "Camera", "Settings"];

function reset() {
  spawnSync("xcrun", ["simctl", "terminate", UDID, "com.apple.Preferences"]);
  const r = sf("launch", "com.apple.Preferences");
  if (r.status !== 0) throw new Error(r.stderr);
}
function coordsOf(label) {
  // untimed helper: stands in for the model "looking" at the screenshot and choosing a point.
  // Polls because a screen can still be mid-transition right after the previous tap.
  let out = [];
  for (let i = 0; i < 8; i++) {
    out = sf("see").stdout.split("\n");
    const line = out.find((l) => l.split("\t")[2]?.toLowerCase().startsWith(label.toLowerCase()));
    // a settled screen has its controls at their final x (a sliding page is still at x<150)
    if (line && !/\((\d+),/.test(line.split("\t").at(-1)) === false) {
      const [x, y] = line.match(/\((\d+),(\d+)\)\s*$/).slice(1);
      if (Number(x) > 150 || /^(Settings|General|About)$/i.test(label)) return [x, y];
    }
    spawnSync("sleep", ["0.5"]);
  }
  throw new Error(`"${label}" not on screen:\n${out.slice(0, 8).join("\n")}`);
}
const imageTokens = (path) => {
  const out = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path], { encoding: "utf8" });
  let [w, h] = [/pixelWidth: (\d+)/, /pixelHeight: (\d+)/].map((r) => Number(out.match(r)[1]));
  const k = Math.min(1, 1568 / Math.max(w, h));
  return Math.round((w * k * h * k) / 750);
};
const textTokens = (s) => Math.round(s.length / 3.5);

const results = {};

// --- A. classic: tap process + screenshot, two calls per step
reset(); sf("see");
{
  let ms = 0, tokens = 0, calls = 0;
  for (const label of FLOW) {
    const [x, y] = coordsOf(label);
    let t = now();
    // held touch: plain `axe tap` does not register on iOS 27 in our tests, so we give the baseline the reliable variant
    execFileSync("axe", ["touch", "-x", x, "-y", y, "--down", "--up", "--delay", "0.12", "--udid", UDID], { stdio: "ignore" });
    ms += now() - t; calls++;
    t = now();
    const shot = `/tmp/simfast-bench-${calls}.png`;
    execFileSync("xcrun", ["simctl", "io", UDID, "screenshot", shot], { stdio: "ignore" });
    ms += now() - t; calls++;
    tokens += imageTokens(shot);
    await new Promise((r) => setTimeout(r, 400)); // let the transition finish so the screenshot is meaningful
    ms += 400;
  }
  results.classic = { label: "screenshot loop", toolSeconds: ms / 1000, calls, observationTokens: tokens, steps: FLOW.length };
}

// --- B. simfast, one call per step (act + observe)
reset(); sf("see");
{
  let ms = 0, tokens = 0, calls = 0;
  for (const label of FLOW) {
    const t = now();
    const r = sf("tap", label);
    ms += now() - t; calls++;
    if (r.status !== 0) throw new Error(r.stdout + r.stderr);
    tokens += textTokens(r.stdout);
  }
  results.simfast = { label: "simfast, per step", toolSeconds: ms / 1000, calls, observationTokens: tokens, steps: FLOW.length };
}

// --- C. simfast, whole flow in one call
reset(); sf("see");
{
  const t = now();
  const r = sf("do", ...FLOW.map((l) => `tap ${l}`));
  const ms = now() - t;
  if (r.status !== 0) throw new Error(r.stdout + r.stderr);
  results.batch = { label: "simfast, batched", toolSeconds: ms / 1000, calls: 1, observationTokens: textTokens(r.stdout), steps: FLOW.length };
}

for (const r of Object.values(results)) r.modelledSeconds = r.toolSeconds + r.calls * LLM_S;

const pad = (s, n) => String(s).padEnd(n);
console.log(`\nFlow: ${FLOW.length} steps in Settings (${FLOW.join(" > ")})   LLM latency model: ${LLM_S}s per tool call\n`);
console.log(pad("", 20), pad("tool time", 11), pad("tool calls", 11), pad("obs. tokens", 12), `modelled total`);
for (const r of Object.values(results)) {
  console.log(pad(r.label, 20), pad(r.toolSeconds.toFixed(1) + "s", 11), pad(r.calls, 11), pad(r.observationTokens, 12), `${r.modelledSeconds.toFixed(1)}s`);
}
const j = opt("json");
if (j) fs.writeFileSync(j, JSON.stringify({ flow: FLOW, llmSeconds: LLM_S, results }, null, 2));
