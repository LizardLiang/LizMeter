import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { AvatarPaths, WidgetControlAction, WidgetTimerSnapshot } from "../../src/shared/types.ts";

contextBridge.exposeInMainWorld("widgetAPI", {
  onStateUpdate: (callback: (snapshot: WidgetTimerSnapshot) => void) => {
    const handler = (_event: IpcRendererEvent, snapshot: WidgetTimerSnapshot) => callback(snapshot);
    ipcRenderer.on("widget:state-push", handler);
    return () => ipcRenderer.removeListener("widget:state-push", handler);
  },
  sendControl: (action: WidgetControlAction) => {
    ipcRenderer.send("widget:control", action);
  },
  requestState: () => {
    ipcRenderer.send("widget:request-state");
  },
  getAvatarPaths: (): Promise<AvatarPaths> => ipcRenderer.invoke("widget:avatar-get-paths"),
  onAvatarsUpdated: (callback: (avatars: AvatarPaths) => void) => {
    const handler = (_event: IpcRendererEvent, avatars: AvatarPaths) => callback(avatars);
    ipcRenderer.on("widget:avatars-updated", handler);
    return () => ipcRenderer.removeListener("widget:avatars-updated", handler);
  },
});