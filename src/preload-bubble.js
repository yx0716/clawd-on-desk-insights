const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bubbleAPI", {
  onPermissionShow: (cb) => ipcRenderer.on("permission-show", (_, data) => cb(data)),
  decide: (behavior) => ipcRenderer.send("permission-decide", behavior),
  onPermissionHide: (cb) => ipcRenderer.on("permission-hide", () => cb()),
});
