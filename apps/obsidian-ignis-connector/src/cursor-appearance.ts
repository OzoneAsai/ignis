// Appearance is a LOCAL viewing preference, never a collaboration identity
// field. Every peer's position, name and wire-assigned color remain intact.
export type CursorAppearance = {
  calm: boolean;
  width: 1 | 2 | 3;
};
export const NORMAL_CURSOR_APPEARANCE: CursorAppearance = {
  calm: false, width: 1
};
export function safeCalmCursorWidth(value: unknown): 1 | 2 | 3 {
  return value === 1 || value === 2 || value === 3 ? value : 1;
}

export function displayCursorColor(
  original: string, calm: boolean, darkTheme: boolean
): string {
  const valid = /^#[0-9a-f]{6}$/i.test(original || "");
  const color = valid ? original : "#59baf2";
  if (!calm) return color;
  // Keep a small amount of the participant's hue for distinction, but
  // render mainly with a low-chroma slate. In dark themes, use a lighter
  // neutral so a truly dark caret does not vanish into the editor.
  const neutral = darkTheme ? [126, 138, 150] : [66, 77, 90];
  const source = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
  return "#" + source.map((channel, index) =>
    Math.round(neutral[index] * 0.86 + channel * 0.14)
      .toString(16).padStart(2, "0")).join("");
}

export function cursorPaintStyle(
  original: string, appearance: CursorAppearance, darkTheme = false
) {
  const calm = appearance.calm === true;
  return {
    color: displayCursorColor(original, calm, darkTheme),
    width: calm ? safeCalmCursorWidth(appearance.width) : 2,
    highlightOpacity: calm ? 0.08 : 0.24,
    labelFontSize: calm ? "10px" : "11px",
    labelPadding: calm ? "1px 3px" : "2px 5px",
    labelFontWeight: calm ? "500" : "600"
  };
}
