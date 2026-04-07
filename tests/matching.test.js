import { describe, test, expect } from "vitest";
import { compareCards } from "../server/matching/engine.js";

// ============================================================
// Helper: create a card object for testing
// ============================================================

function makeCard(name, setCode, cn, foil, quantity, oracleId = null) {
  // Simple CN normalization for test helper
  const cnStr = String(cn || "");
  const match = cnStr.match(/^(0*)(\d+)(.*)$/);
  let cnBase = cnStr;
  let cnSuffix = "";
  if (match) {
    cnBase = match[2];
    cnSuffix = match[3].toLowerCase();
  }

  return {
    cardName: name,
    oracleId: oracleId,
    normalizedName: name.toLowerCase(),
    setCode: setCode.toLowerCase(),
    setName: setCode.toUpperCase(),
    collectorNumber: cnStr,
    cnBase: cnBase,
    cnSuffix: cnSuffix,
    foil: foil,
    finish: foil ? "foil" : "nonFoil",
    quantity: quantity,
    imageUrl: null,
    imageUrlBack: null,
    sourceProvider: "test",
    sourceUrl: "",
    sourceBoardType: "mainboard",
  };
}

// ============================================================
// Category 1: Full Match
// ============================================================

describe("Full Match", () => {
  test("same card, set, CN, foil → full match", () => {
    const list1 = [makeCard("Lightning Bolt", "lea", "161", false, 1)];
    const list2 = [makeCard("Lightning Bolt", "lea", "161", false, 1)];
    const result = compareCards(list1, list2);

    expect(result.categories.fullMatch).toHaveLength(1);
    expect(result.categories.fullMatch[0].matchedQuantity).toBe(1);
    expect(result.categories.fullMatch[0].card1.cardName).toBe("Lightning Bolt");
    expect(result.categories.fullMatch[0].card2.cardName).toBe("Lightning Bolt");
  });

  test("both foil → full match", () => {
    const list1 = [makeCard("Sol Ring", "cmr", "472", true, 1)];
    const list2 = [makeCard("Sol Ring", "cmr", "472", true, 1)];
    const result = compareCards(list1, list2);

    expect(result.categories.fullMatch).toHaveLength(1);
  });

  test("quantity 3 vs 1 → 1 matched, 2 unmatched", () => {
    const list1 = [makeCard("Lightning Bolt", "lea", "161", false, 3)];
    const list2 = [makeCard("Lightning Bolt", "lea", "161", false, 1)];
    const result = compareCards(list1, list2);

    expect(result.categories.fullMatch).toHaveLength(1);
    expect(result.categories.fullMatch[0].matchedQuantity).toBe(1);
    expect(result.unmatched1).toHaveLength(1);
    expect(result.unmatched1[0].quantity).toBe(2);
    expect(result.unmatched2).toHaveLength(0);
  });

  test("quantity 2 vs 4 → 2 matched, 2 unmatched in list2", () => {
    const list1 = [makeCard("Lightning Bolt", "lea", "161", false, 2)];
    const list2 = [makeCard("Lightning Bolt", "lea", "161", false, 4)];
    const result = compareCards(list1, list2);

    expect(result.categories.fullMatch[0].matchedQuantity).toBe(2);
    expect(result.unmatched1).toHaveLength(0);
    expect(result.unmatched2).toHaveLength(1);
    expect(result.unmatched2[0].quantity).toBe(2);
  });
});

// ============================================================
// Category 2: Almost Full Match
// ============================================================

describe("Almost Full Match", () => {
  test("same base CN, different suffix (250 vs 250p) → almost full match", () => {
    const list1 = [makeCard("Lightning Bolt", "lea", "161", false, 1)];
    const list2 = [makeCard("Lightning Bolt", "lea", "161p", false, 1)];
    const result = compareCards(list1, list2);

    expect(result.categories.almostFullMatch).toHaveLength(1);
    expect(result.categories.fullMatch).toHaveLength(0);
  });

  test("250 vs 250★ → almost full match", () => {
    const list1 = [makeCard("Card A", "set1", "250", false, 1)];
    const list2 = [makeCard("Card A", "set1", "250★", false, 1)];
    const result = compareCards(list1, list2);

    expect(result.categories.almostFullMatch).toHaveLength(1);
  });

  test("250p vs 250s → almost full match (both have suffixes)", () => {
    const list1 = [makeCard("Card A", "set1", "250p", false, 1)];
    const list2 = [makeCard("Card A", "set1", "250s", false, 1)];
    const result = compareCards(list1, list2);

    expect(result.categories.almostFullMatch).toHaveLength(1);
  });

  test("different foil + promo suffix → NOT almost full match (goes to set match)", () => {
    const list1 = [makeCard("Card A", "set1", "250", true, 1)];
    const list2 = [makeCard("Card A", "set1", "250p", false, 1)];
    const result = compareCards(list1, list2);

    expect(result.categories.almostFullMatch).toHaveLength(0);
    expect(result.categories.setMatch).toHaveLength(1);
  });
});

