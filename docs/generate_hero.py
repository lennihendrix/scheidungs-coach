#!/usr/bin/env python3
"""Generate cinematic hero image for divorce-coach app."""

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
import math
import random

W, H = 1440, 800
rng = random.Random(42)
np_rng = np.random.default_rng(42)

# ── helpers ──────────────────────────────────────────────────────────────────

def gaussian_blob(arr, cx, cy, radius, color, alpha=1.0):
    """Add a soft gaussian blob to a float32 RGBA array."""
    x = np.arange(arr.shape[1])
    y = np.arange(arr.shape[0])
    xx, yy = np.meshgrid(x, y)
    dist2 = (xx - cx)**2 + (yy - cy)**2
    blob = np.exp(-dist2 / (2 * (radius**2))) * alpha
    for c, v in enumerate(color[:3]):
        arr[:, :, c] = np.clip(arr[:, :, c] + blob * v, 0, 255)
    arr[:, :, 3] = np.clip(arr[:, :, 3] + blob * (color[3] if len(color) > 3 else 255) * alpha / 255, 0, 1)

def lerp(a, b, t):
    return a + (b - a) * t

# ── 1. BASE CANVAS ────────────────────────────────────────────────────────────
base = np.zeros((H, W, 3), dtype=np.float32)

# Dark blue-grey interior walls
wall_color = np.array([13, 17, 23], dtype=np.float32)  # #0D1117
base[:, :] = wall_color

# ── 2. WINDOW GEOMETRY ───────────────────────────────────────────────────────
# Window centered, tall, close to right-of-center
WIN_W, WIN_H = 380, 500
WIN_X = W // 2 - 40   # center-x of window
WIN_Y = H // 2 - 20   # center-y of window
wx0 = WIN_X - WIN_W // 2
wx1 = WIN_X + WIN_W // 2
wy0 = WIN_Y - WIN_H // 2
wy1 = WIN_Y + WIN_H // 2
FRAME_W = 14  # wooden frame thickness

# ── 3. CITY BOKEH (behind window glass) ──────────────────────────────────────
bokeh_layer = np.zeros((H, W, 4), dtype=np.float32)

# Far layer: tiny sharp points
for _ in range(280):
    cx = rng.randint(wx0 + 20, wx1 - 20)
    cy = rng.randint(wy0 + 20, wy1 - 20)
    r = rng.uniform(1, 3)
    col_choice = rng.choice(['amber', 'warm', 'cool'])
    if col_choice == 'amber':
        col = (255, 179, 71, 200)
    elif col_choice == 'warm':
        col = (255, 245, 224, 180)
    else:
        col = (176, 196, 222, 160)
    gaussian_blob(bokeh_layer, cx, cy, r, col, alpha=rng.uniform(0.6, 1.0))

# Mid layer: soft circles
for _ in range(120):
    cx = rng.randint(wx0 + 30, wx1 - 30)
    cy = rng.randint(wy0 + 30, wy1 - 30)
    r = rng.uniform(8, 18)
    col_choice = rng.choice(['amber', 'warm', 'cool', 'amber'])
    if col_choice == 'amber':
        col = (255, 179, 71, 160)
    elif col_choice == 'warm':
        col = (255, 245, 224, 140)
    else:
        col = (176, 196, 222, 100)
    gaussian_blob(bokeh_layer, cx, cy, r, col, alpha=rng.uniform(0.3, 0.7))

# Near layer: large blurry warm blobs
for _ in range(35):
    cx = rng.randint(wx0, wx1)
    cy = rng.randint(wy0, wy1)
    r = rng.uniform(22, 48)
    col = (255, 179, 71, 80)
    gaussian_blob(bokeh_layer, cx, cy, r, col, alpha=rng.uniform(0.15, 0.4))

# ── 4. WINDOW LIGHT FILL ─────────────────────────────────────────────────────
# Warm amber glow across 4 panes, bright center, darker toward edges
mid_x = WIN_X
mid_y = WIN_Y
frame_half = FRAME_W // 2

