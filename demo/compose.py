#!/usr/bin/env python3
"""Compose the comparison video from demo/out/{classic,simfast}.{mp4,json}.

Homebrew's ffmpeg has no drawtext, so the overlay layer (timers, counters, captions, end card)
is rendered frame-by-frame with Pillow and piped into ffmpeg as raw RGBA.

  python3 demo/compose.py [--out demo/out/simfast-demo.mp4] [--limit SECONDS]
"""
import json, subprocess, sys, os, argparse
from PIL import Image, ImageDraw, ImageFont

ap = argparse.ArgumentParser()
ap.add_argument("--dir", default=os.path.join(os.path.dirname(__file__), "out"))
ap.add_argument("--out", default=None)
ap.add_argument("--limit", type=float, default=None, help="render only the first N seconds (preview)")
ap.add_argument("--bench", default=os.path.join(os.path.dirname(__file__), "bench-summary.json"))
args = ap.parse_args()
OUT = args.out or os.path.join(args.dir, "simfast-demo.mp4")

W, H, FPS, OFPS = 1080, 1350, 30, 15
PW, PH = 437, 950             # phone window (device aspect 1206:2622)
PY = 225
PX = (40, 603)
BG = (13, 17, 23)
PANEL = (22, 27, 34)
WHITE, GRAY, DIM = (240, 246, 252), (139, 148, 158), (88, 96, 105)
RED, GREEN, AMBER = (255, 107, 107), (61, 220, 151), (255, 193, 77)

HN = "/System/Library/Fonts/HelveticaNeue.ttc"
def font(size, bold=False):
    return ImageFont.truetype(HN, size, index=1 if bold else 0)
MONO = "/System/Library/Fonts/Menlo.ttc"
def mono(size, bold=False):
    return ImageFont.truetype(MONO, size, index=1 if bold else 0)

classic = json.load(open(f"{args.dir}/classic.json"))
simfast = json.load(open(f"{args.dir}/simfast.json"))
bench = json.load(open(args.bench)) if os.path.exists(args.bench) else None
THINK = classic["think"]

def info(run):
    ev = run["events"]
    start = next(e["t"] for e in ev if e["kind"] == "start")
    end = next(e["t"] for e in ev if e["kind"] == "end")
    return ev, start, end

def state(run, t):
    ev, start, end = info(run)
    last = None
    for e in ev:
        if e["t"] <= t:
            last = e
    calls = last["calls"] if last else 0
    tokens = last["tokens"] if last else 0
    elapsed = 0.0 if t < start else (min(t, end) - start)
    return dict(last=last, calls=calls, tokens=tokens, elapsed=elapsed, done=t >= end, total=end - start, t=t)

def center(d, text, f, cx, y, fill):
    w = d.textlength(text, font=f)
    d.text((cx - w / 2, y), text, font=f, fill=fill)

def rounded_mask_layer():
    """BG-coloured frame with transparent, rounded windows where the phones show through."""
    img = Image.new("RGBA", (W, H), BG + (255,))
    m = Image.new("L", (W, H), 255)
    md = ImageDraw.Draw(m)
    for x in PX:
        md.rounded_rectangle((x, PY, x + PW, PY + PH), radius=44, fill=0)
    img.putalpha(m)
    d = ImageDraw.Draw(img)
    return img

FRAME = rounded_mask_layer()

def draw_side(img, d, side, run, st, color, title, sub):
    x = PX[side]
    cx = x + PW / 2
    # header
    d.text((x, 150), title, font=font(40, True), fill=color)
    d.text((x, 196 - 2), sub, font=font(20), fill=GRAY)
    # bezel
    d.rounded_rectangle((x - 3, PY - 3, x + PW + 3, PY + PH + 3), radius=47, outline=color if st["done"] else (48, 54, 61), width=3)
    last = st["last"]
    if last and not st["done"]:
        if last["kind"] == "think":
            dots = "." * (1 + int(st["t"] * 3) % 3)
            label = f"model thinking{dots}"
            w = d.textlength(label, font=font(24, True))
            d.rounded_rectangle((cx - w / 2 - 22, PY + 96, cx + w / 2 + 22, PY + 142), radius=23, fill=(20, 24, 30, 235))
            d.text((cx - w / 2, PY + 104), label, font=font(24, True), fill=AMBER)
        elif last["kind"] in ("tool", "obs"):
            label = last["text"] if last["kind"] == "tool" else last["text"]
            col = color if last["kind"] == "tool" else (WHITE if side == 1 else AMBER)
            f = mono(21, True)
            w = d.textlength(label, font=f)
            y0 = PY + PH - 96
            d.rounded_rectangle((cx - w / 2 - 20, y0, cx + w / 2 + 20, y0 + 50), radius=14, fill=(20, 24, 30, 240))
            d.text((cx - w / 2, y0 + 12), label, font=f, fill=col)
    # counters
    yb = PY + PH + 22
    timer = f"{st['elapsed']:.1f}s"
    d.text((x, yb - 6), timer, font=font(64, True), fill=color if st["done"] else WHITE)
    if st["done"]:
        d.text((x + 215, yb + 22), "done", font=font(26, True), fill=color)
    d.text((x, yb + 66), f"{st['calls']} tool calls", font=font(28, True), fill=WHITE)
    d.text((x + 215, yb + 66), f"{st['tokens']:,} tokens read", font=font(28), fill=GRAY)

