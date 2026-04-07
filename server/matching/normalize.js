/**
 * Normalize a Magic: The Gathering collector number into
 * a base numeric portion and an optional suffix.
 *
 * Examples:
 *   "250"    → { base: "250",  suffix: "",  raw: "250" }
 *   "250p"   → { base: "250",  suffix: "p", raw: "250p" }
 *   "250★"   → { base: "250",  suffix: "★", raw: "250★" }
 *   "0250"   → { base: "250",  suffix: "",  raw: "0250" }
 *   "123a"   → { base: "123",  suffix: "a", raw: "123a" }
 *   ""       → { base: "",     suffix: "",  raw: "" }
 *   null     → { base: "",     suffix: "",  raw: "" }
 *
 * @param {string|null|undefined} cn - Raw collector number string
 * @returns {{ base: string, suffix: string, raw: string }}
 */
export function normalizeCollectorNumber(cn) {
  // Handle null, undefined, or empty input
  if (cn == null || cn === "") {
    return { base: "", suffix: "", raw: "" };
  }

  // Convert to string and trim whitespace
  const raw = String(cn).trim();

  // If the trimmed result is empty, return empty
  if (raw === "") {
    return { base: "", suffix: "", raw: "" };
  }

  // Main pattern:
  //   ^       — start of string
  //   (0*)    — capture group 1: any leading zeros
  //   (\d+)   — capture group 2: the actual number (one or more digits)
  //   (.*)    — capture group 3: everything after the number (suffix)
  //   $       — end of string
  const match = raw.match(/^(0*)(\d+)(.*)$/);

  if (match) {
    const leadingZeros = match[1]; // e.g., "0" from "0250"
    const digits = match[2];       // e.g., "250" from "0250" or "250p"
    const suffixRaw = match[3];    // e.g., "p" from "250p" or "" from "250"

    return {
      base: digits,                          // "250" — no leading zeros
      suffix: suffixRaw.toLowerCase(),       // "p", "★", "s", "a", or ""
      raw: raw                               // original untouched string
    };
  }

  // If the collector number doesn't start with digits at all
  // (rare, but possible — e.g., some special promos)
  // Treat the whole thing as the base, no suffix
  return {
    base: raw.toLowerCase(),
    suffix: "",
    raw: raw
  };
}

/**
 * Check if two collector numbers are an exact match.
 *
 * Both the base number and suffix must be identical.
 */
export function isExactCNMatch(cn1, cn2) {
  return cn1.base === cn2.base && cn1.suffix === cn2.suffix;
}

/**
 * Check if two collector numbers are a "promo variant" near-match.
 *
 * The base number is the same, but the suffixes differ.
 * This catches cases like 250 vs 250p, 123 vs 123★, etc.
 */
export function isPromoVariantCNMatch(cn1, cn2) {
  // Bases must be the same
  if (cn1.base !== cn2.base) return false;

  // Bases must not be empty (two empty CNs shouldn't count as promo variant)
  if (cn1.base === "") return false;

  // Suffixes must be different
  return cn1.suffix !== cn2.suffix;
}

/**
 * Check if two collector numbers are truly different.
 *
 * The base numbers are different, meaning these are different
 * printings within the same set — not just promo variants.
 */
export function isDifferentCN(cn1, cn2) {
  return cn1.base !== cn2.base;
}