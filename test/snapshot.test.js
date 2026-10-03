import { test } from "node:test";
import assert from "node:assert/strict";
import { flatten, render, resolve, fingerprint } from "../src/snapshot.js";

const node = (type, label, x, y, w, h, extra = {}) => ({
  type, AXLabel: label, AXValue: null, AXUniqueId: null,
  frame: { x, y, width: w, height: h }, children: [], ...extra,
});

const tree = [{
  type: "Application", AXLabel: "Demo", AXFrame: "{{0, 0}, {400, 800}}", frame: { x: 0, y: 0, width: 400, height: 800 },
  children: [
    node("Group", "Wrapper", 0, 0, 400, 800, {
      children: [
        node("Button", "Search", 300, 60, 44, 44),
        node("Button", "Profile", 20, 60, 44, 44, { children: [node("Image", "Profile", 28, 68, 28, 28, { AXUniqueId: "person" })] }),
        node("StaticText", "Welcome", 20, 140, 200, 20),
        node("Slider", "Vertical scroll bar, 2 pages", 380, 100, 20, 300, { AXValue: "0%" }),
        node("Button", "Deep item", 20, 900, 360, 40), // below the fold
        node("Switch", "Wi-Fi", 300, 300, 51, 31, { AXValue: "1" }),
        node("Group", "TabBar group", 0, 740, 400, 60),
      ],
    }),
  ],
}];

test("flatten keeps actionable on-screen elements and drops noise", () => {
  const s = flatten(tree);
  const labels = s.elements.map((e) => e.label);
  assert.deepEqual(labels, ["Search", "Profile", "Welcome", "Wi-Fi"]);
  assert.equal(s.app, "Demo");
  assert.deepEqual([s.width, s.height], [400, 800]);
});

test("flatten counts what is off screen", () => {
  assert.equal(flatten(tree).more.down, 1);
});

test("a Button and its inner Image collapse to one element", () => {
  const profile = flatten(tree).elements.filter((e) => e.label === "Profile");
  assert.equal(profile.length, 1);
  assert.equal(profile[0].type, "Button");
});

test("render is compact and indexed", () => {
  const text = render(flatten(tree), { changed: true });
  assert.match(text, /^\[Demo\] 4 elements · screen changed/);
  assert.match(text, /\n0\tButton\tSearch\t\(322,82\)/);
  assert.match(text, /off-screen: 1 down/);
  assert.ok(text.length < 400, `expected a short snapshot, got ${text.length} chars`);
});

test("resolve by index, exact label, prefix and substring", () => {
  const s = flatten(tree);
  assert.equal(resolve(s, "1").el.label, "Profile");
  assert.equal(resolve(s, "search").el.label, "Search");
  assert.equal(resolve(s, "wel").el.label, "Welcome");
  assert.equal(resolve(s, "i-f").el.label, "Wi-Fi");
});

test("resolve reports ambiguity and misses", () => {
  const s = flatten(tree);
  assert.throws(() => resolve(s, "nope"), /No element matching "nope"/);
  assert.throws(() => resolve(s, "9"), /No element #9/);
  const dup = flatten([{ ...tree[0], children: [node("Button", "Save", 10, 10, 40, 40), node("Button", "Save draft", 10, 100, 40, 40)] }]);
  assert.equal(resolve(dup, "Save").others, 1);
});

test("fingerprint changes when the screen changes", () => {
  const a = flatten(tree);
  const b = flatten([{ ...tree[0], children: [node("Button", "Other", 10, 10, 40, 40)] }]);
  assert.notEqual(fingerprint(a), fingerprint(b));
  assert.equal(fingerprint(a), fingerprint(flatten(tree)));
});

test("text and images inside a tappable row collapse into the row", () => {
  const row = node("Button", "General", 0, 100, 400, 52, {
    AXUniqueId: "com.example.general",
    children: [node("StaticText", "General", 16, 112, 80, 28), node("Image", null, 360, 112, 20, 28, { AXUniqueId: "chevron.forward" })],
  });
  const s = flatten([{ ...tree[0], children: [row, node("StaticText", "Standalone note", 0, 200, 400, 20)] }]);
  assert.deepEqual(s.elements.map((e) => `${e.type}:${e.label}`), ["Button:General", "StaticText:Standalone note"]);
  assert.doesNotMatch(render(s), /com\.example/, "internal ids are not shown when a label exists");
});