def draw_header(d):
    d.text((40, 40), "Same task. Same simulator.", font=font(52, True), fill=WHITE)
    d.text((40, 104), f"An agent drives iOS Settings: 6 steps. Models answer in {THINK:g}s per tool call (simulated).", font=font(22), fill=GRAY)

def end_card(d, p):
    d.rectangle((0, 0, W, H), fill=BG + (255,))
    a = min(1.0, p)
    d.text((40, 70), "simfast", font=font(96, True), fill=WHITE)
    d.text((40, 190), "Fast, token-cheap iOS Simulator control for AI agents", font=font(32), fill=GRAY)
    b = bench["results"] if bench else None
    cols = [("Screenshot loop", RED, "classic"), ("simfast", GREEN, "simfast"), ("simfast batch", GREEN, "batch")]
    x0, cw = 40, 330
    y = 300
    for i, (name, col, key) in enumerate(cols):
        x = x0 + i * (cw + 5)
        d.rounded_rectangle((x, y, x + cw - 10, y + 640), radius=24, fill=PANEL)
        d.text((x + 24, y + 22), name, font=font(30, True), fill=col)
        r = b[key] if b else None
        rows = [("tool time", f"{r['toolSeconds']:.1f}s" if r else "-"),
                ("tool calls", f"{r['calls']}" if r else "-"),
                ("tokens read", f"{r['observationTokens']:,}" if r else "-")]
        for j, (k, v) in enumerate(rows):
            yy = y + 100 + j * 170
            d.text((x + 24, yy), v, font=font(66, True), fill=WHITE)
            d.text((x + 24, yy + 82), k, font=font(24), fill=GRAY)
    d.text((40, 975), "Median of 6 runs · 6-step flow · iOS 27 simulator · tool time only", font=font(22), fill=DIM)
    d.text((40, 1030), "Text instead of pixels. A warm daemon instead of a process per tap.", font=font(30, True), fill=WHITE)
    d.text((40, 1080), "One call per step, or one call for the whole path.", font=font(30), fill=GRAY)
    d.rounded_rectangle((40, 1170, 1040, 1270), radius=20, fill=PANEL)
    d.text((70, 1195), "github.com/iamxicor/simfast", font=mono(44, True), fill=GREEN)
    d.text((40, 1295), "Open source · MIT · CLI + MCP server", font=font(24), fill=GRAY)

# ---- timeline
_, cs, ce = info(classic); _, ss, se = info(simfast)
race_end = max(classic["events"][-1]["t"], simfast["events"][-1]["t"]) + 1.5
card_len = 7.0
total = race_end + card_len
if args.limit:
    total = min(total, args.limit)
n_frames = int(total * OFPS)

cmd = ["ffmpeg", "-y", "-v", "error", "-stats",
       "-i", f"{args.dir}/classic.mp4", "-i", f"{args.dir}/simfast.mp4",
       "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{W}x{H}", "-r", str(OFPS), "-i", "-",
       "-filter_complex",
       f"[0:v]fps={FPS},scale={PW}:{PH},tpad=stop_mode=clone:stop_duration=60[a];"
       f"[1:v]fps={FPS},scale={PW}:{PH},tpad=stop_mode=clone:stop_duration=60[b];"
       f"color=c=0x{BG[0]:02x}{BG[1]:02x}{BG[2]:02x}:s={W}x{H}:r={FPS}[bg];"
       f"[bg][a]overlay={PX[0]}:{PY}:shortest=0[t1];[t1][b]overlay={PX[1]}:{PY}:shortest=0[t2];"
       f"[2:v]fps={FPS}[o];[t2][o]overlay=0:0:format=auto:shortest=1[v]",
       "-map", "[v]", "-t", f"{total:.2f}", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-preset", "medium",
       "-movflags", "+faststart", OUT]
proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)

for i in range(n_frames):
    t = i / OFPS
    if t >= race_end:
        img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        end_card(d, (t - race_end) / 0.6)
    else:
        img = FRAME.copy()
        d = ImageDraw.Draw(img)
        draw_header(d)
        draw_side(img, d, 0, classic, state(classic, t), RED, "Screenshot loop", "tap > screenshot > model reads pixels")
        draw_side(img, d, 1, simfast, state(simfast, t), GREEN, "simfast", "tap > new screen as text, one call")
    proc.stdin.write(img.tobytes())
proc.stdin.close()
proc.wait()
print("wrote", OUT, f"({total:.1f}s)")