// ============================================================
// Category 3: Full Match No Foil
// ============================================================

describe("Full Match No Foil", () => {
  test("same CN, one foil one not → full match no foil", () => {
    const list1 = [makeCard("Counterspell", "cmr", "395", true, 1)];
    const list2 = [makeCard("Counterspell", "cmr", "395", false, 1)];
    const result = compareCards(list1, list2);

    expect(result.categories.fullMatchNoFoil).toHaveLength(1);
    expect(result.categories.fullMatch).toHaveLength(0);
  });

  test("nonfoil vs foil → full match no foil", () => {
    const list1 = [makeCard("Sol Ring", "cmr", "472", false, 1)];
    const list2 = [makeCard("Sol Ring", "cmr", "472", true, 1)];
    const result = compareCards(list1, list2);

    expect(result.categories.fullMatchNoFoil).toHaveLength(1);
  });
});

// ============================================================
// Category 4: Set Match
// ============================================================

describe("Set Match", () => {
  test("same set, truly different CN → set match", () => {
    const list1 = [makeCard("Lightning Bolt", "lea", "161", false, 1)];
    const list2 = [makeCard("Lightning Bolt", "lea", "999", false, 1)];
    const result = compareCards(list1, list2);

    expect(result.categories.setMatch).toHaveLength(1);
    expect(result.categories.fullMatch).toHaveLength(0);
    expect(result.categories.sameCard).toHaveLength(0);
  });

  test("same set, different CN, different foil → set match", () => {
    const list1 = [makeCard("Card A", "set1", "100", true, 1)];
    const list2 = [makeCard("Card A", "set1", "200", false, 1)];
    const result = compareCards(list1, list2);

    expect(result.categories.setMatch).toHaveLength(1);
  });

  test("250 vs 250p should NOT be set match (should be almost full match)", () => {
    const list1 = [makeCard("Card A", "set1", "250", false, 1)];
    const list2 = [makeCard("Card A", "set1", "250p", false, 1)];
    const result = compareCards(list1, list2);

    expect(result.categories.setMatch).toHaveLength(0);
    expect(result.categories.almostFullMatch).toHaveLength(1);
  });
});

// ============================================================
// Category 5: Same Card
// ============================================================

describe("Same Card", () => {
  test("same name, different sets → same card", () => {
    const list1 = [makeCard("Sol Ring", "c21", "263", false, 1)];
    const list2 = [makeCard("Sol Ring", "cmr", "472", false, 1)];
    const result = compareCards(list1, list2);

    expect(result.categories.sameCard).toHaveLength(1);
    expect(result.categories.fullMatch).toHaveLength(0);
    expect(result.categories.setMatch).toHaveLength(0);
  });

  test("same name, different sets, different foil → same card", () => {
    const list1 = [makeCard("Sol Ring", "c21", "263", true, 1)];
    const list2 = [makeCard("Sol Ring", "cmr", "472", false, 1)];
    const result = compareCards(list1, list2);

    expect(result.categories.sameCard).toHaveLength(1);
  });

  test("oracle ID match takes precedence over name", () => {
    const list1 = [makeCard("Card A", "set1", "1", false, 1, "oracle-123")];
    const list2 = [makeCard("Card A", "set2", "2", false, 1, "oracle-123")];
    const result = compareCards(list1, list2);

    expect(result.categories.sameCard).toHaveLength(1);
  });
});

// ============================================================
// Priority Tests
// ============================================================

describe("Priority ordering", () => {
  test("full match wins over all lower categories", () => {
    const list1 = [makeCard("Bolt", "lea", "161", false, 1)];
    const list2 = [makeCard("Bolt", "lea", "161", false, 1)];
    const result = compareCards(list1, list2);

    expect(result.categories.fullMatch).toHaveLength(1);
    expect(result.categories.almostFullMatch).toHaveLength(0);
    expect(result.categories.fullMatchNoFoil).toHaveLength(0);
    expect(result.categories.setMatch).toHaveLength(0);
    expect(result.categories.sameCard).toHaveLength(0);
  });

  test("card matched at full match does not appear in same card", () => {
    const list1 = [makeCard("Bolt", "lea", "161", false, 1)];
    const list2 = [makeCard("Bolt", "lea", "161", false, 1)];
    const result = compareCards(list1, list2);

    const totalMatches =
      result.categories.fullMatch.length +
      result.categories.almostFullMatch.length +
      result.categories.fullMatchNoFoil.length +
      result.categories.setMatch.length +
      result.categories.sameCard.length;

    expect(totalMatches).toBe(1);
  });

  test("multiple copies across categories", () => {
    // List 1: 2 copies of Bolt in LEA #161 nonfoil
    // List 2: 1 copy exact match, 1 copy in different set
    const list1 = [makeCard("Bolt", "lea", "161", false, 2)];
    const list2 = [
      makeCard("Bolt", "lea", "161", false, 1),
      makeCard("Bolt", "m11", "149", false, 1),
    ];
    const result = compareCards(list1, list2);

    // 1 should be Full Match, 1 should be Same Card
    expect(result.categories.fullMatch).toHaveLength(1);
    expect(result.categories.fullMatch[0].matchedQuantity).toBe(1);
    expect(result.categories.sameCard).toHaveLength(1);
    expect(result.categories.sameCard[0].matchedQuantity).toBe(1);
    expect(result.unmatched1).toHaveLength(0);
    expect(result.unmatched2).toHaveLength(0);
  });
});

