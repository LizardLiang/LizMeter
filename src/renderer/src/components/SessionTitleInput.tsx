// src/renderer/src/components/SessionTitleInput.tsx
// Text input for session title

interface SessionTitleInputProps {
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
  disabled?: boolean;
}

export function SessionTitleInput({
  value,
  onChange,
  maxLength = 500,
  disabled = false,
}: SessionTitleInputProps) {
  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "8px 12px",
    fontSize: "1rem",
    borderRadius: "6px",
    border: "1px solid #292e42",
    outline: "none",
    boxSizing: "border-box",
    backgroundColor: disabled ? "#16213e" : "#1a1b2e",
    color: disabled ? "#565f89" : "#c0caf5",
    cursor: disabled ? "not-allowed" : "text",
  };

  const labelStyle: React.CSSProperties = {
    display: "block",
    marginBottom: "6px",
    fontSize: "0.875rem",
    fontWeight: "600",
    color: "#a9b1d6",
  };

  return (
    <div style={{ padding: "8px 0" }}>
      <label htmlFor="session-title" style={labelStyle}>
        Session Title (optional)
      </label>
      <input
        id="session-title"
        type="text"
        style={inputStyle}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="What are you working on?"
        maxLength={maxLength}
        disabled={disabled}
      />
    </div>
  );
}
