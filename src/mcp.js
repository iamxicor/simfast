// MCP server (stdio). A thin wrapper: every tool is one message to the per-simulator daemon.
import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { call, resolveUdid } from "./client.js";

const INSTRUCTIONS = [
  "Drive the iOS Simulator by TEXT, not pixels. `screen` lists what is on screen as `index  Type  label  (x,y)`.",
  "Every action tool (tap, type, scroll, ...) returns the NEW screen in the same format, so you never need to call",
  "`screen` or take a screenshot after acting. Tap by label (`tap \"General\"`) or by index from the latest listing.",
  "Use `batch` for a known sequence of steps (one call, one screen read at the end). Screenshots are only for",
  "checking visuals (layout, colours, images); they cost ~1.5k tokens and are slower than the text listing.",
].join(" ");

const udidField = z.string().optional().describe("Simulator UDID. Default: the only booted simulator.");

export async function serve() {
  const server = new McpServer({ name: "simfast", version: "0.1.0" }, { instructions: INSTRUCTIONS });

  const run = (msg) => async (args) => {
    try {
      const r = await call(resolveUdid(args.udid), typeof msg === "function" ? msg(args) : msg);
      return { content: [{ type: "text", text: r.text }], ...(r.isError ? { isError: true } : {}) };
    } catch (e) {
      return { content: [{ type: "text", text: `error: ${e.message}` }], isError: true };
    }
  };
  const step = (verb, fmt) => run((a) => ({ cmd: "step", line: `${verb} ${fmt(a)}` }));

  server.registerTool("screen", {
    description: "List the visible, tappable elements of the simulator screen as compact text (~300-800 tokens). Call first, and again only if you need to refresh.",
    inputSchema: { udid: udidField },
  }, run({ cmd: "see" }));

  server.registerTool("tap", {
    description: "Tap an element by label (preferred), by index from the latest listing, or by 'x,y'. Returns the new screen and whether it changed.",
    inputSchema: {
      target: z.string().describe("Label text (case-insensitive, prefix/substring ok), index number, or 'x,y'"),
      type: z.string().optional().describe("Restrict label matching to an element type, e.g. Button, TextField"),
      count: z.number().int().min(1).max(3).optional().describe("2 = double tap"),
      long: z.boolean().optional().describe("Long press"),
      udid: udidField,
    },
  }, step("tap", (a) => `${/\s--/.test(a.target) ? a.target : JSON.stringify(a.target)}${a.type ? ` --type ${a.type}` : ""}${a.count ? ` --count ${a.count}` : ""}${a.long ? " --long" : ""}`));

  server.registerTool("type_text", {
    description: "Type into the currently focused field. Set submit to press Return afterwards.",
    inputSchema: { text: z.string(), submit: z.boolean().optional(), udid: udidField },
  }, step("type", (a) => `${a.text}${a.submit ? " --submit" : ""}`));

  server.registerTool("scroll", {
    description: "Scroll content: 'down' reveals what is below. Returns the new screen.",
    inputSchema: { direction: z.enum(["up", "down", "left", "right"]), udid: udidField },
  }, step("scroll", (a) => a.direction));

  server.registerTool("swipe", {
    description: "Raw swipe in the finger's direction (e.g. swipe left to dismiss a card). Use `scroll` to move through content.",
    inputSchema: { direction: z.enum(["up", "down", "left", "right"]), udid: udidField },
  }, step("swipe", (a) => a.direction));

  server.registerTool("key", {
    description: "Press a keyboard key: return, tab, backspace, escape, space (or a HID keycode).",
    inputSchema: { key: z.string(), udid: udidField },
  }, step("key", (a) => a.key));

  server.registerTool("button", {
    description: "Press a hardware button: home, lock, siri, side-button.",
    inputSchema: { name: z.enum(["home", "lock", "siri", "side-button", "apple-pay"]), udid: udidField },
  }, step("button", (a) => a.name));

  server.registerTool("launch_app", {
    description: "Launch an installed app by bundle id (e.g. com.apple.Preferences) and return its first screen.",
    inputSchema: { bundle_id: z.string(), udid: udidField },
  }, step("launch", (a) => a.bundle_id));

  server.registerTool("open_url", {
    description: "Open a URL or deep link in the simulator and return the resulting screen.",
    inputSchema: { url: z.string(), udid: udidField },
  }, step("open", (a) => a.url));

  server.registerTool("batch", {
    description: "Run several steps in ONE call and get one screen at the end. Use when you already know the path. Steps: 'tap <label>', 'type <text>', 'scroll down', 'key return', 'button home', 'launch <bundle>', 'wait <ms>'. Use labels, not indexes (the screen changes between steps). Stops at the first failure and shows the screen there.",
    inputSchema: { steps: z.array(z.string()).min(1).max(30), udid: udidField },
  }, run((a) => ({ cmd: "do", lines: a.steps })));

  server.registerTool("screenshot", {
    description: "Capture a PNG. Only for visual checks; prefer `screen`. Returns the file path, or the image itself when inline is true.",
    inputSchema: { path: z.string().optional(), inline: z.boolean().optional(), udid: udidField },
  }, async (a) => {
    try {
      const r = await call(resolveUdid(a.udid), { cmd: "screenshot", path: a.path });
      if (!a.inline) return { content: [{ type: "text", text: r.text }] };
      return { content: [{ type: "image", data: fs.readFileSync(r.text).toString("base64"), mimeType: "image/png" }, { type: "text", text: r.text }] };
    } catch (e) {
      return { content: [{ type: "text", text: `error: ${e.message}` }], isError: true };
    }
  });

  // Start the daemon now so the ~10 s companion warm-up overlaps with the agent thinking.
  try { call(resolveUdid(), { cmd: "status" }).catch(() => {}); } catch {}

  await server.connect(new StdioServerTransport());
}

if (import.meta.url === `file://${process.argv[1]}`) serve();
