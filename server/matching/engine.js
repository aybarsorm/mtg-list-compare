/**
 * Matching Engine
 *
 * Compares two lists of normalized card objects and groups
 * matches into 5 priority categories.
 *
 * Priority order (highest to lowest):
 *   1. Full Match
 *   2. Almost Full Match
 *   3. Full Match No Foil
 *   4. Set Match
 *   5. Same Card
 *
 * Each card copy is matched at most once, in the highest
 * priority category possible.
 */

import {
  normalizeCollectorNumber,
  isExactCNMatch,
  isPromoVariantCNMatch,
  isDifferentCN,
} from "./normalize.js";

// ============================================================
// Identity Matching
// ============================================================

/**
 * Check if two cards represent the same Magic card
 * (regardless of printing, set, foil, etc.)
 *
 * Uses oracle ID if both cards have one, otherwise
 * falls back to normalized card name comparison.
 *
 * @param {object} a - Normalized card object
 * @param {object} b - Normalized card object
 * @returns {boolean}
 */
function sameIdentity(a, b) {
  // If both have oracle IDs, use those (most reliable)
  if (a.oracleId && b.oracleId) {
    return a.oracleId === b.oracleId;
  }

  // Fallback: compare normalized names
  return a.normalizedName === b.normalizedName;
}

// ============================================================
// Category Predicates
// ============================================================

/**
 * Full Match: same identity, same set, exact same collector number, same foil.
 */
function isFullMatch(a, b) {
  if (!sameIdentity(a, b)) return false;
  if (a.setCode !== b.setCode) return false;
  if (a.foil !== b.foil) return false;

  // Exact collector number match (base and suffix both identical)
  const cnA = { base: a.cnBase, suffix: a.cnSuffix };
  const cnB = { base: b.cnBase, suffix: b.cnSuffix };
  return isExactCNMatch(cnA, cnB);
}

/**
 * Almost Full Match: same identity, same set, same base CN but
 * different suffix (promo variant), same foil.
 */
function isAlmostFullMatch(a, b) {
  if (!sameIdentity(a, b)) return false;
  if (a.setCode !== b.setCode) return false;
  if (a.foil !== b.foil) return false;

  const cnA = { base: a.cnBase, suffix: a.cnSuffix };
  const cnB = { base: b.cnBase, suffix: b.cnSuffix };
  return isPromoVariantCNMatch(cnA, cnB);
}

/**
 * Full Match No Foil: same identity, same set, exact same collector
 * number, but different foil status.
 */
function isFullMatchNoFoil(a, b) {
  if (!sameIdentity(a, b)) return false;
  if (a.setCode !== b.setCode) return false;
  if (a.foil === b.foil) return false; // foil MUST be different

  const cnA = { base: a.cnBase, suffix: a.cnSuffix };
  const cnB = { base: b.cnBase, suffix: b.cnSuffix };
  return isExactCNMatch(cnA, cnB);
}

/**
 * Set Match: same identity, same set, truly different collector number.
 * Foil status does not matter.
 *
 * Important: cards with same base CN but different suffix should NOT
 * end up here — those go to Almost Full Match. This is only for
 * truly different collector numbers (different base).
 */
function isSetMatch(a, b) {
  if (!sameIdentity(a, b)) return false;
  if (a.setCode !== b.setCode) return false;

  const cnA = { base: a.cnBase, suffix: a.cnSuffix };
  const cnB = { base: b.cnBase, suffix: b.cnSuffix };

  // Must be truly different CN bases
  // Also catch the case where CN base is the same but suffix differs
  // and foil differs — that wouldn't have matched in categories 2 or 3
  // because cat 2 requires same foil and cat 3 requires exact CN.
  // So if we get here, it means either:
  //   - Different CN base (truly different printing) → Set Match
  //   - Same CN base, different suffix, different foil → also Set Match
  //     (didn't qualify for Almost Full Match because foil differs,
  //      didn't qualify for Full Match No Foil because CN suffix differs)

  // If exact same CN and same foil → would have been Full Match
  // If exact same CN and diff foil → would have been Full Match No Foil
  // If same base diff suffix and same foil → would have been Almost Full Match
  // Everything else that's same set = Set Match
  return true;
}

/**
 * Same Card: same identity, different sets.
 * Collector number and foil don't matter.
 */
function isSameCard(a, b) {
  if (!sameIdentity(a, b)) return false;
  // Must be different sets
  return a.setCode !== b.setCode;
}

// ============================================================
// Matching Algorithm
// ============================================================

/**
 * Category definitions in priority order.
 * Each card pair is tested against these in order.
 * The first match wins — lower categories are not checked.
 */
const CATEGORIES = [
  { name: "fullMatch", label: "Full Match", predicate: isFullMatch },
  { name: "almostFullMatch", label: "Almost Full Match", predicate: isAlmostFullMatch },
  { name: "fullMatchNoFoil", label: "Full Match No Foil", predicate: isFullMatchNoFoil },
  { name: "setMatch", label: "Set Match", predicate: isSetMatch },
  { name: "sameCard", label: "Same Card", predicate: isSameCard },
];

