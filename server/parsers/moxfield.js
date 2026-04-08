/**
 * Moxfield Parser
 *
 * Optimized version that reuses browser sessions and Cloudflare cookies.
 */

import puppeteer from "puppeteer";
import { normalizeCollectorNumber } from "../matching/normalize.js";

// ============================================================
// URL Detection
// ============================================================

const MOXFIELD_PATTERNS = [
  {
    type: "deck",
    regex: /^https?:\/\/(www\.)?moxfield\.com\/decks\/([a-zA-Z0-9_-]+)/,
    idGroup: 2,
  },
  {
    type: "collection",
    regex: /^https?:\/\/(www\.)?moxfield\.com\/collection\/([a-zA-Z0-9_-]+)/,
    idGroup: 2,
  },
  {
    type: "binder",
    regex: /^https?:\/\/(www\.)?moxfield\.com\/binders\/([a-zA-Z0-9_-]+)/,
    idGroup: 2,
  },
];

export function detectMoxfieldUrl(url) {
  if (!url || typeof url !== "string") return null;
  const trimmed = url.trim();

  for (const pattern of MOXFIELD_PATTERNS) {
    const match = trimmed.match(pattern.regex);
    if (match) {
      return {
        type: pattern.type,
        id: match[pattern.idGroup],
      };
    }
  }
  return null;
}

// ============================================================
// Browser Management — keep alive between requests
// ============================================================

let sharedBrowser = null;
let browserLastUsed = 0;
const BROWSER_TTL = 5 * 60 * 1000; // Keep browser alive for 5 minutes

async function getSharedBrowser() {
  if (sharedBrowser && sharedBrowser.connected) {
    browserLastUsed = Date.now();
    return sharedBrowser;
  }

  console.log("  [Moxfield] Launching browser...");

  const launchOptions = {
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  };

  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  sharedBrowser = await puppeteer.launch(launchOptions);
  browserLastUsed = Date.now();

  return sharedBrowser;
}

export async function closeSharedBrowser() {
  if (sharedBrowser && sharedBrowser.connected) {
    await sharedBrowser.close();
    console.log("  [Moxfield] Browser closed");
  }
  sharedBrowser = null;
}

// Auto-close browser after inactivity
setInterval(async () => {
  if (
    sharedBrowser &&
    sharedBrowser.connected &&
    Date.now() - browserLastUsed > BROWSER_TTL
  ) {
    console.log("  [Moxfield] Browser idle timeout, closing...");
    await closeSharedBrowser();
  }
}, 60000);

async function createPage(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
  );
  return page;
}

// ============================================================
// Core Strategy: Navigate once, then use API directly
// ============================================================

/**
 * Navigate to any Moxfield page to get Cloudflare cookies,
 * then use in-browser fetch for all API calls.
 * This is MUCH faster than navigating to each page separately.
 */
async function getAuthenticatedPage(browser) {
  const page = await createPage(browser);

  console.log("  [Moxfield] Establishing session with Moxfield...");
  await page.goto("https://moxfield.com", {
    waitUntil: "networkidle2",
    timeout: 60000,
  });
  console.log("  [Moxfield] Session established");

  return page;
}

/**
 * Fetch deck data using in-browser API call.
 */
async function fetchDeckViaApi(page, deckId) {
  console.log(`  [Moxfield] Fetching deck ${deckId} via API...`);

  const result = await page.evaluate(async (id) => {
    try {
      const resp = await fetch(
        `https://api2.moxfield.com/v3/decks/all/${id}`,
        { credentials: "include" }
      );
      if (!resp.ok) return { error: `HTTP ${resp.status}` };
      return await resp.json();
    } catch (e) {
      return { error: e.message };
    }
  }, deckId);

  if (result && result.error) {
    throw new Error(`Failed to fetch deck: ${result.error}`);
  }

  if (!result || !result.boards) {
    throw new Error("Invalid deck response — no board data found");
  }

  return result;
}

/**
 * Fetch all pages of a collection or binder using in-browser API calls.
 */
