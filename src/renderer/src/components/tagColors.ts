export const TAG_COLORS = [
  "#7aa2f7", // blue
  "#bb9af7", // purple
  "#7dcfff", // cyan
  "#9ece6a", // green
  "#f7768e", // red
  "#ff9e64", // orange
  "#e0af68", // yellow
  "#c678dd", // magenta
] as const;

export type TagColor = (typeof TAG_COLORS)[number];