panes = [
    (wx0, wy0, mid_x - frame_half, mid_y - frame_half),  # top-left
    (mid_x + frame_half, wy0, wx1, mid_y - frame_half),  # top-right
    (wx0, mid_y + frame_half, mid_x - frame_half, wy1),  # bottom-left
    (mid_x + frame_half, mid_y + frame_half, wx1, wy1),  # bottom-right
]

window_light = np.zeros((H, W, 3), dtype=np.float32)
for (px0, py0, px1, py1) in panes:
    px0, py0, px1, py1 = int(px0), int(py0), int(px1), int(py1)
    if px0 >= px1 or py0 >= py1:
        continue
    pw = px1 - px0
    ph = py1 - py0
    # gradient: bright center, darker edges
    xs = np.linspace(-1, 1, pw)
    ys = np.linspace(-1, 1, ph)
    xx, yy = np.meshgrid(xs, ys)
    dist = np.sqrt(xx**2 + yy**2)
    brightness = np.clip(1.0 - dist * 0.55, 0.4, 1.0)
    # Warm amber light color
    r_c = lerp(180, 255, 1) * brightness
    g_c = lerp(120, 185, 1) * brightness
    b_c = lerp(30, 80, 1) * brightness
    window_light[py0:py1, px0:px1, 0] = r_c
    window_light[py0:py1, px0:px1, 1] = g_c
    window_light[py0:py1, px0:px1, 2] = b_c

# Composite bokeh on top of window light
bokeh_rgb = bokeh_layer[:, :, :3]
bokeh_alpha = np.clip(bokeh_layer[:, :, 3:4], 0, 1)

# Only apply bokeh inside window area
mask = np.zeros((H, W, 1), dtype=np.float32)
mask[wy0:wy1, wx0:wx1] = 1.0
window_with_bokeh = window_light * (1 - bokeh_alpha * mask) + bokeh_rgb * bokeh_alpha * mask

# ── 5. COMPOSITE WINDOW INTO BASE ────────────────────────────────────────────
win_mask = np.zeros((H, W), dtype=np.float32)
win_mask[wy0:wy1, wx0:wx1] = 1.0

# Inside window panes (not frame)
pane_mask = np.zeros((H, W), dtype=np.float32)
for (px0, py0, px1, py1) in panes:
    px0, py0, px1, py1 = int(px0), int(py0), int(px1), int(py1)
    if px0 >= px1 or py0 >= py1:
        continue
    pane_mask[py0:py1, px0:px1] = 1.0

base = base * (1 - pane_mask[:, :, np.newaxis]) + window_with_bokeh * pane_mask[:, :, np.newaxis]

# ── 6. WINDOW FRAME (wooden dark brown) ──────────────────────────────────────
frame_color = np.array([45, 32, 18], dtype=np.float32)  # dark brown wood

# Outer border
def fill_rect(arr, x0, y0, x1, y1, color):
    x0, y0, x1, y1 = max(0,int(x0)), max(0,int(y0)), min(arr.shape[1],int(x1)), min(arr.shape[0],int(y1))
    if x0 < x1 and y0 < y1:
        arr[y0:y1, x0:x1] = color

# outer frame
fill_rect(base, wx0, wy0, wx1, wy0 + FRAME_W, frame_color)  # top
fill_rect(base, wx0, wy1 - FRAME_W, wx1, wy1, frame_color)  # bottom
fill_rect(base, wx0, wy0, wx0 + FRAME_W, wy1, frame_color)  # left
fill_rect(base, wx1 - FRAME_W, wy0, wx1, wy1, frame_color)  # right
# cross
fill_rect(base, wx0, mid_y - frame_half, wx1, mid_y + frame_half, frame_color)
fill_rect(base, mid_x - frame_half, wy0, mid_x + frame_half, wy1, frame_color)