async function fetchPaginatedViaApi(page, listId, listType) {
  // Determine the API URL pattern
  let baseUrl;
  if (listType === "collection") {
    baseUrl = `https://api2.moxfield.com/v1/collections/search/${listId}?sortType=cardName&sortDirection=ascending&pageSize=100&playStyle=paperDollars&pricingProvider=cardkingdom`;
  } else if (listType === "binder") {
    baseUrl = `https://api2.moxfield.com/v1/binders/search/${listId}?sortType=cardName&sortDirection=ascending&pageSize=100`;
  } else {
    throw new Error(`Unknown paginated list type: ${listType}`);
  }

  console.log(`  [Moxfield] Fetching ${listType} page 1...`);

  // Fetch first page
  const firstPage = await page.evaluate(async (url) => {
    try {
      const resp = await fetch(`${url}&pageNumber=1`, {
        credentials: "include",
      });
      if (!resp.ok) return { error: `HTTP ${resp.status}` };
      return await resp.json();
    } catch (e) {
      return { error: e.message };
    }
  }, baseUrl);

  if (firstPage && firstPage.error) {
    // If the standard pattern fails, try discovering the right URL
    console.log(
      `  [Moxfield] Standard API pattern failed: ${firstPage.error}`
    );
    console.log(`  [Moxfield] Trying alternative patterns...`);

    // Try binder with different endpoint patterns
    const alternatives = [];
    if (listType === "binder") {
      alternatives.push(
        `https://api2.moxfield.com/v1/binders/${listId}/cards?pageNumber=1&pageSize=100`,
        `https://api2.moxfield.com/v2/binders/${listId}/cards?pageNumber=1&pageSize=100`
      );
    }
    if (listType === "collection") {
      alternatives.push(
        `https://api2.moxfield.com/v1/collections/${listId}/cards?pageNumber=1&pageSize=100`,
        `https://api2.moxfield.com/v2/collections/${listId}/cards?pageNumber=1&pageSize=100`
      );
    }

    for (const altUrl of alternatives) {
      const altResult = await page.evaluate(async (url) => {
        try {
          const resp = await fetch(url, { credentials: "include" });
          if (!resp.ok) return { error: `HTTP ${resp.status}` };
          return await resp.json();
        } catch (e) {
          return { error: e.message };
        }
      }, altUrl);

      if (altResult && !altResult.error && altResult.data) {
        console.log(`  [Moxfield] Alternative worked: ${altUrl}`);
        // Continue with this URL pattern for remaining pages
        return await fetchAllPages(page, altUrl.replace(/pageNumber=\d+/, ''), altResult);
      }
    }

    throw new Error(
      `Failed to fetch ${listType}: ${firstPage.error}. It may be private or the URL format has changed.`
    );
  }

  if (!firstPage || !firstPage.data || !Array.isArray(firstPage.data)) {
    throw new Error(
      `Invalid ${listType} response — no card data found. It may be private or empty.`
    );
  }

  return await fetchAllPages(page, baseUrl, firstPage);
}

/**
 * Given a first page response and base URL, fetch all remaining pages.
 */
async function fetchAllPages(page, baseUrl, firstPage) {
  const allEntries = [...firstPage.data];
  const totalPages = firstPage.totalPages || 1;
  const totalResults = firstPage.totalResults || allEntries.length;

  console.log(
    `  [Moxfield] Page 1: ${allEntries.length} items. Total: ${totalResults} across ${totalPages} pages`
  );

  if (totalPages > 1) {
    for (let pageNum = 2; pageNum <= totalPages; pageNum++) {
      const pageUrl = baseUrl.includes("pageNumber=")
        ? baseUrl.replace(/pageNumber=\d+/, `pageNumber=${pageNum}`)
        : `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}pageNumber=${pageNum}`;

      const pageData = await page.evaluate(async (url) => {
        try {
          const resp = await fetch(url, { credentials: "include" });
          if (!resp.ok) return { error: `HTTP ${resp.status}` };
          return await resp.json();
        } catch (e) {
          return { error: e.message };
        }
      }, pageUrl);

      if (pageData && pageData.data && Array.isArray(pageData.data)) {
        allEntries.push(...pageData.data);
      }

      if (pageData && pageData.error) {
        console.log(
          `  [Moxfield] Page ${pageNum} error: ${pageData.error}`
        );
        break;
      }

      if (pageNum % 10 === 0 || pageNum === totalPages) {
        console.log(
          `  [Moxfield] Progress: page ${pageNum}/${totalPages} (${allEntries.length} cards)`
        );
      }

      await new Promise((r) => setTimeout(r, 50));
    }
  }

  console.log(`  [Moxfield] Total collected: ${allEntries.length}`);
  return allEntries;
}

// ============================================================
// Card Mapping
// ============================================================

function getCardImages(card) {
  let front = null;
  let back = null;

  if (card.card_faces && card.card_faces.length > 0) {
    if (card.card_faces[0]?.image_uris) {
      front =
        card.card_faces[0].image_uris.normal ||
        card.card_faces[0].image_uris.small ||
        null;
    }
    if (card.card_faces[1]?.image_uris) {
      back =
        card.card_faces[1].image_uris.normal ||
        card.card_faces[1].image_uris.small ||
        null;
    }
  }

  if (!front && card.image_uris) {
    front = card.image_uris.normal || card.image_uris.small || null;
  }

  if (!front && card.scryfall_id) {
    const id = card.scryfall_id;
    front = `https://cards.scryfall.io/normal/front/${id.charAt(0)}/${id.charAt(1)}/${id}.jpg`;
  }

  return { front, back };
}

function isFoil(finish) {
  if (!finish) return false;
  const lower = finish.toLowerCase();
  return lower === "foil" || lower === "etched";
}

