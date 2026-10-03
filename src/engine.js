// The brain of the daemon. One step grammar, shared by the CLI, the MCP server and batches:
//
//   tap <index|label|x,y> [--type Button] [--count 2] [--long]
//   type <text> [--submit]        key return|tab|backspace|escape|space
//   swipe|scroll up|down|left|right
//   button home|lock|siri|side-button   launch <bundle-id>   open <url>   wait <ms>
//
// Every action returns the NEW screen in compact form, so one tool call = one agent step.
import { readAxe, flatten, fingerprint, render, resolve, INTERACTIVE } from "./snapshot.js";
import { axeBackend, simgadgetBackend, simctl } from "./backends.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEYS = { return: 40, enter: 40, escape: 41, backspace: 42, delete: 42, tab: 43, space: 44 };

const unquote = (s) => s.trim().replace(/^(["'])(.*)\1$/s, "$2");

export function parseStep(line) {
  const m = line.trim().match(/^(\S+)\s*(.*)$/s);
  if (!m) throw new Error("Empty step");
  const verb = m[1].toLowerCase();
  let rest = m[2];
  const flags = {};
  if (verb === "type") {
    if (/\s--submit\s*$/.test(rest)) { flags.submit = true; rest = rest.replace(/\s--submit\s*$/, ""); }
    return { verb, arg: unquote(rest), flags };
  }
  rest = rest.replace(/\s*--(type|count|settle)\s+(\S+)/g, (_, k, v) => ((flags[k] = v), ""));
  rest = rest.replace(/\s*--(long|no-see|confirm)\b/g, (_, k) => ((flags[k] = true), ""));
  return { verb, arg: unquote(rest), flags };
}

export class Engine {
  constructor(udid, { log = () => {}, settleMs = Number(process.env.SIMFAST_SETTLE_MS) || 500 } = {}) {
    this.udid = udid;
    this.log = log;
    this.settleMs = settleMs;
    this.axe = axeBackend(udid);
    this.sg = simgadgetBackend(udid, log);
    this.snap = null;
    this.fp = null;
    this.stale = true;
    this.chain = Promise.resolve();
  }

  /** SimGadget when it warmed up, otherwise AXe (slower per tap, but always works). */
  get input() {
    return this.sg.isReady() ? this.sg.get() : this.axe;
  }

  /** Serialise commands: HID input interleaved from two callers scrambles gestures. */
  enqueue(fn) {
    // The first command waits for the companion to finish starting: AXe and the companion
    // fight over the simulator's automation session if they run at the same time.
    const warm = () => Promise.race([this.sg.ready, sleep(90_000)]).then(fn);
    const run = this.chain.then(warm, warm);
    this.chain = run.catch(() => {});
    return run;
  }

  async refresh() {
    const snap = flatten(await readAxe(this.udid));
    this.snap = snap;
    this.fp = fingerprint(snap);
    this.stale = false;
    return snap;
  }

  async see() {
    return render(await this.refresh());
  }

  async exec(step, { allowIndex = true } = {}) {
    const { verb, arg, flags } = step;
    const input = this.input;
    switch (verb) {
      case "tap": return this.tap(arg, flags, allowIndex);
      case "type": {
        await input.type(arg);
        if (flags.submit) await this.axe.key(KEYS.return);
        return `typed ${JSON.stringify(arg)}${flags.submit ? " + return" : ""}`;
      }
      case "key": {
        const code = KEYS[arg.toLowerCase()] ?? Number(arg);
        if (!code) throw new Error(`Unknown key "${arg}". Use ${Object.keys(KEYS).join("|")} or a HID keycode.`);
        await this.axe.key(code);
        return `key ${arg}`;
      }
      case "swipe":
      case "scroll": return this.swipe(verb, arg);
      case "button": await input.button(arg); return `pressed ${arg}`;
      case "launch": await simctl(["launch", this.udid, arg]); return `launched ${arg}`;
      case "open": await simctl(["openurl", this.udid, arg]); return `opened ${arg}`;
      case "wait": await sleep(Number(arg) || 500); return `waited ${arg || 500} ms`;
      default: throw new Error(`Unknown step "${verb}". Verbs: tap type key swipe scroll button launch open wait`);
    }
  }

  async tap(arg, flags, allowIndex) {
    const count = flags.count ? Number(flags.count) : 1;
    const hold = flags.long ? 0.8 : 0;
    const input = this.input;
    const at = async (x, y, what) => {
      await input.tapXY(x, y, { count, hold });
      this.stale = true;
      return `tapped ${what} at (${x},${y})`;
    };
    const xy = arg.match(/^(\d+)\s*,\s*(\d+)$/);
    if (xy) return at(Number(xy[1]), Number(xy[2]), "point");

    const isIndex = /^\d+$/.test(arg) && !flags.type;
    if (isIndex && !allowIndex) throw new Error("Index targets are only valid as the first step of a batch (the screen changes after it). Use labels.");
    if (isIndex && this.stale) throw new Error(`Index ${arg} refers to a screen that has since changed. Run \`see\` first.`);

    // The screen we last showed the agent is still current: resolve against it. Free and
    // deterministic. On a miss we re-read once before giving up, because that snapshot may have been
    // taken while a transition was still running; a miss on the device itself costs 0.5-3 s.
    if (!isIndex && this.snap && !this.stale) {
      let hit;
      try { hit = resolve(this.snap, arg, { type: flags.type }); }
      catch { await sleep(300); await this.refresh(); hit = resolve(this.snap, arg, { type: flags.type }); }
      const { el, others } = hit;
      if (el.type === "Switch" && input.tapLabel && el.label) {
        // a switch's frame spans its whole row; only SimGadget's activation really flips it
        const r = await input.tapLabel(el.label, { count });
        this.stale = true;
        return `tapped "${el.label}" (Switch)${r.acted === "activation" ? ` ${r.before}→${r.after}` : ""}`;
      }
      return at(el.x, el.y, `"${el.label ?? el.value}" (${el.type})${others ? ` [+${others} other matches]` : ""}`);
    }

    // Fast path: SimGadget resolves the label on the device (~25 ms, no tree read) and refuses
    // covered targets. But "first match wins" can pick the wrong thing (an app named "Settings"
    // also matches the Back button labelled "Settings"), so we peek first and only take the
    // fast path when the match is a real control. Anything else goes through the snapshot.
    if (!isIndex && !flags.type && input.tapLabel) {
      try {
        const peek = await input.find(arg);
        if (peek && INTERACTIVE.has(peek.type)) {
          const r = await input.tapLabel(arg, { count });
          this.stale = true;
          const el = r.element ?? peek;
          return `tapped "${el.AXLabel ?? arg}" (${el.type})${r.acted === "activation" ? ` ${r.before}→${r.after}` : ""}`;
        }
      } catch (e) {
        if (e.name === "TapObstructedError" || e.name === "ElementDisabledError") throw new Error(e.message);
        // anything else: fall through to the snapshot, which also sees what the device matcher missed
      }
    }
    if (!this.snap || (this.stale && !isIndex)) await this.refresh();
    // Right after an action the target page may still be sliding in: wait for the label to appear
    // (up to ~1.2 s) instead of failing on a half-drawn screen. Indexes never wait.
    let hit;
    for (let i = 0; ; i++) {
      try { hit = resolve(this.snap, arg, { type: flags.type }); break; }
      catch (e) {
        if (isIndex || i >= 3) throw e;
        await sleep(400);
        await this.refresh();
      }
    }
    const { el, others } = hit;
    return at(el.x, el.y, `"${el.label ?? el.value}" (${el.type})${others ? ` [+${others} other matches]` : ""}`);
  }

  async swipe(verb, dir) {
    if (!this.snap) await this.refresh();
    const { width: w, height: h } = this.snap;
    const cx = Math.round(w / 2), cy = Math.round(h / 2);
    const dx = Math.round(w * 0.3), dy = Math.round(h * 0.3);
    // `scroll down` reveals content below, which means the finger moves UP.
    const d = verb === "scroll" ? { up: "down", down: "up", left: "right", right: "left" }[dir] : dir;
    const v = { up: [[cx, cy + dy], [cx, cy - dy]], down: [[cx, cy - dy], [cx, cy + dy]], left: [[cx + dx, cy], [cx - dx, cy]], right: [[cx - dx, cy], [cx + dx, cy]] }[d];
    if (!v) throw new Error(`Direction must be up|down|left|right, got "${dir}"`);
    await this.input.swipe({ x: v[0][0], y: v[0][1] }, { x: v[1][0], y: v[1][1] });
    this.stale = true;
    return `${verb} ${dir}`;
  }

  /**
   * Read the screen after an action. We wait `settleMs` (500 ms: measured 0 of 24 captures
   * mid-transition, versus 1 of 24 at 300 ms) and read once. With `confirm` (--confirm or
   * SIMFAST_CONFIRM=1) a changed screen is re-read until two consecutive reads agree, for very
   * slow animations at the price of one extra read (~0.5-1 s). `launch` polls until the app drew.
   */
  async settleRead(before, { launch = false, confirm = false } = {}) {
    let snap = await this.refresh();
    if (launch) {
      for (let i = 0; i < 16 && (!snap.app.trim() || snap.app === "?" || snap.elements.length < 3); i++) {
        await sleep(500);
        snap = await this.refresh();
      }
    }
    if ((confirm || process.env.SIMFAST_CONFIRM === "1") && (launch || this.fp !== before)) {
      for (let i = 0; i < 3; i++) {
        const prev = this.fp;
        await sleep(150);
        snap = await this.refresh();
        if (this.fp === prev) break;
      }
    }
    return snap;
  }

  /** One agent step: act, wait for the UI to settle, return the new screen. */
  async step(line) {
    const t0 = Date.now();
    const step = parseStep(line);
    const before = this.fp;
    const did = await this.exec(step);
    const tAct = Date.now() - t0;
    if (step.flags["no-see"] || step.verb === "wait") return did;
    const settle = step.flags.settle ? Number(step.flags.settle) : step.verb === "launch" ? 600 : this.settleMs;
    await sleep(settle);
    const t1 = Date.now();
    const snap = await this.settleRead(before, { launch: step.verb === "launch", confirm: Boolean(step.flags.confirm) });
    const read = Date.now() - t1;
    const s = (ms) => (ms / 1000).toFixed(1);
    return `${did}\n${render(snap, { changed: before === null ? undefined : this.fp !== before })}\n· ${s(Date.now() - t0)}s via ${this.input.name} (act ${s(tAct)} · settle ${s(settle)} · read ${s(read)})`;
  }

  /** Many steps, ONE screen read at the end. Stops at the first failure and shows where it stopped. */
  async batch(lines) {
    const t0 = Date.now();
    const before = this.fp;
    const done = [];
    for (let i = 0; i < lines.length; i++) {
      try {
        done.push(`${i + 1}. ${await this.exec(parseStep(lines[i]), { allowIndex: i === 0 })}`);
        if (i < lines.length - 1) await sleep(this.settleMs);
      } catch (e) {
        await sleep(this.settleMs);
        const snap = await this.refresh();
        return { isError: true, text: `${done.join("\n")}\nSTEP ${i + 1} FAILED (${lines[i]}): ${e.message}\n${render(snap)}` };
      }
    }
    await sleep(this.settleMs);
    const snap = await this.settleRead(before, { launch: /^launch\b/i.test(lines.at(-1) ?? "") });
    return { text: `${done.join("\n")}\n${render(snap, { changed: before === null ? undefined : this.fp !== before })}\n· ${((Date.now() - t0) / 1000).toFixed(1)}s, ${lines.length} steps, via ${this.input.name}` };
  }

  async screenshot(path) {
    const out = path ?? `/tmp/simfast-${Date.now()}.png`;
    await execFileP("axe", ["screenshot", "--udid", this.udid, "--output", out]);
    return out;
  }

  status() {
    return { udid: this.udid, backend: this.input.name, warm: this.sg.isReady(), pid: process.pid };
  }
}
