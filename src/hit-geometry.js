"use strict";

function usesObjectChannel(theme, state, file) {
  if (!theme || !file || !file.endsWith(".svg")) return false;
  const eyeStates = theme.eyeTracking && theme.eyeTracking.enabled
    ? (theme.eyeTracking.states || [])
    : [];
  return eyeStates.includes(state);
}

function getFileLayout(theme, file) {
  const os = (theme && theme.objectScale) || {};
  const fileOffsets = os.fileOffsets || {};
  const fileScales = os.fileScales || {};
  const offset = fileOffsets[file] || {};
  return {
    widthRatio: os.widthRatio || 1.9,
    heightRatio: os.heightRatio || 1.3,
    imgWidthRatio: os.imgWidthRatio || os.widthRatio || 1.9,
    offsetX: os.offsetX || 0,
    imgOffsetX: os.imgOffsetX != null ? os.imgOffsetX : (os.offsetX || 0),
    objBottom: os.objBottom != null ? os.objBottom : (1 - (os.offsetY || 0) - (os.heightRatio || 1.3)),
    imgBottom: os.imgBottom != null ? os.imgBottom : 0.05,
    fileScale: fileScales[file] || 1,
    offsetPxX: offset.x || 0,
    offsetPxY: offset.y || 0,
  };
}

function fitViewBoxIntoRect(outerRect, viewBox) {
  const scale = Math.min(outerRect.w / viewBox.width, outerRect.h / viewBox.height);
  const width = viewBox.width * scale;
  const height = viewBox.height * scale;
  return {
    x: outerRect.x + (outerRect.w - width) / 2,
    y: outerRect.y + (outerRect.h - height) / 2,
    w: width,
    h: height,
  };
}

function getAssetRectScreen(theme, bounds, state, file) {
  if (!theme || !bounds) return null;

  const viewBox = theme.viewBox;
  const layout = getFileLayout(theme, file);
  const left = bounds.x + bounds.width * layout.offsetX + layout.offsetPxX;

  if (usesObjectChannel(theme, state, file)) {
    const outerRect = {
      x: left,
      y: bounds.y + bounds.height
        - bounds.height * layout.heightRatio
        - bounds.height * layout.objBottom
        - layout.offsetPxY,
      w: bounds.width * layout.widthRatio,
      h: bounds.height * layout.heightRatio,
    };
    return fitViewBoxIntoRect(outerRect, viewBox);
  }

  const width = bounds.width * layout.imgWidthRatio * layout.fileScale;
  const height = width * (viewBox.height / viewBox.width);
  return {
    x: bounds.x + bounds.width * layout.imgOffsetX + layout.offsetPxX,
    y: bounds.y + bounds.height - height - bounds.height * layout.imgBottom - layout.offsetPxY,
    w: width,
    h: height,
  };
}

function getHitRectScreen(theme, bounds, state, file, hitBox, options = {}) {
  if (!theme || !bounds || !hitBox) return null;

  const artRect = getAssetRectScreen(theme, bounds, state, file);
  if (!artRect) return null;

  const vb = theme.viewBox;
  const scaleX = artRect.w / vb.width;
  const scaleY = artRect.h / vb.height;
  const padX = options.padX || 0;
  const padY = options.padY || 0;

  return {
    left: artRect.x + (hitBox.x - vb.x) * scaleX - padX,
    top: artRect.y + (hitBox.y - vb.y) * scaleY - padY,
    right: artRect.x + (hitBox.x - vb.x + hitBox.w) * scaleX + padX,
    bottom: artRect.y + (hitBox.y - vb.y + hitBox.h) * scaleY + padY,
  };
}

module.exports = {
  getAssetRectScreen,
  getHitRectScreen,
  usesObjectChannel,
};