function mapCardEntry(entry, boardType, sourceUrl) {
  const card = entry.card || {};
  const cn = card.cn || card.collector_number || "";
  const normalized = normalizeCollectorNumber(cn);
  const images = getCardImages(card);

  return {
    cardName: card.name || "Unknown",
    oracleId: card.oracle_id || null,
    normalizedName: (card.name || "unknown").trim().toLowerCase(),
    setCode: (card.set || "").toLowerCase(),
    setName: card.set_name || card.set || "",
    collectorNumber: cn,
    cnBase: normalized.base,
    cnSuffix: normalized.suffix,
    foil: isFoil(entry.finish),
    finish: entry.finish || "nonFoil",
    quantity: entry.quantity || 1,
    imageUrl: images.front,
    imageUrlBack: images.back,
    sourceProvider: "moxfield",
    sourceUrl: sourceUrl,
    sourceBoardType: boardType,
  };
}

// ============================================================
// Parse Functions
// ============================================================

function parseDeckResponse(apiResponse, sourceUrl) {
  const cards = [];
  const deckName = apiResponse.name || "Unnamed Deck";
  const boards = apiResponse.boards;

  if (boards && typeof boards === "object") {
    for (const boardName of Object.keys(boards)) {
      const board = boards[boardName];
      if (!board || !board.cards || typeof board.cards !== "object") continue;

      const cardEntries = Object.entries(board.cards);
      if (cardEntries.length > 0) {
        console.log(
          `  [Moxfield] Board "${boardName}": ${cardEntries.length} cards`
        );
      }

      for (const [cardId, entry] of cardEntries) {
        cards.push(mapCardEntry(entry, boardName, sourceUrl));
      }
    }
  }

  console.log(`  [Moxfield] Total: ${cards.length} cards`);

  const format = apiResponse.format || "";
  const label = format
    ? `${deckName} (${format})`
    : `${deckName} (Moxfield Deck)`;

  return { cards, label };
}

function parseListEntries(entries, sourceUrl, listType) {
  const cards = [];
  for (const entry of entries) {
    cards.push(mapCardEntry(entry, listType, sourceUrl));
  }
  console.log(`  [Moxfield] Total: ${cards.length} cards`);
  return cards;
}

// ============================================================
// Public Entry Points
// ============================================================

/**
 * Fetch and parse a single Moxfield URL.
 */
export async function fetchAndParseMoxfield(url) {
  const detected = detectMoxfieldUrl(url);

  if (!detected) {
    throw new Error(
      `Could not parse Moxfield URL: ${url}\n\nSupported formats:\n` +
        `  - moxfield.com/decks/{id}\n` +
        `  - moxfield.com/collection/{id}\n` +
        `  - moxfield.com/binders/{id}`
    );
  }

  console.log(`  [Moxfield] Type: ${detected.type}, ID: ${detected.id}`);

  const browser = await getSharedBrowser();
  const page = await getAuthenticatedPage(browser);

  try {
    if (detected.type === "deck") {
      const apiResponse = await fetchDeckViaApi(page, detected.id);
      return parseDeckResponse(apiResponse, url);
    }

    if (detected.type === "collection" || detected.type === "binder") {
      const entries = await fetchPaginatedViaApi(
        page,
        detected.id,
        detected.type
      );
      const cards = parseListEntries(entries, url, detected.type);
      const label =
        detected.type === "collection"
          ? `Moxfield Collection (${cards.length} cards)`
          : `Moxfield Binder (${cards.length} cards)`;
      return { cards, label };
    }

    throw new Error(`Unsupported Moxfield URL type: ${detected.type}`);
  } finally {
    await page.close();
  }
}

/**
 * Fetch and parse TWO Moxfield URLs efficiently.
 * Uses a single browser session and page for both.
 */
export async function fetchAndParseTwoMoxfieldUrls(url1, url2) {
  const detected1 = detectMoxfieldUrl(url1);
  const detected2 = detectMoxfieldUrl(url2);

  if (!detected1) {
    throw new Error(`Could not parse Moxfield URL: ${url1}`);
  }
  if (!detected2) {
    throw new Error(`Could not parse Moxfield URL: ${url2}`);
  }

  const browser = await getSharedBrowser();

  // Navigate to Moxfield ONCE to get Cloudflare cookies
  const page = await getAuthenticatedPage(browser);

  try {
    // Fetch both lists using the same authenticated page
    console.log(`  [Moxfield] Fetching list 1 (${detected1.type})...`);
    const result1 = await fetchSingleList(page, detected1, url1);

    console.log(`  [Moxfield] Fetching list 2 (${detected2.type})...`);
    const result2 = await fetchSingleList(page, detected2, url2);

    return { result1, result2 };
  } finally {
    await page.close();
  }
}

async function fetchSingleList(page, detected, url) {
  if (detected.type === "deck") {
    const apiResponse = await fetchDeckViaApi(page, detected.id);
    return parseDeckResponse(apiResponse, url);
  }

  if (detected.type === "collection" || detected.type === "binder") {
    const entries = await fetchPaginatedViaApi(
      page,
      detected.id,
      detected.type
    );
    const cards = parseListEntries(entries, url, detected.type);
    const label =
      detected.type === "collection"
        ? `Moxfield Collection (${cards.length} cards)`
        : `Moxfield Binder (${cards.length} cards)`;
    return { cards, label };
  }

  throw new Error(`Unsupported type: ${detected.type}`);
}