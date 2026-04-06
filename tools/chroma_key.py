"""
Chroma key (green screen removal) for calico cat animation pipeline.

Usage:
  python tools/chroma_key.py <input_video> [output_apng]

Pipeline: video → extract frames → chroma key → resize → quantize → APNG
"""
import sys, os, glob, subprocess, shutil
from PIL import Image
import numpy as np

# ── Config ──
TARGET_HEIGHT = 200
TARGET_FPS = 8
MAX_COLORS = 192
PLAYS = 1          # 1 = play once, 0 = loop forever

# Green screen HSV range (tuned for #00B140 ± tolerance)
HUE_MIN, HUE_MAX = 80, 160       # green hue range (0-360 scale → /2 for OpenCV)
SAT_MIN = 40                      # minimum saturation to count as "green"
BRIGHT_MIN = 30                   # minimum brightness


def chroma_key_frame(img: Image.Image) -> Image.Image:
    """Remove green screen from a single RGBA frame using HSV thresholding."""
    arr = np.array(img.convert('RGBA'))
    h, w = arr.shape[:2]
    # Nuke bottom-right watermark region ("AI生成")
    arr[int(h*0.85):, int(w*0.7):, 3] = 0
    r, g, b, a = arr[:,:,0], arr[:,:,1], arr[:,:,2], arr[:,:,3]

    # Convert to float HSV manually (avoid opencv dependency)
    rf, gf, bf = r / 255.0, g / 255.0, b / 255.0
    cmax = np.maximum(rf, np.maximum(gf, bf))
    cmin = np.minimum(rf, np.minimum(gf, bf))
    delta = cmax - cmin

    # Hue (0-360)
    hue = np.zeros_like(rf)
    mask_r = (cmax == rf) & (delta > 0)
    mask_g = (cmax == gf) & (delta > 0)
    mask_b = (cmax == bf) & (delta > 0)
    hue[mask_r] = 60 * (((gf[mask_r] - bf[mask_r]) / delta[mask_r]) % 6)
    hue[mask_g] = 60 * (((bf[mask_g] - rf[mask_g]) / delta[mask_g]) + 2)
    hue[mask_b] = 60 * (((rf[mask_b] - gf[mask_b]) / delta[mask_b]) + 4)

    # Saturation (0-100)
    sat = np.where(cmax > 0, (delta / cmax) * 100, 0)

    # Value/Brightness (0-100)
    val = cmax * 100

    # Green mask: pixels that are "green enough"
    is_green = (hue >= HUE_MIN) & (hue <= HUE_MAX) & (sat >= SAT_MIN) & (val >= BRIGHT_MIN)

    # Soft edge: pixels near green get partial transparency
    # Calculate "greenness" score for anti-aliased edges
    green_ratio = gf / (rf + gf + bf + 0.001)
    is_semi_green = (green_ratio > 0.45) & (sat >= SAT_MIN * 0.5) & ~is_green

    # Apply
    new_a = a.copy()
    new_a[is_green] = 0
    new_a[is_semi_green] = (new_a[is_semi_green] * 0.3).astype(np.uint8)

    # Despill: remove green tint from ALL surviving pixels
    # Any pixel where green dominates more than it should gets corrected
    surviving = new_a > 0
    if np.any(surviving):
        rs, gs, bs = r[surviving].astype(float), g[surviving].astype(float), b[surviving].astype(float)
        avg_rb = (rs + bs) / 2
        # If green exceeds the average of R and B, cap it
        too_green = gs > avg_rb
        if np.any(too_green):
            corrected_g = gs.copy()
            corrected_g[too_green] = avg_rb[too_green] * 0.85 + gs[too_green] * 0.15
            arr[:,:,1][surviving] = np.clip(corrected_g, 0, 255).astype(np.uint8)

    # Also erode alpha edges by 1px to remove any remaining fringe
    from PIL import ImageFilter
    alpha_ch = Image.fromarray(new_a)
    alpha_ch = alpha_ch.filter(ImageFilter.MinFilter(3))
    arr[:,:,3] = np.array(alpha_ch)

    return Image.fromarray(arr)


def main():
    if len(sys.argv) < 2:
        print("Usage: python chroma_key.py <input_video> [output_apng]")
        sys.exit(1)

    input_video = sys.argv[1]
    basename = os.path.splitext(os.path.basename(input_video))[0]
    output_apng = sys.argv[2] if len(sys.argv) > 2 else f"D:/animation/tools/{basename}.apng"

    workdir = f"D:/animation/tools/_chroma_work"
    raw_dir = os.path.join(workdir, "raw")
    key_dir = os.path.join(workdir, "keyed")
    # Clean up any leftover from previous crashed runs
    if os.path.exists(workdir):
        shutil.rmtree(workdir)
    os.makedirs(raw_dir, exist_ok=True)
    os.makedirs(key_dir, exist_ok=True)

    # Step 1: Extract all frames
    print(f"[1/5] Extracting frames from {input_video}...")
    subprocess.run([
        "ffmpeg", "-y", "-i", input_video,
        os.path.join(raw_dir, "frame_%03d.png")
    ], capture_output=True)
    raw_frames = sorted(glob.glob(os.path.join(raw_dir, "*.png")))
    print(f"      {len(raw_frames)} frames extracted")

    # Step 2: Downsample to target FPS (take every Nth frame)
    # Assume source is 24fps
    step = max(1, round(24 / TARGET_FPS))
    selected = raw_frames[::step]
    print(f"[2/5] Downsampled {len(raw_frames)} → {len(selected)} frames ({TARGET_FPS}fps)")

    # Step 3: Chroma key + resize + quantize
    print(f"[3/5] Chroma keying + resize to {TARGET_HEIGHT}px + quantize to {MAX_COLORS} colors...")
    for i, f in enumerate(selected):
        img = Image.open(f).convert('RGBA')

        # Chroma key
        img = chroma_key_frame(img)

        # Resize
        ratio = TARGET_HEIGHT / img.height
        new_w = int(img.width * ratio)
        img = img.resize((new_w, TARGET_HEIGHT), Image.LANCZOS)

        # Quantize (unified per-frame for now; can upgrade to global palette later)
        img = img.quantize(colors=MAX_COLORS, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE).convert('RGBA')

        img.save(os.path.join(key_dir, f"frame_{i+1:03d}.png"), optimize=True)
        if (i + 1) % 10 == 0:
            print(f"      {i+1}/{len(selected)} frames done")

    print(f"      All {len(selected)} frames processed")

    # Step 4: Assemble APNG
    print(f"[4/5] Assembling APNG (plays={PLAYS})...")
    result = subprocess.run([
        "ffmpeg", "-y", "-framerate", str(TARGET_FPS),
        "-i", os.path.join(key_dir, "frame_%03d.png"),
        "-plays", str(PLAYS), "-f", "apng", output_apng
    ], capture_output=True, text=True)

    size_kb = os.path.getsize(output_apng) / 1024
    print(f"[5/5] Done! → {output_apng} ({size_kb:.0f}KB)")

    if size_kb > 500:
        print(f"      WARNING: File > 500KB, consider reducing TARGET_HEIGHT or MAX_COLORS")

    # Cleanup
    shutil.rmtree(workdir)
    print("      Temp files cleaned up")


if __name__ == "__main__":
    main()
