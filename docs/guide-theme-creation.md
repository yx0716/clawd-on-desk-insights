# Theme Creation Guide

Create your own Clawd desktop pet theme with custom characters and animations.

## Quick Start

1. Copy the template:
   ```bash
   cp -r themes/template ~/.config/clawd-on-desk/themes/my-theme   # Linux/macOS
   # or
   xcopy /E themes\template "%APPDATA%\clawd-on-desk\themes\my-theme\"  # Windows
   ```

2. Edit `theme.json` — set your theme name, author, and file mappings

3. Create your assets in the `assets/` folder

4. Restart Clawd → right-click → Theme → select your theme

5. (Optional) Validate:
   ```bash
   node scripts/validate-theme.js ~/.config/clawd-on-desk/themes/my-theme
   ```

## Theme Directory Structure

```
my-theme/
  theme.json              ← Configuration (required)
  assets/
    idle-follow.svg       ← Idle animation with eye tracking (SVG required if eyeTracking enabled)
    thinking.gif          ← Any format: SVG, GIF, APNG, WebP
    typing.gif
    error.gif
    happy.gif
    notification.gif
    sleeping.gif
    waking.gif
    ...                   ← Additional animations for reactions, tiers, etc.
```

## Creation Tiers

### Beginner: Swap Art + GIF Animations (Hours)

**Minimum viable theme: 1 SVG + 7 GIF/APNG files.**

