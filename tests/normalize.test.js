import { describe, test, expect } from "vitest";
import {
  normalizeCollectorNumber,
  isExactCNMatch,
  isPromoVariantCNMatch,
  isDifferentCN,
} from "../server/matching/normalize.js";
// ============================================================
// Tests for normalizeCollectorNumber
// ============================================================

describe("normalizeCollectorNumber", () => {
  // --- Basic numbers ---

  test("simple number: '250'", () => {
    expect(normalizeCollectorNumber("250")).toEqual({
      base: "250",
      suffix: "",
      raw: "250",
    });
  });

  test("single digit: '1'", () => {
    expect(normalizeCollectorNumber("1")).toEqual({
      base: "1",
      suffix: "",
      raw: "1",
    });
  });

  test("large number: '999'", () => {
    expect(normalizeCollectorNumber("999")).toEqual({
      base: "999",
      suffix: "",
      raw: "999",
    });
  });

  // --- Promo suffixes ---

  test("promo suffix 'p': '250p'", () => {
    expect(normalizeCollectorNumber("250p")).toEqual({
      base: "250",
      suffix: "p",
      raw: "250p",
    });
  });

  test("star suffix: '250★'", () => {
    expect(normalizeCollectorNumber("250★")).toEqual({
      base: "250",
      suffix: "★",
      raw: "250★",
    });
  });

  test("prerelease suffix 's': '12s'", () => {
    expect(normalizeCollectorNumber("12s")).toEqual({
      base: "12",
      suffix: "s",
      raw: "12s",
    });
  });

  test("alpha variant suffix 'a': '123a'", () => {
    expect(normalizeCollectorNumber("123a")).toEqual({
      base: "123",
      suffix: "a",
      raw: "123a",
    });
  });

  test("suffix 'b': '123b'", () => {
    expect(normalizeCollectorNumber("123b")).toEqual({
      base: "123",
      suffix: "b",
      raw: "123b",
    });
  });

  // --- Leading zeros ---

  test("leading zero: '0250'", () => {
    expect(normalizeCollectorNumber("0250")).toEqual({
      base: "250",
      suffix: "",
      raw: "0250",
    });
  });

  test("multiple leading zeros: '00042'", () => {
    expect(normalizeCollectorNumber("00042")).toEqual({
      base: "42",
      suffix: "",
      raw: "00042",
    });
  });

  test("leading zero with suffix: '0250p'", () => {
    expect(normalizeCollectorNumber("0250p")).toEqual({
      base: "250",
      suffix: "p",
      raw: "0250p",
    });
  });

  // --- Empty / null / undefined ---

  test("empty string", () => {
    expect(normalizeCollectorNumber("")).toEqual({
      base: "",
      suffix: "",
      raw: "",
    });
  });

  test("null", () => {
    expect(normalizeCollectorNumber(null)).toEqual({
      base: "",
      suffix: "",
      raw: "",
    });
  });

  test("undefined", () => {
    expect(normalizeCollectorNumber(undefined)).toEqual({
      base: "",
      suffix: "",
      raw: "",
    });
  });

  test("whitespace only: '   '", () => {
    expect(normalizeCollectorNumber("   ")).toEqual({
      base: "",
      suffix: "",
      raw: "",
    });
  });

  // --- Non-numeric collector numbers ---

  test("purely alphabetic: 'SLD'", () => {
    expect(normalizeCollectorNumber("SLD")).toEqual({
      base: "sld",
      suffix: "",
      raw: "SLD",
    });
  });

  // --- Whitespace trimming ---

  test("whitespace around number: ' 250 '", () => {
    expect(normalizeCollectorNumber(" 250 ")).toEqual({
      base: "250",
      suffix: "",
      raw: "250",
    });
  });

  test("whitespace around number with suffix: ' 250p '", () => {
    expect(normalizeCollectorNumber(" 250p ")).toEqual({
      base: "250",
      suffix: "p",
      raw: "250p",
    });
  });

  // --- Suffix case normalization ---

  test("uppercase suffix is lowercased: '250P'", () => {
    expect(normalizeCollectorNumber("250P")).toEqual({
      base: "250",
      suffix: "p",
      raw: "250P",
    });
  });

  // --- Number passed as actual number type ---

  test("number type input: 250", () => {
    expect(normalizeCollectorNumber(250)).toEqual({
      base: "250",
      suffix: "",
      raw: "250",
    });
  });
});

// ============================================================
// Tests for isExactCNMatch
// ============================================================

describe("isExactCNMatch", () => {
  test("identical simple numbers", () => {
    const cn1 = normalizeCollectorNumber("250");
    const cn2 = normalizeCollectorNumber("250");
    expect(isExactCNMatch(cn1, cn2)).toBe(true);
  });

  test("identical with suffix", () => {
    const cn1 = normalizeCollectorNumber("250p");
    const cn2 = normalizeCollectorNumber("250p");
    expect(isExactCNMatch(cn1, cn2)).toBe(true);
  });

  test("leading zero vs no leading zero", () => {
    const cn1 = normalizeCollectorNumber("0250");
    const cn2 = normalizeCollectorNumber("250");
    expect(isExactCNMatch(cn1, cn2)).toBe(true);
  });

  test("different suffix is NOT exact", () => {
    const cn1 = normalizeCollectorNumber("250");
    const cn2 = normalizeCollectorNumber("250p");
    expect(isExactCNMatch(cn1, cn2)).toBe(false);
  });

  test("different base is NOT exact", () => {
    const cn1 = normalizeCollectorNumber("250");
    const cn2 = normalizeCollectorNumber("123");
    expect(isExactCNMatch(cn1, cn2)).toBe(false);
  });

  test("both empty", () => {
    const cn1 = normalizeCollectorNumber("");
    const cn2 = normalizeCollectorNumber("");
    expect(isExactCNMatch(cn1, cn2)).toBe(true);
  });

  test("both null", () => {
    const cn1 = normalizeCollectorNumber(null);
    const cn2 = normalizeCollectorNumber(null);
    expect(isExactCNMatch(cn1, cn2)).toBe(true);
  });
});