# ── 7. WINDOW GLOW SPILL on floor/wall ───────────────────────────────────────
glow = np.zeros((H, W, 3), dtype=np.float32)
# Soft pool on floor below window
for i in range(80):
    cy = wy1 + rng.randint(10, 160)
    cx = WIN_X + rng.randint(-100, 100)
    r = rng.uniform(60, 200)
    alpha = rng.uniform(0.02, 0.08)
    x = np.arange(W)
    y = np.arange(H)
    xx, yy = np.meshgrid(x, y)
    d2 = (xx - cx)**2 + (yy - cy)**2
    blob = np.exp(-d2 / (2 * r**2)) * alpha
    glow[:, :, 0] += blob * 220
    glow[:, :, 1] += blob * 160
    glow[:, :, 2] += blob * 60

# Wall glow to the left of window
for i in range(40):
    cx = wx0 - rng.randint(20, 200)
    cy = WIN_Y + rng.randint(-100, 100)
    r = rng.uniform(80, 200)
    alpha = rng.uniform(0.01, 0.05)
    x = np.arange(W)
    y = np.arange(H)
    xx, yy = np.meshgrid(x, y)
    d2 = (xx - cx)**2 + (yy - cy)**2
    blob = np.exp(-d2 / (2 * r**2)) * alpha
    glow[:, :, 0] += blob * 200
    glow[:, :, 1] += blob * 140
    glow[:, :, 2] += blob * 50

# Only outside panes
glow_mask = 1 - pane_mask
base = np.clip(base + glow * glow_mask[:, :, np.newaxis], 0, 255)

# ── 8. HUMAN SILHOUETTE ──────────────────────────────────────────────────────
img_pil = Image.fromarray(np.clip(base, 0, 255).astype(np.uint8))
draw = ImageDraw.Draw(img_pil)

# Person stands in front of window, slightly left of window center
PX = WIN_X - 20   # horizontal center of person
PY_FEET = wy1 + 8  # feet just below window sill (window goes to floor)

# Figure proportions (standing person ~220px tall at 1440px wide)
FIG_H = 230
# Silhouette color: very dark with slight warm tint from window light
SIL = (12, 10, 8)