1. Start from `themes/template/`
2. Edit `assets/idle-follow.svg` — replace the placeholder shapes inside `#body-js` and `#eyes-js` with your character
3. Create simple frame animations (4-12 frames) for other states using [Piskel](https://www.piskelapp.com/) (free, browser-based) or [Aseprite](https://www.aseprite.org/) (paid, pixel art pro tool)
4. Export as APNG (best quality) or GIF (pixel art works fine)
5. Update `theme.json` to point to your files

**Recommended workflow for character art:**
- AI image generation (Midjourney, Stable Diffusion) → transparent PNG
- Or hand-draw in any pixel art editor
- Remove background with [remove.bg](https://www.remove.bg/) or `rembg` (Python CLI)

### Intermediate: Full Animation Set (1-2 Days)

Everything from beginner, plus:
- Custom working tiers (typing → juggling → building)
- Click reactions (poke left/right, double-click flail)
- Idle random animations (reading, looking around)
- Sleep sequence (yawning → collapsing → sleeping)
- Mini mode support (8 additional mini animations)

### Advanced: Full SVG + CSS Animations (Unlimited)

Skip the template entirely. Author all animations as SVG with CSS `@keyframes`:
- Infinite scalability (no pixelation at any zoom level)
- CSS animation control (timing, easing, iteration)
- SVG filter effects (blur, glow, drop-shadow)
- Reference `assets/svg/clawd-*.svg` in the repo for examples

## theme.json Reference

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `schemaVersion` | `1` | Must be `1` |
| `name` | string | Display name |
| `version` | string | Semver (e.g. `"1.0.0"`) |
| `viewBox` | object | `{ x, y, width, height }` — logical canvas in SVG units |
| `states` | object | Maps state names to file arrays (see below) |

### Required States

Every theme must define these states (each is an array of filenames):

| State | When | Notes |
|-------|------|-------|
| `idle` | No agent activity | Must be SVG if eye tracking enabled |
| `thinking` | User submitted prompt | |
| `working` | Agent using tools | Default for 1-session working |
| `sleeping` | After sleep sequence | |
| `waking` | Mouse wakes from sleep | |

### Optional States

| State | When | Fallback if omitted |
|-------|------|---------------------|
| `yawning` | Sleep sequence start | Skipped |
| `dozing` | After yawning | Skipped |
| `collapsing` | Falling asleep | Skipped |
| `error` | Tool failure | Uses `working` |
| `attention` | Task completed | Uses `idle` |
| `notification` | Permission / alert | Uses `idle` |
| `sweeping` | Context compaction | Uses `working` |
| `carrying` | Worktree creation | Uses `working` |
| `juggling` | Subagent active | Uses `working` |

### Eye Tracking

Eye tracking makes the character follow the user's cursor. It requires the idle SVG to contain specific element IDs.

```json
"eyeTracking": {
  "enabled": true,
  "states": ["idle"],
  "ids": {
    "eyes": "eyes-js",
    "body": "body-js",
    "shadow": "shadow-js"
  }
}
```

**How it works:**
- `#eyes-js` — receives `translate(dx, dy)` to follow cursor (max 3px)
- `#body-js` — receives a smaller translate for subtle body lean (optional)
- `#shadow-js` — receives translate + scaleX for shadow stretch toward cursor (optional)

**To disable eye tracking:** set `"enabled": false`. All states can then use any format (GIF, APNG, WebP). Your idle animation will just loop without cursor following.

### Working Tiers

Different animations based on how many agent sessions are running concurrently:

```json
"workingTiers": [
  { "minSessions": 3, "file": "building.gif" },
  { "minSessions": 2, "file": "juggling.gif" },
  { "minSessions": 1, "file": "typing.gif" }
]
```

### Reactions

Click and drag response animations:

```json
"reactions": {
  "drag":       { "file": "react-drag.gif" },
  "clickLeft":  { "file": "react-left.gif",  "duration": 2500 },
  "clickRight": { "file": "react-right.gif", "duration": 2500 },
  "annoyed":    { "file": "react-annoyed.gif", "duration": 3500 },
  "double":     { "files": ["react-double.gif"], "duration": 3500 }
}
```

- `drag` — plays while being dragged (no duration, loops until released)
- `clickLeft` / `clickRight` — double-click reaction, direction-aware
- `annoyed` — 50% chance on double-click instead of directional
- `double` — 4-click rapid reaction, `files` array for random selection

Omit the entire `reactions` block to disable all click reactions.

### Idle Animations

Random animations played during idle periods:

```json
"idleAnimations": [
  { "file": "idle-look.gif", "duration": 6500 },
  { "file": "idle-reading.gif", "duration": 14000 }
]
```

### Hit Boxes

Clickable area in viewBox units. Only the `default` hitbox is required:

```json
"hitBoxes": {
  "default":  { "x": -1, "y": 5, "w": 17, "h": 12 },
  "sleeping": { "x": -2, "y": 9, "w": 19, "h": 7 },
  "wide":     { "x": -3, "y": 3, "w": 21, "h": 14 }
},
"sleepingHitboxFiles": ["sleeping.gif"],
"wideHitboxFiles": ["error.gif", "notification.gif"]
```

### Mini Mode

Mini mode hides the character at the screen edge. Set `"supported": false` or omit the block to skip:

```json
"miniMode": {
  "supported": true,
  "offsetRatio": 0.486,
  "states": {
    "mini-idle":   ["mini-idle.svg"],
    "mini-enter":  ["mini-enter.gif"],
    "mini-peek":   ["mini-peek.gif"],
    "mini-alert":  ["mini-alert.gif"],
    "mini-happy":  ["mini-happy.gif"],
    "mini-sleep":  ["mini-sleep.gif"],
    "mini-crabwalk": ["mini-crabwalk.gif"],
    "mini-enter-sleep": ["mini-enter-sleep.gif"]
  }
}
```

Mini mode requires 8 additional animations. `mini-idle` should be SVG if eye tracking is enabled for it.

### Timings

All values in milliseconds. Omit any to use defaults:

```json
"timings": {
  "mouseIdleTimeout": 20000,
  "mouseSleepTimeout": 60000,
  "yawnDuration": 3000,
  "wakeDuration": 1500,
  "deepSleepTimeout": 600000,
  "minDisplay": {
    "attention": 4000,
    "error": 5000,
    "working": 1000
  },
  "autoReturn": {
    "attention": 4000,
    "error": 5000
  }
}
```

### Object Scale

Fine-tune rendered size relative to viewBox. Defaults work for most themes:

```json
"objectScale": {
  "widthRatio": 1.9,
  "heightRatio": 1.3,
  "offsetX": -0.45,
  "offsetY": -0.25
}
```

## Asset Guidelines

### Supported Formats

| Format | Best for | Eye tracking | Notes |
|--------|----------|-------------|-------|
| SVG | Idle states, all animations | Yes (with IDs) | Infinite scale, CSS animations |
| APNG | Frame animations | No | Best quality, alpha channel |
| GIF | Pixel art animations | No | Binary transparency only |
| WebP | Photo-style animations | No | Good compression |

### Canvas Size

All assets should share the same logical canvas defined by `viewBox`. For raster formats (GIF/APNG/WebP):
- Export at 2x-3x the viewBox dimensions for crisp rendering
- Example: viewBox 45x45 → export GIFs at 90x90 or 135x135 pixels
- Keep the character positioned consistently across all frames

### SVG Eye Tracking Structure

For SVGs that need eye tracking, include these groups with exact IDs:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="-15 -25 45 45">
  <!-- Bottom layer: shadow (optional) -->
  <g id="shadow-js" style="transform-origin: 7.5px 15px">
    <ellipse cx="7.5" cy="16" rx="6" ry="1.5" fill="rgba(0,0,0,0.15)"/>
  </g>

  <!-- Middle layer: character body (optional, enables lean effect) -->
  <g id="body-js">
    <!-- Your character body here -->
  </g>

  <!-- Top layer: eyes (required for eye tracking) -->
  <g id="eyes-js">
    <!-- Your character eyes here -->
  </g>
</svg>
```

## Validation

Run the validator before distributing your theme:

```bash
node scripts/validate-theme.js path/to/your-theme
```

The validator checks:
- `theme.json` schema (required fields, types, schemaVersion)
- Asset file existence (all referenced files)
- Eye tracking SVG structure (required IDs)
- Hit box configuration

## Debugging Tips

- **Theme not appearing in menu?** Check that `theme.json` is valid JSON (no trailing commas, no comments — use `_comment` fields instead)
- **Assets not loading?** Check file names match exactly (case-sensitive on Linux/macOS)
- **Eye tracking not working?** Verify your SVG has `id="eyes-js"` on the eye group, and `eyeTracking.enabled` is `true`
- **Character jumping between states?** Ensure all assets share the same canvas size and character position
- **Animation not looping?** GIF/APNG must be set to loop; SVG CSS `@keyframes` need `infinite` iteration

## Distribution

### As a GitHub repository
1. Create a repo with your theme folder structure
2. Users clone/download to their themes directory
3. Include a screenshot or GIF preview in your README

### As a zip file
1. Zip the theme folder (the folder containing `theme.json`)
2. Users extract to `{userData}/themes/`
   - Windows: `%APPDATA%/clawd-on-desk/themes/`
   - macOS: `~/Library/Application Support/clawd-on-desk/themes/`
   - Linux: `~/.config/clawd-on-desk/themes/`

## Theme Installation (User Side)

1. Download/clone the theme to the themes directory (see paths above)
2. Restart Clawd or switch theme via right-click → Theme menu
3. The theme appears in the menu by its `name` field from `theme.json`

> **Security note:** Third-party SVG files are automatically sanitized — `<script>`, event handlers, and `javascript:` URLs are stripped before rendering.
