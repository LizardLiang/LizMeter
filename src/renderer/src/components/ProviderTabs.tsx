// src/renderer/src/components/ProviderTabs.tsx
// Reusable provider tab switcher — renders tab buttons for GitHub and/or Linear

import styles from "./ProviderTabs.module.scss";

export type ProviderTabId = "github" | "linear";

interface Props {
  providers: ProviderTabId[];
  activeProvider: ProviderTabId;
  onSwitch: (provider: ProviderTabId) => void;
}

const PROVIDER_LABELS: Record<ProviderTabId, string> = {
  github: "GitHub",
  linear: "Linear",
};

export function ProviderTabs({ providers, activeProvider, onSwitch }: Props) {
  return (
    <div className={styles.tabs}>
      {providers.map((provider) => (
        <button
          key={provider}
          className={provider === activeProvider ? styles.tabActive : styles.tab}
          onClick={() => onSwitch(provider)}
          aria-selected={provider === activeProvider}
          role="tab"
        >
          {PROVIDER_LABELS[provider]}
        </button>
      ))}
    </div>
  );
}