def draw_silhouette(draw, cx, feet_y):
    """Draw a natural human silhouette using polygons."""
    h = FIG_H
    # Key measurements
    head_r = int(h * 0.085)
    neck_w = int(h * 0.055)
    shoulder_w = int(h * 0.22)
    chest_w = int(h * 0.175)
    waist_w = int(h * 0.135)
    hip_w = int(h * 0.19)
    thigh_w = int(h * 0.09)
    calf_w = int(h * 0.065)

    # Y positions (from feet)
    y_feet   = feet_y
    y_ankle  = feet_y - int(h * 0.06)
    y_knee   = feet_y - int(h * 0.30)
    y_hip    = feet_y - int(h * 0.47)
    y_waist  = feet_y - int(h * 0.55)
    y_chest  = feet_y - int(h * 0.65)
    y_shoulder = feet_y - int(h * 0.73)
    y_neck_b = feet_y - int(h * 0.78)
    y_neck_t = feet_y - int(h * 0.85)
    y_head_b = feet_y - int(h * 0.87)
    y_head_t = feet_y - int(h * 1.00)
    head_cy  = (y_head_b + y_head_t) // 2

    # Slight forward lean (person leaning toward window)
    lean = 8  # pixels lean at shoulder vs hip

    # Body polygon (torso + legs merged)
    body_pts = [
        # feet (spread)
        (cx - int(hip_w*0.65), y_feet),
        (cx + int(hip_w*0.65), y_feet),
        # ankles
        (cx + int(calf_w*0.9), y_ankle),
        # right leg outer
        (cx + thigh_w + 4, y_knee),
        (cx + int(hip_w*0.55), y_hip),
        # waist right
        (cx + waist_w + lean, y_waist),
        # chest/shoulder right
        (cx + chest_w + lean, y_chest),
        (cx + shoulder_w + lean, y_shoulder),
        # neck right
        (cx + neck_w//2 + lean, y_neck_b),
        (cx + neck_w//2 + lean, y_neck_t),
        # neck left
        (cx - neck_w//2 + lean, y_neck_t),
        (cx - neck_w//2 + lean, y_neck_b),
        # shoulder left
        (cx - shoulder_w + lean, y_shoulder),
        (cx - chest_w + lean, y_chest),
        (cx - waist_w + lean, y_waist),
        (cx - int(hip_w*0.55), y_hip),
        (cx - thigh_w, y_knee),
        (cx - int(calf_w*0.7), y_ankle),
    ]
    draw.polygon(body_pts, fill=SIL)

    # Head (slightly oval, tilted slightly down — contemplative)
    hx = cx + lean + 5
    draw.ellipse([hx - head_r, y_head_t, hx + head_r, y_head_b + int(head_r * 0.3)], fill=SIL)

    # Left arm hanging slightly away from body
    arm_pts = [
        (cx - shoulder_w + lean - 5, y_shoulder),
        (cx - shoulder_w + lean + 6, y_shoulder),
        (cx - shoulder_w + lean + 3, y_waist - 10),
        (cx - int(hip_w * 0.45), y_hip + 20),  # elbow area
        (cx - int(hip_w * 0.35), y_knee + 30),  # hand
        (cx - int(hip_w * 0.45), y_knee + 30),
        (cx - int(hip_w * 0.55), y_hip + 20),
        (cx - shoulder_w + lean - 7, y_waist - 10),
    ]
    draw.polygon(arm_pts, fill=SIL)

    # Right arm — slightly raised, resting on window frame area
    arm_r_pts = [
        (cx + shoulder_w + lean + 5, y_shoulder),
        (cx + shoulder_w + lean - 6, y_shoulder),
        (cx + shoulder_w + lean - 3, y_waist - 10),
        (cx + int(hip_w * 0.42), y_hip + 25),
        (cx + int(hip_w * 0.32), y_knee + 35),
        (cx + int(hip_w * 0.42), y_knee + 35),
        (cx + int(hip_w * 0.52), y_hip + 25),
        (cx + shoulder_w + lean + 7, y_waist - 10),
    ]
    draw.polygon(arm_r_pts, fill=SIL)

    # Rim light: subtle warm edge on left side of silhouette (backlight from window)
    rim_color = (55, 38, 15)
    # thin bright edge on left shoulder/arm
    rim_pts_l = [
        (cx - shoulder_w + lean - 2, y_shoulder - 4),
        (cx - shoulder_w + lean + 4, y_shoulder - 4),
        (cx - waist_w + lean + 2, y_waist),
        (cx - int(hip_w * 0.5), y_hip),
        (cx - int(hip_w * 0.54), y_hip),
        (cx - waist_w + lean - 2, y_waist),
    ]
    draw.polygon(rim_pts_l, fill=rim_color)

draw_silhouette(draw, PX, PY_FEET)

base = np.array(img_pil, dtype=np.float32)

# ── 9. RAIN ON GLASS ─────────────────────────────────────────────────────────
rain_layer = np.zeros((H, W, 4), dtype=np.float32)

# Long streaks — mostly vertical, slight angle
for _ in range(160):
    x = rng.randint(wx0 + 5, wx1 - 5)
    y_start = rng.randint(wy0 + 5, wy1 - 80)
    length = rng.randint(30, 120)
    angle = rng.uniform(-0.05, 0.02)  # slight diagonal
    opacity = rng.uniform(0.08, 0.22)
    width = rng.choice([1, 1, 1, 2])

    # Only inside panes
    if not (wx0 <= x <= wx1 and wy0 <= y_start <= wy1):
        continue

    img_tmp = Image.fromarray(np.zeros((H, W, 4), dtype=np.uint8), 'RGBA')
    d2 = ImageDraw.Draw(img_tmp)
    x_end = x + int(length * math.sin(angle))
    y_end = y_start + length
    # streak color: slightly bright (light refracting through water)
    streak_alpha = int(opacity * 255)
    d2.line([(x, y_start), (x_end, y_end)], fill=(220, 200, 160, streak_alpha), width=width)
    rain_arr = np.array(img_tmp, dtype=np.float32)
    # composite into rain_layer
    a = rain_arr[:, :, 3:4] / 255.0
    rain_layer[:, :, :3] = rain_layer[:, :, :3] * (1 - a) + rain_arr[:, :, :3] * a
    rain_layer[:, :, 3:4] = np.clip(rain_layer[:, :, 3:4] + a, 0, 1)

# Droplet clusters where rain hits glass
for _ in range(80):
    x = rng.randint(wx0 + 8, wx1 - 8)
    y = rng.randint(wy0 + 20, wy1 - 20)
    # small circle droplet
    r = rng.uniform(2, 6)
    opacity = rng.uniform(0.05, 0.18)
    xs = np.arange(W)
    ys = np.arange(H)
    xx, yy = np.meshgrid(xs, ys)
    dist2 = (xx - x)**2 + (yy - y)**2
    # ring-like for realistic water droplet
    ring = np.exp(-((np.sqrt(dist2) - r)**2) / 2) * opacity
    rain_layer[:, :, 0] = np.clip(rain_layer[:, :, 0] + ring * 220, 0, 255)
    rain_layer[:, :, 1] = np.clip(rain_layer[:, :, 1] + ring * 200, 0, 255)
    rain_layer[:, :, 2] = np.clip(rain_layer[:, :, 2] + ring * 160, 0, 255)
    rain_layer[:, :, 3] = np.clip(rain_layer[:, :, 3] + ring, 0, 1)

# Apply rain only inside window panes
rain_alpha = rain_layer[:, :, 3:4] * pane_mask[:, :, np.newaxis]
base = base * (1 - rain_alpha) + rain_layer[:, :, :3] * rain_alpha

# ── 10. ATMOSPHERIC HAZE between figure and window ───────────────────────────
haze = np.zeros((H, W, 3), dtype=np.float32)
# Soft mist layer in front of window, behind silhouette
cx, cy = WIN_X, WIN_Y
for i in range(6):
    r = rng.uniform(150, 280)
    alpha = rng.uniform(0.03, 0.08)
    x = np.arange(W)
    y = np.arange(H)
    xx, yy = np.meshgrid(x, y)
    d2 = (xx - cx + rng.randint(-60, 60))**2 + (yy - cy + rng.randint(-40, 40))**2
    blob = np.exp(-d2 / (2 * r**2)) * alpha
    haze[:, :, 0] += blob * 200
    haze[:, :, 1] += blob * 160
    haze[:, :, 2] += blob * 90

# Apply haze only in window area, partially
haze_mask = pane_mask[:, :, np.newaxis] * 0.6
base = np.clip(base + haze * haze_mask, 0, 255)

# ── 11. VIGNETTE ─────────────────────────────────────────────────────────────
x = np.linspace(-1, 1, W)
y = np.linspace(-1, 1, H)
xx, yy = np.meshgrid(x, y)
# Stronger at corners
vignette = 1.0 - np.clip((xx**2 * 0.7 + yy**2 * 0.9) * 1.1, 0, 0.88)
base = base * vignette[:, :, np.newaxis]

# ── 12. FILM GRAIN ───────────────────────────────────────────────────────────
grain = np_rng.normal(0, 4.5, (H, W, 3)).astype(np.float32)
base = np.clip(base + grain, 0, 255)

# ── 13. FINAL TONE CURVE (more contrast, slight cool shadows) ────────────────
# S-curve: boost midtones slightly, darken shadows more
normalized = base / 255.0
# Slight S-curve
def s_curve(x):
    return np.where(x < 0.5,
                    2 * x**2,
                    1 - 2 * (1-x)**2) * 0.85 + x * 0.15

base = s_curve(normalized) * 255.0

# Cool blue tint in very dark areas
dark_mask = np.clip(1.0 - normalized.mean(axis=2, keepdims=True) * 2.5, 0, 1)
base[:, :, 2] = np.clip(base[:, :, 2] + dark_mask[:, :, 0] * 12, 0, 255)

# ── 14. SAVE ──────────────────────────────────────────────────────────────────
result = np.clip(base, 0, 255).astype(np.uint8)
img_out = Image.fromarray(result)
out_path = "/Users/hendriklennarz/claude/divorce-coach/docs/hero-bg.png"
img_out.save(out_path, optimize=True)
print(f"Saved to {out_path} ({W}x{H})")
