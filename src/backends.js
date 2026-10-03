// Two ways to inject input into the simulator. Both expose the same small surface.
//   axe       - one process per call (~0.9 s each) but zero warm-up. Always available.
//   simgadget - a persistent idb_companion over gRPC (~0.1 s per tap) after a one-off warm-up.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const axe = (udid, args) => execFileP("axe", [...args, "--udid", udid], { maxBuffer: 64 * 1024 * 1024 });

export const simctl = (args) => execFileP("xcrun", ["simctl", ...args]);

export function axeBackend(udid) {
  return {
    name: "axe",
    // A touch held for ~0.1 s: instantaneous taps (plain `axe tap`) land only about half the time.
    tapXY: async (x, y, { count = 1, hold = 0 } = {}) => {
      for (let i = 0; i < count; i++) await axe(udid, ["touch", "-x", String(x), "-y", String(y), "--down", "--up", "--delay", String(Math.max(hold, 0.12))]);
    },
    type: (text) => axe(udid, ["type", text]),
    swipe: (a, b, dur = 0.3) =>
      axe(udid, ["swipe", "--start-x", String(a.x), "--start-y", String(a.y), "--end-x", String(b.x), "--end-y", String(b.y), "--duration", String(dur)]),
    button: (name) => axe(udid, ["button", name]),
    key: (code) => axe(udid, ["key", String(code)]),
  };
}

/** Starts warming in the background. `ready` resolves to a backend (or null if unavailable). */
export function simgadgetBackend(udid, log = () => {}) {
  let sim = null;
  const ready = (async () => {
    if (process.env.SIMFAST_NO_SIMGADGET === "1") return null; // escape hatch: AXe only
    try {
      const { attachSimulator } = await import("simgadget");
      const s = await attachSimulator(udid);
      const t0 = Date.now();
      const r = await s.waitReady();
      log(`simgadget ready=${r.ready} in ${Date.now() - t0} ms`);
      if (!r.ready) return null;
      sim = s;
      return backend;
    } catch (e) {
      log(`simgadget unavailable: ${e.code ?? ""} ${e.message}`);
      return null;
    }
  })();

  const backend = {
    name: "simgadget",
    tapXY: (x, y, { count = 1, hold = 0 } = {}) => sim.tap({ x, y }, { count, ...(hold ? { durationSeconds: hold } : {}) }),
    /** First element the device matches for this label, or null. ~25 ms when it hits. */
    find: (label) => sim.findByLabel(label),
    /** Resolved on the device itself: no tree read, refuses covered/disabled targets. */
    tapLabel: (label, { count = 1 } = {}) => sim.tap({ label }, { count }),
    type: (text) => sim.typeText(text),
    swipe: (a, b, dur = 0.3) => sim.swipe(a, b, { durationSeconds: dur }),
    button: (name) => sim.pressButton(name),
    release: () => sim?.releaseCompanion?.(),
  };
  return { ready, isReady: () => sim !== null, get: () => backend, backend };
}
