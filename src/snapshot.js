// Turn AXe's raw accessibility tree (hundreds of KB of JSON) into a short list an
// agent can read and act on: on-screen, labelled, deduplicated, no scroll-bar noise.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// Pure layout containers: they carry a frame but nothing an agent can act on.
const CONTAINER_TYPES = new Set(["Group", "Toolbar", "Other", "Any", "Window", "ScrollView", "TabBar", "NavigationBar"]);
const NOISE_LABEL = /scroll bar/i;
// Controls an agent taps. Their text/image children are decorative duplicates.
export const INTERACTIVE = new Set(["Button", "Link", "Switch", "Cell", "TextField", "SecureTextField", "SearchField", "Slider", "Stepper", "RadioButton", "Tab", "Toggle", "MenuItem", "SegmentedControl"]);

export async function readAxe(udid) {
  const { stdout } = await execFileP("axe", ["describe-ui", "--udid", udid], { maxBuffer: 256 * 1024 * 1024 });
  return JSON.parse(stdout);
}

function parseFrame(root) {
  if (root.frame && root.frame.width) return { w: root.frame.width, h: root.frame.height };
  const m = String(root.AXFrame ?? "").match(/\{\{(-?[\d.]+),\s*(-?[\d.]+)\},\s*\{(-?[\d.]+),\s*(-?[\d.]+)\}\}/);
  return m ? { w: Number(m[3]), h: Number(m[4]) } : { w: 0, h: 0 };
}

/**
 * @param {object|object[]} tree raw `axe describe-ui` JSON
 * @returns {{app: string, width: number, height: number, elements: object[], more: object}}
 */
export function flatten(tree) {
  const root = Array.isArray(tree) ? tree[0] : tree;
  const { w, h } = parseFrame(root);
  const seen = new Set();
  const elements = [];
  const more = { up: 0, down: 0, left: 0, right: 0 };

  const walk = (n, owner = null) => {
    const f = n.frame ?? {};
    const label = n.AXLabel ?? null;
    const value = n.AXValue ?? null;
    const id = n.AXUniqueId ?? null;
    const type = n.type ?? "Unknown";
    const cx = (f.x ?? 0) + (f.width ?? 0) / 2;
    const cy = (f.y ?? 0) + (f.height ?? 0) / 2;
    const named = Boolean(label || value || id);
    let actionable = named && n !== root && !CONTAINER_TYPES.has(type) && !NOISE_LABEL.test(label ?? "");
    // Inside a tappable control, an Image or a text that repeats the control's own label adds nothing.
    if (actionable && owner && !INTERACTIVE.has(type)) {
      const text = `${label ?? ""}`.toLowerCase();
      if (type === "Image" || !text || owner.includes(text)) actionable = false;
    }
    if (actionable && type === "Image" && !label) actionable = false;
    if (actionable && f.width > 0 && f.height > 0) {
      const onScreen = cx >= 0 && cx <= w && cy >= 0 && cy <= h;
      if (onScreen) {
        // A Button and the Image inside it share label and centre: keep the parent.
        const key = `${label ?? value ?? id}@${Math.round(cx)},${Math.round(cy)}`;
        if (!seen.has(key)) {
          seen.add(key);
          elements.push({ type, label, value, id, x: Math.round(cx), y: Math.round(cy), w: Math.round(f.width), h: Math.round(f.height) });
        }
      } else if (cy > h) more.down++;
      else if (cy < 0) more.up++;
      else if (cx > w) more.right++;
      else more.left++;
    }
    const nextOwner = owner ?? (INTERACTIVE.has(type) && named && n !== root ? `${label ?? ""} ${value ?? ""}`.toLowerCase() : null);
    for (const c of n.children ?? []) walk(c, nextOwner);
  };
  walk(root);
  return { app: root.AXLabel ?? "?", width: w, height: h, elements, more };
}

export function fingerprint(snap) {
  const s = snap.elements.map((e) => `${e.type}|${e.label}|${e.value}|${e.x},${e.y}`).join("\n");
  return createHash("sha1").update(`${snap.app}\n${s}`).digest("hex").slice(0, 12);
}

const clip = (s, n = 70) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Compact text form: one line per element, index first so `tap 7` just works. */
export function render(snap, { changed } = {}) {
  const tag = changed === undefined ? "" : changed ? " · screen changed" : " · screen UNCHANGED";
  const out = [`[${snap.app}] ${snap.elements.length} elements${tag}`];
  snap.elements.forEach((e, i) => {
    const name = clip(e.label ?? e.value ?? "");
    const val = e.value && e.label && e.value !== e.label ? ` =${clip(e.value, 30)}` : "";
    const id = !e.label && e.id ? ` #${e.id}` : "";
    out.push(`${i}\t${e.type}\t${name}${val}${id}\t(${e.x},${e.y})`);
  });
  const hints = Object.entries(snap.more).filter(([, n]) => n > 0).map(([d, n]) => `${n} ${d}`);
  if (hints.length) out.push(`off-screen: ${hints.join(", ")} (swipe to reveal)`);
  return out.join("\n");
}

/** Resolve a user target (index or label text) to an element. */
export function resolve(snap, target, { type } = {}) {
  const els = type ? snap.elements.filter((e) => e.type.toLowerCase() === type.toLowerCase()) : snap.elements;
  if (/^\d+$/.test(String(target)) && !type) {
    const el = snap.elements[Number(target)];
    if (!el) throw new Error(`No element #${target} (screen has ${snap.elements.length}). Run \`see\` again.`);
    return { el, others: 0 };
  }
  const q = String(target).toLowerCase();
  const name = (e) => `${e.label ?? ""} ${e.value ?? ""}`.toLowerCase();
  const tiers = [
    els.filter((e) => e.id === target),
    els.filter((e) => (e.label ?? "").toLowerCase() === q),
    els.filter((e) => (e.label ?? "").toLowerCase().startsWith(q)),
    els.filter((e) => name(e).includes(q)),
  ];
  const hits = tiers.find((t) => t.length) ?? [];
  if (!hits.length) {
    const sample = snap.elements.slice(0, 8).map((e) => e.label ?? e.value).filter(Boolean).join(" | ");
    throw new Error(`No element matching "${target}". On screen: ${sample}`);
  }
  const all = els.filter((e) => name(e).includes(q)).length;
  return { el: hits[0], others: Math.max(0, all - 1) };
}
