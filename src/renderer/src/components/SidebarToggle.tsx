import styles from "./SidebarToggle.module.scss";

interface Props {
  isOpen: boolean;
  onToggle: () => void;
}

export function SidebarToggle({ isOpen, onToggle }: Props) {
  const chevron = isOpen ? "›" : "‹";
  const label = isOpen ? "Collapse sidebar" : "Expand sidebar";

  return (
    <button className={styles.btn} onClick={onToggle} aria-label={label} title={label}>
      {chevron}
    </button>
  );
}
