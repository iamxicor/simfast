#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { call, resolveUdid } from "../src/client.js";

const HELP = `simfast - fast, token-cheap iOS Simulator control for AI agents

  simfast see                         compact list of what is on screen
  simfast tap <n|label|x,y>           tap, then print the new screen
  simfast type "text" [--submit]      type into the focused field
  simfast scroll down|up|left|right   reveal more content (finger moves the other way)
  simfast swipe up|down|left|right    raw swipe (finger direction)
  simfast key return|tab|backspace    keyboard keys
  simfast button home|lock            hardware buttons
  simfast launch <bundle-id>          launch an app      simfast open <url>   open a URL
  simfast do "tap General" "tap About" "type hi"   many steps, ONE screen read at the end
  simfast shot [path.png]             screenshot to a file (use only when you need pixels)
  simfast status | stop | doctor | mcp

Options: --udid <udid> (or SIMFAST_UDID). Default: the only booted simulator.
Flags on tap: --type Button   --count 2   --long   --no-see
`;

const STEP_VERBS = new Set(["tap", "type", "key", "swipe", "scroll", "button", "launch", "open", "wait"]);

function doctor() {
  const ok = (m) => console.log(`  ✓ ${m}`);
  const bad = (m, fix) => { console.log(`  ✗ ${m}${fix ? `\n      fix: ${fix}` : ""}`); failed = true; };
  let failed = false;
  const run = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; } };
  console.log("simfast doctor");
  process.platform === "darwin" ? ok("macOS") : bad("macOS required");
  const dev = run("xcode-select", ["-p"]);
  dev ? ok(`Xcode tools at ${dev}`) : bad("Xcode command line tools not found", "xcode-select --install");
  const axe = run("axe", ["--version"]);
  axe ? ok(`AXe ${axe}`) : bad("AXe not found (required for reading the screen)", "brew install cameroncooke/axe/axe");
  try { resolveUdid(); ok("one booted simulator found"); } catch (e) { bad(e.message.split("\n")[0]); }
  import("simgadget").then(() => ok(`SimGadget installed (fast taps; arch ${process.arch})`), () => console.log("  ! SimGadget not installed: simfast still works, taps use AXe (~0.9 s instead of ~0.1 s)"))
    .finally(() => process.exit(failed ? 1 : 0));
}

async function main() {
  const argv = process.argv.slice(2);
  let udid;
  const ui = argv.indexOf("--udid");
  if (ui >= 0) { udid = argv[ui + 1]; argv.splice(ui, 2); }
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") return console.log(HELP);
  if (cmd === "doctor") return doctor();
  if (cmd === "mcp") return (await import("../src/mcp.js")).serve();

  const id = resolveUdid(udid);
  let msg;
  if (cmd === "see" || cmd === "status" || cmd === "stop") msg = { cmd };
  else if (cmd === "shot") msg = { cmd: "screenshot", path: rest[0] };
  else if (cmd === "do") msg = { cmd: "do", lines: rest };
  else if (STEP_VERBS.has(cmd)) msg = { cmd: "step", line: [cmd, ...rest].join(" ") };
  else { console.error(`Unknown command "${cmd}".\n\n${HELP}`); process.exit(2); }

  const r = await call(id, msg);
  console.log(r.text);
  if (r.isError) process.exit(1);
}

main().catch((e) => { console.error(`error: ${e.message}`); process.exit(1); });
