const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  showContextMenu: () => ipcRenderer.send("show-context-menu"),
  moveWindowBy: (dx, dy) => ipcRenderer.send("move-window-by", dx, dy),
  onStateChange: (callback) => ipcRenderer.on("state-change", (_, state, svg) => callback(state, svg)),
  onEyeMove: (callback) => ipcRenderer.on("eye-move", (_, dx, dy) => callback(dx, dy)),
  onWakeFromDoze: (callback) => ipcRenderer.on("wake-from-doze", () => callback()),
  eyeTrackingReady: () => ipcRenderer.send("eye-tracking-ready"),
  pauseCursorPolling: () => ipcRenderer.send("pause-cursor-polling"),
  resumeFromReaction: () => ipcRenderer.send("resume-from-reaction"),
  onDndChange: (callback) => ipcRenderer.on("dnd-change", (_, enabled) => callback(enabled)),
  dragLock: (locked) => ipcRenderer.send("drag-lock", locked),
  onMiniModeChange: (cb) => ipcRenderer.on("mini-mode-change", (_, enabled) => cb(enabled)),
  exitMiniMode: () => ipcRenderer.send("exit-mini-mode"),
  dragEnd: () => ipcRenderer.send("drag-end"),
  focusTerminal: () => ipcRenderer.send("focus-terminal"),
  showSessionMenu: () => ipcRenderer.send("show-session-menu"),
});