// ============================================================
// Edge Cases
// ============================================================

describe("Edge cases", () => {
  test("empty lists → no matches", () => {
    const result = compareCards([], []);
    expect(result.categories.fullMatch).toHaveLength(0);
    expect(result.unmatched1).toHaveLength(0);
    expect(result.unmatched2).toHaveLength(0);
  });

  test("no common cards → all unmatched", () => {
    const list1 = [makeCard("Card A", "set1", "1", false, 1)];
    const list2 = [makeCard("Card B", "set2", "2", false, 1)];
    const result = compareCards(list1, list2);

    expect(result.categories.fullMatch).toHaveLength(0);
    expect(result.categories.sameCard).toHaveLength(0);
    expect(result.unmatched1).toHaveLength(1);
    expect(result.unmatched2).toHaveLength(1);
  });

  test("missing collector numbers still match on name + set", () => {
    const list1 = [makeCard("Card A", "set1", "", false, 1)];
    const list2 = [makeCard("Card A", "set1", "", false, 1)];
    const result = compareCards(list1, list2);

    // Both have empty CN → exact CN match (empty === empty)
    expect(result.categories.fullMatch).toHaveLength(1);
  });

  test("one card matches multiple in list2 — consumes by quantity", () => {
    const list1 = [makeCard("Bolt", "lea", "161", false, 3)];
    const list2 = [
      makeCard("Bolt", "lea", "161", false, 1),
      makeCard("Bolt", "lea", "161", false, 1),
    ];
    const result = compareCards(list1, list2);

    // Should create 2 full match pairs (1+1), leaving 1 unmatched in list1
    const totalFullMatchQty = result.categories.fullMatch.reduce(
      (sum, p) => sum + p.matchedQuantity,
      0
    );
    expect(totalFullMatchQty).toBe(2);
    expect(result.unmatched1).toHaveLength(1);
    expect(result.unmatched1[0].quantity).toBe(1);
  });

  test("summary counts are correct", () => {
    const list1 = [
      makeCard("Bolt", "lea", "161", false, 2),
      makeCard("Ring", "cmr", "472", false, 1),
    ];
    const list2 = [
      makeCard("Bolt", "lea", "161", false, 1),
      makeCard("Path", "2xm", "25", false, 1),
    ];
    const result = compareCards(list1, list2);

    expect(result.summary.totalMatched).toBe(1);
    expect(result.summary.totalUnmatched1).toBe(2); // 1 Bolt + 1 Ring
    expect(result.summary.totalUnmatched2).toBe(1); // 1 Path
  });

  test("complex scenario with all categories", () => {
    const list1 = [
      makeCard("Card A", "set1", "100", false, 1),   // should full match
      makeCard("Card B", "set1", "200", false, 1),   // should almost full match (200 vs 200p)
      makeCard("Card C", "set1", "300", true, 1),    // should full match no foil (foil vs nonfoil)
      makeCard("Card D", "set1", "400", false, 1),   // should set match (400 vs 500)
      makeCard("Card E", "set1", "500", false, 1),   // should same card (set1 vs set2)
      makeCard("Card F", "set1", "600", false, 1),   // no match
    ];
    const list2 = [
      makeCard("Card A", "set1", "100", false, 1),   // full match
      makeCard("Card B", "set1", "200p", false, 1),  // almost full match
      makeCard("Card C", "set1", "300", false, 1),   // full match no foil
      makeCard("Card D", "set1", "500", false, 1),   // set match (different CN)
      makeCard("Card E", "set2", "100", false, 1),   // same card (different set)
      makeCard("Card G", "set1", "700", false, 1),   // no match
    ];
    const result = compareCards(list1, list2);

    expect(result.categories.fullMatch).toHaveLength(1);
    expect(result.categories.fullMatch[0].card1.cardName).toBe("Card A");

    expect(result.categories.almostFullMatch).toHaveLength(1);
    expect(result.categories.almostFullMatch[0].card1.cardName).toBe("Card B");

    expect(result.categories.fullMatchNoFoil).toHaveLength(1);
    expect(result.categories.fullMatchNoFoil[0].card1.cardName).toBe("Card C");

    expect(result.categories.setMatch).toHaveLength(1);
    expect(result.categories.setMatch[0].card1.cardName).toBe("Card D");

    expect(result.categories.sameCard).toHaveLength(1);
    expect(result.categories.sameCard[0].card1.cardName).toBe("Card E");

    expect(result.unmatched1).toHaveLength(1);
    expect(result.unmatched1[0].cardName).toBe("Card F");

    expect(result.unmatched2).toHaveLength(1);
    expect(result.unmatched2[0].cardName).toBe("Card G");
  });
});