import styles from "./TagColorPicker.module.scss";
import { TAG_COLORS } from "./tagColors.ts";

interface Props {
  value: string;
  onChange: (color: string) => void;
}

export function TagColorPicker({ value, onChange }: Props) {
  return (
    <div className={styles.container}>
      {TAG_COLORS.map((color) => {
        const isSelected = color === value;
        return (
          <button
            key={color}
            className={styles.swatch}
            style={{
              backgroundColor: color,
              border: isSelected ? `2px solid #c0caf5` : `2px solid transparent`,
              outline: isSelected ? `1px solid ${color}` : "none",
            }}
            onClick={() => onChange(color)}
            aria-label={color}
            aria-pressed={isSelected}
          />
        );
      })}
    </div>
  );
}
