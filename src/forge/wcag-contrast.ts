/**
 * @module forge/wcag-contrast
 *
 * WCAG 2.1 relative-luminance and contrast-ratio primitives.
 *
 * Pure, zero-dependency math used by:
 *   - the constraints-manifest contrast regression test,
 *   - the S4 visual critic (to cite contrast violations as machine-readable diffs),
 *   - any forge codegen that must validate a token pair before emitting CSS.
 *
 * Reference: https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
 *            https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio
 */

/** WCAG AA minimum contrast ratio for normal-size text (< 18pt / < 14pt bold). */
export const AA_NORMAL_TEXT = 4.5;
/** WCAG AA minimum contrast ratio for large text (≥ 18pt / ≥ 14pt bold) and UI components. */
export const AA_LARGE_TEXT = 3.0;

/**
 * Parse a 3- or 6-digit hex color (with or without leading `#`) into [r, g, b] (0–255).
 * Throws on malformed input — forge tokens are authored by hand, so fail loudly.
 */
export function parseHex(hex: string): readonly [number, number, number] {
  const cleaned = hex.trim().replace(/^#/, "");
  const expanded =
    cleaned.length === 3
      ? cleaned.split("").map((c) => c + c).join("")
      : cleaned;
  if (!/^[0-9a-fA-F]{6}$/.test(expanded)) {
    throw new Error(`wcag-contrast: "${hex}" is not a valid 3- or 6-digit hex color`);
  }
  return [
    parseInt(expanded.slice(0, 2), 16),
    parseInt(expanded.slice(2, 4), 16),
    parseInt(expanded.slice(4, 6), 16)
  ] as const;
}

/** Linearize an 8-bit sRGB channel value per WCAG. */
function linearizeChannel(value8bit: number): number {
  const c = value8bit / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG 2.1 relative luminance (0 = black, 1 = white) of a hex color. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return (
    0.2126 * linearizeChannel(r) +
    0.7152 * linearizeChannel(g) +
    0.0722 * linearizeChannel(b)
  );
}

/**
 * WCAG 2.1 contrast ratio between two hex colors. Returns a value in [1, 21].
 * Order-independent (ratio of foreground to background is symmetric here).
 */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** True when `foreground` text on `background` meets WCAG AA for the given text size. */
export function meetsAA(foreground: string, background: string, largeText = false): boolean {
  const threshold = largeText ? AA_LARGE_TEXT : AA_NORMAL_TEXT;
  return contrastRatio(foreground, background) >= threshold;
}
