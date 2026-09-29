/**
 * Control-byte stripping for repository-derived text, applied where evidence
 * enters the index so it covers every collector and every later consumer.
 *
 * Commit messages were already scrubbed at the git boundary, but the rest of the
 * text was not, and the fields that *were* scrubbed were only scrubbed on one of
 * the two collection paths. Anything unscrubbed reaches a terminal through
 * `handover risk` / `bus-factor`, and the book through `cat`, a wiki or an
 * editor — where `ESC [ 2 J` is "clear the screen" and the forged line after it
 * reads as the tool's own output. For a product whose whole promise is "a human
 * should confirm this", impersonating the tool in its own output is the failure
 * to prevent.
 */

/**
 * C0 controls except tab (\x09) and newline (\x0a), DEL, and the C1 range
 * (\x80-\x9f) — U+009B is an 8-bit CSI, which a terminal not in UTF-8 mode would
 * honour exactly as it honours ESC-[. A carriage return is stripped too: an
 * isolated \x0d does not start a new line anywhere the book is read, but on a
 * terminal it rewinds the cursor and the rest of the line overwrites what the
 * tool printed before it — a forged "the tool said" with no escape code at all.
 */
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0d\x0e-\x1f\x7f-\x9f]/g;

/**
 * Invisible Unicode that reorders or hides: the bidi controls (U+202A-202E,
 * U+2066-2069) that make trojan-source-style renders read one way and compile
 * another, the LRM/RLM marks (U+200E-200F) that steer them, and zero-width
 * characters (U+200B-200D, U+2060-2064, U+FEFF) that hide tokens from a reader
 * while keeping them meaningful to a parser. None of them belong in evidence
 * text, so they are dropped in both prose and tokens.
 */
const INVISIBLE_CHARS = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/**
 * Prose — commit messages, titles, bodies, captured answers. Newlines and tabs
 * carry meaning, so other controls become spaces rather than disappearing into
 * the surrounding words. Invisible characters have no width and separate no
 * words, so they are removed outright.
 */
export function sanitizeProse(text: string): string {
  return text.replace(CONTROL_CHARS, ' ').replace(INVISIBLE_CHARS, '');
}

/**
 * Single-token fields — logins, paths, labels, repository keys. These contain no
 * whitespace in any real value, so the controls are simply dropped.
 */
export function sanitizeToken(text: string): string {
  return text.replace(CONTROL_CHARS, '').replace(INVISIBLE_CHARS, '');
}