/**
 * Compare two card lists and group matches into categories.
 *
 * Algorithm:
 *   1. Clone both lists with a "remaining" quantity for each card
 *   2. For each priority level (highest first):
 *      - For each card in list 1 with remaining > 0:
 *        - Find a card in list 2 with remaining > 0 that matches the predicate
 *        - If found, create a matched pair and decrement both remaining counts
 *   3. Collect unmatched cards (remaining > 0)
 *
 * @param {object[]} list1 - Array of normalized card objects from list 1
 * @param {object[]} list2 - Array of normalized card objects from list 2
 * @returns {object} - { categories: {...}, unmatched1: [...], unmatched2: [...] }
 */
export function compareCards(list1, list2) {
  // Deep-clone cards and add remaining quantity tracking
  const pool1 = list1.map((card) => ({
    ...card,
    remaining: card.quantity,
  }));

  const pool2 = list2.map((card) => ({
    ...card,
    remaining: card.quantity,
  }));

  // Initialize result categories
  const categories = {};
  for (const cat of CATEGORIES) {
    categories[cat.name] = [];
  }

  // For each priority level, greedily match
  for (const category of CATEGORIES) {
    for (const card1 of pool1) {
      if (card1.remaining <= 0) continue;

      for (const card2 of pool2) {
        if (card2.remaining <= 0) continue;

        if (category.predicate(card1, card2)) {
          // How many copies can we match?
          const matchQty = Math.min(card1.remaining, card2.remaining);

          categories[category.name].push({
            category: category.name,
            categoryLabel: category.label,
            matchedQuantity: matchQty,
            card1: {
              cardName: card1.cardName,
              oracleId: card1.oracleId,
              normalizedName: card1.normalizedName,
              setCode: card1.setCode,
              setName: card1.setName,
              collectorNumber: card1.collectorNumber,
              cnBase: card1.cnBase,
              cnSuffix: card1.cnSuffix,
              foil: card1.foil,
              finish: card1.finish,
              quantity: matchQty,
              imageUrl: card1.imageUrl,
              imageUrlBack: card1.imageUrlBack,
              sourceProvider: card1.sourceProvider,
              sourceUrl: card1.sourceUrl,
              sourceBoardType: card1.sourceBoardType,
            },
            card2: {
              cardName: card2.cardName,
              oracleId: card2.oracleId,
              normalizedName: card2.normalizedName,
              setCode: card2.setCode,
              setName: card2.setName,
              collectorNumber: card2.collectorNumber,
              cnBase: card2.cnBase,
              cnSuffix: card2.cnSuffix,
              foil: card2.foil,
              finish: card2.finish,
              quantity: matchQty,
              imageUrl: card2.imageUrl,
              imageUrlBack: card2.imageUrlBack,
              sourceProvider: card2.sourceProvider,
              sourceUrl: card2.sourceUrl,
              sourceBoardType: card2.sourceBoardType,
            },
          });

          // Decrement remaining counts
          card1.remaining -= matchQty;
          card2.remaining -= matchQty;

          // If card1 is fully matched, move to next card1
          if (card1.remaining <= 0) break;
        }
      }
    }
  }

  // Collect unmatched cards
  const unmatched1 = pool1
    .filter((c) => c.remaining > 0)
    .map((c) => ({
      cardName: c.cardName,
      oracleId: c.oracleId,
      normalizedName: c.normalizedName,
      setCode: c.setCode,
      setName: c.setName,
      collectorNumber: c.collectorNumber,
      foil: c.foil,
      finish: c.finish,
      quantity: c.remaining,
      imageUrl: c.imageUrl,
      imageUrlBack: c.imageUrlBack,
      sourceProvider: c.sourceProvider,
      sourceUrl: c.sourceUrl,
      sourceBoardType: c.sourceBoardType,
    }));

  const unmatched2 = pool2
    .filter((c) => c.remaining > 0)
    .map((c) => ({
      cardName: c.cardName,
      oracleId: c.oracleId,
      normalizedName: c.normalizedName,
      setCode: c.setCode,
      setName: c.setName,
      collectorNumber: c.collectorNumber,
      foil: c.foil,
      finish: c.finish,
      quantity: c.remaining,
      imageUrl: c.imageUrl,
      imageUrlBack: c.imageUrlBack,
      sourceProvider: c.sourceProvider,
      sourceUrl: c.sourceUrl,
      sourceBoardType: c.sourceBoardType,
    }));

  // Count totals for logging
  let totalMatched = 0;
  for (const cat of CATEGORIES) {
    const pairs = categories[cat.name];
    const qty = pairs.reduce((sum, p) => sum + p.matchedQuantity, 0);
    totalMatched += qty;
  }

  return {
    categories,
    unmatched1,
    unmatched2,
    summary: {
      totalMatched,
      totalUnmatched1: unmatched1.reduce((sum, c) => sum + c.quantity, 0),
      totalUnmatched2: unmatched2.reduce((sum, c) => sum + c.quantity, 0),
    },
  };
}