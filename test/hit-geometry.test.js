const { describe, it } = require("node:test");
const assert = require("node:assert");
const path = require("path");

const themeLoader = require("../src/theme-loader");
const hitGeometry = require("../src/hit-geometry");

themeLoader.init(path.join(__dirname, "..", "src"));
const calico = themeLoader.loadTheme("calico");
const clawd = themeLoader.loadTheme("clawd");

function approx(actual, expected, epsilon = 0.01) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`
  );
}

describe("hit geometry", () => {
  const bounds = { x: 0, y: 0, width: 200, height: 200 };

  it("matches bottom-anchored SVG layout for calico idle", () => {
    const rect = hitGeometry.getAssetRectScreen(calico, bounds, "idle", "calico-idle-follow.svg");
    approx(rect.x, 42);
    approx(rect.y, 37.39);
    approx(rect.w, 116);
    approx(rect.h, 87.22);
  });

  it("matches APNG layout with file scale and offsets for calico mini idle", () => {
    const rect = hitGeometry.getAssetRectScreen(calico, bounds, "mini-idle", "calico-mini-idle.apng");
    approx(rect.x, 42);
    approx(rect.y, 21.24);
    approx(rect.w, 138);
    approx(rect.h, 103.76);
  });

  it("expands mini hit rect with sticky hover padding", () => {
    const hitBox = calico.hitBoxes.default;
    const base = hitGeometry.getHitRectScreen(calico, bounds, "mini-idle", "calico-mini-idle.apng", hitBox);
    const padded = hitGeometry.getHitRectScreen(
      calico,
      bounds,
      "mini-idle",
      "calico-mini-idle.apng",
      hitBox,
      { padX: 25, padY: 8 }
    );

    approx(padded.left, base.left - 25);
    approx(padded.right, base.right + 25);
    approx(padded.top, base.top - 8);
    approx(padded.bottom, base.bottom + 8);
  });

  it("derives image sizing from object fit for clawd drag svg", () => {
    const rect = hitGeometry.getAssetRectScreen(clawd, bounds, null, "clawd-react-drag.svg");
    approx(rect.x, -30);
    approx(rect.y, -50);
    approx(rect.w, 260);
    approx(rect.h, 260);
  });
});
