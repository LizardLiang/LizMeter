import type { ElectronAPI } from "../../shared/types.ts";

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
