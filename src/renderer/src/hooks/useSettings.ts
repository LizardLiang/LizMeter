// src/renderer/src/hooks/useSettings.ts
// Custom hook for loading and saving timer settings

import { useEffect, useState } from "react";
import type { TimerSettings } from "../../../shared/types.ts";

export interface UseSettingsReturn {
  settings: TimerSettings | null;
  isLoading: boolean;
  saveSettings: (settings: TimerSettings) => Promise<void>;
}

export function useSettings(): UseSettingsReturn {
  const [settings, setSettings] = useState<TimerSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    window.electronAPI.settings
      .get()
      .then((s) => {
        setSettings(s);
      })
      .catch(() => {
        // Fall back to hardcoded defaults on load failure
        setSettings({
          workDuration: 1500,
          shortBreakDuration: 300,
          longBreakDuration: 900,
        });
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, []);

  const saveSettings = async (newSettings: TimerSettings): Promise<void> => {
    await window.electronAPI.settings.save(newSettings);
    setSettings(newSettings);
  };

  return { settings, isLoading, saveSettings };
}