// ============================================================
// Tests for isPromoVariantCNMatch
// ============================================================

describe("isPromoVariantCNMatch", () => {
  test("250 vs 250p → promo variant", () => {
    const cn1 = normalizeCollectorNumber("250");
    const cn2 = normalizeCollectorNumber("250p");
    expect(isPromoVariantCNMatch(cn1, cn2)).toBe(true);
  });

  test("250 vs 250★ → promo variant", () => {
    const cn1 = normalizeCollectorNumber("250");
    const cn2 = normalizeCollectorNumber("250★");
    expect(isPromoVariantCNMatch(cn1, cn2)).toBe(true);
  });

  test("250p vs 250s → promo variant (both have suffixes)", () => {
    const cn1 = normalizeCollectorNumber("250p");
    const cn2 = normalizeCollectorNumber("250s");
    expect(isPromoVariantCNMatch(cn1, cn2)).toBe(true);
  });

  test("250 vs 250 → NOT promo variant (exact match)", () => {
    const cn1 = normalizeCollectorNumber("250");
    const cn2 = normalizeCollectorNumber("250");
    expect(isPromoVariantCNMatch(cn1, cn2)).toBe(false);
  });

  test("250 vs 123 → NOT promo variant (different base)", () => {
    const cn1 = normalizeCollectorNumber("250");
    const cn2 = normalizeCollectorNumber("123");
    expect(isPromoVariantCNMatch(cn1, cn2)).toBe(false);
  });

  test("empty vs empty → NOT promo variant", () => {
    const cn1 = normalizeCollectorNumber("");
    const cn2 = normalizeCollectorNumber("");
    expect(isPromoVariantCNMatch(cn1, cn2)).toBe(false);
  });

  test("null vs null → NOT promo variant", () => {
    const cn1 = normalizeCollectorNumber(null);
    const cn2 = normalizeCollectorNumber(null);
    expect(isPromoVariantCNMatch(cn1, cn2)).toBe(false);
  });
});

// ============================================================
// Tests for isDifferentCN
// ============================================================

describe("isDifferentCN", () => {
  test("250 vs 123 → truly different", () => {
    const cn1 = normalizeCollectorNumber("250");
    const cn2 = normalizeCollectorNumber("123");
    expect(isDifferentCN(cn1, cn2)).toBe(true);
  });

  test("250 vs 250 → NOT different", () => {
    const cn1 = normalizeCollectorNumber("250");
    const cn2 = normalizeCollectorNumber("250");
    expect(isDifferentCN(cn1, cn2)).toBe(false);
  });

  test("250 vs 250p → NOT different (same base)", () => {
    const cn1 = normalizeCollectorNumber("250");
    const cn2 = normalizeCollectorNumber("250p");
    expect(isDifferentCN(cn1, cn2)).toBe(false);
  });

  test("1 vs 999 → truly different", () => {
    const cn1 = normalizeCollectorNumber("1");
    const cn2 = normalizeCollectorNumber("999");
    expect(isDifferentCN(cn1, cn2)).toBe(true);
  });
});

// ============================================================
// Combined scenario tests
// ============================================================

describe("combined scenarios: classify a pair", () => {
  // Helper: given two raw CNs, determine which category they fall into
  function classifyCNPair(raw1, raw2) {
    const cn1 = normalizeCollectorNumber(raw1);
    const cn2 = normalizeCollectorNumber(raw2);

    if (isExactCNMatch(cn1, cn2)) return "exact";
    if (isPromoVariantCNMatch(cn1, cn2)) return "promoVariant";
    if (isDifferentCN(cn1, cn2)) return "different";
    return "unknown";
  }

  test("250 vs 250 → exact", () => {
    expect(classifyCNPair("250", "250")).toBe("exact");
  });

  test("0250 vs 250 → exact (leading zero stripped)", () => {
    expect(classifyCNPair("0250", "250")).toBe("exact");
  });

  test("250 vs 250p → promoVariant", () => {
    expect(classifyCNPair("250", "250p")).toBe("promoVariant");
  });

  test("250 vs 250★ → promoVariant", () => {
    expect(classifyCNPair("250", "250★")).toBe("promoVariant");
  });

  test("250 vs 123 → different", () => {
    expect(classifyCNPair("250", "123")).toBe("different");
  });

  test("250p vs 123a → different", () => {
    expect(classifyCNPair("250p", "123a")).toBe("different");
  });

  test("250p vs 250p → exact", () => {
    expect(classifyCNPair("250p", "250p")).toBe("exact");
  });
});