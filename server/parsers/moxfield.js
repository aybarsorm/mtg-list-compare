/**
 * Moxfield Parser
 *
 * Fetches public deck lists, collections, and binders from Moxfield
 * using Puppeteer (headless browser) to bypass Cloudflare protection.
 *
 * Supported URL types:
 *   - Decks:       moxfield.com/decks/{id}       (also wishlists & packages)
 *   - Collections: moxfield.com/collection/{id}
 *   - Binders:     moxfield.com/binders/{id}
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
// Browser Management
// ============================================================

let sharedBrowser = null;

/**
 * Get or create a shared browser instance.
 * Reusing the browser between fetches saves ~5-10 seconds.
 */
async function getSharedBrowser() {
  if (sharedBrowser && sharedBrowser.connected) {
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
      "--disable-extensions",
      "--disable-background-networking",
      "--single-process",
    ],
  };

  // Use system Chromium if available (for Docker/production)
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    console.log(
      `  [Moxfield] Using system Chrome: ${process.env.PUPPETEER_EXECUTABLE_PATH}`
    );
  }

  sharedBrowser = await puppeteer.launch(launchOptions);
  return sharedBrowser;
}

/**
 * Close the shared browser. Call after all fetches are done.
 */
export async function closeSharedBrowser() {
  if (sharedBrowser && sharedBrowser.connected) {
    await sharedBrowser.close();
    console.log("  [Moxfield] Browser closed");
  }
  sharedBrowser = null;
}

async function createPage(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
  );
  return page;
}

// ============================================================
// Deck Fetching
// ============================================================

async function fetchDeckWithBrowser(url, deckId, browser) {
  const page = await createPage(browser);

  try {
    let apiData = null;

    page.on("response", async (response) => {
      const responseUrl = response.url();
      if (
        responseUrl.includes("api2.moxfield.com") &&
        responseUrl.includes(deckId)
      ) {
        try {
          const json = await response.json();
          if (json && json.boards) {
            apiData = json;
          }
        } catch (e) {}
      }
    });

    console.log(`  [Moxfield] Loading deck page...`);
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

    if (apiData) {
      console.log(`  [Moxfield] Deck data captured`);
      return apiData;
    }

    // Fallback: in-browser API fetch
    console.log(`  [Moxfield] Trying in-browser API fetch...`);
    const inBrowserData = await page.evaluate(async (id) => {
      try {
        const r = await fetch(
          `https://api2.moxfield.com/v3/decks/all/${id}`,
          { credentials: "include" }
        );
        if (r.ok) return await r.json();
        return { error: r.status };
      } catch (e) {
        return { error: e.message };
      }
    }, deckId);

    if (inBrowserData && !inBrowserData.error && inBrowserData.boards) {
      return inBrowserData;
    }

    throw new Error(
      "Could not load deck data. It may be private or the URL may be incorrect."
    );
  } finally {
    await page.close();
  }
}

// ============================================================
// Paginated List Fetching (Collections & Binders)
// ============================================================

async function fetchPaginatedListWithBrowser(url, listId, listType, browser) {
  const page = await createPage(browser);

  try {
    let discoveredApiUrl = null;
    let firstPageData = null;

    page.on("response", async (response) => {
      const responseUrl = response.url();
      if (!responseUrl.includes("api2.moxfield.com")) return;

      try {
        const json = await response.json();
        if (
          json &&
          json.data &&
          Array.isArray(json.data) &&
          json.data.length > 0
        ) {
          const sample = json.data[0];
          if (sample.card || sample.cardId || sample.quantity !== undefined) {
            if (!firstPageData) {
              discoveredApiUrl = responseUrl;
              firstPageData = json;
              console.log(
                `  [Moxfield] ${listType} data captured: page ${json.pageNumber || 1}/${json.totalPages || 1}, ${json.totalResults || "?"} total cards`
              );
            }
          }
        }
      } catch (e) {}
    });

    console.log(`  [Moxfield] Loading ${listType} page...`);
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

    if (!firstPageData) {
      console.log(`  [Moxfield] No data intercepted, scrolling...`);
      await page.evaluate(() =>
        window.scrollTo(0, document.body.scrollHeight)
      );
      await new Promise((r) => setTimeout(r, 3000));
    }

    if (!firstPageData) {
      console.log(`  [Moxfield] Trying direct API calls...`);

      const apiPatterns = [];
      if (listType === "collection") {
        apiPatterns.push(
          `https://api2.moxfield.com/v3/collections/${listId}/cards?pageNumber=1&pageSize=100`,
          `https://api2.moxfield.com/v2/collections/${listId}/cards?pageNumber=1&pageSize=100`,
          `https://api2.moxfield.com/v1/collections/${listId}/cards?pageNumber=1&pageSize=100`
        );
      } else if (listType === "binder") {
        apiPatterns.push(
          `https://api2.moxfield.com/v3/binders/${listId}/cards?pageNumber=1&pageSize=100`,
          `https://api2.moxfield.com/v2/binders/${listId}/cards?pageNumber=1&pageSize=100`,
          `https://api2.moxfield.com/v1/binders/${listId}/cards?pageNumber=1&pageSize=100`
        );
      }

      for (const apiUrl of apiPatterns) {
        const result = await page.evaluate(async (fetchUrl) => {
          try {
            const resp = await fetch(fetchUrl, { credentials: "include" });
            if (!resp.ok) return { error: resp.status };
            return await resp.json();
          } catch (e) {
            return { error: e.message };
          }
        }, apiUrl);

        if (
          result &&
          !result.error &&
          result.data &&
          Array.isArray(result.data)
        ) {
          discoveredApiUrl = apiUrl;
          firstPageData = result;
          console.log(
            `  [Moxfield] Direct API call worked: ${result.data.length} items, ${result.totalPages || 1} pages`
          );
          break;
        }
      }
    }

    if (!firstPageData || !firstPageData.data) {
      throw new Error(
        `Could not find card data for this ${listType}. It may be private or empty.`
      );
    }

    // Collect all pages
    const allEntries = [...firstPageData.data];
    const totalPages = firstPageData.totalPages || 1;

    if (totalPages > 1 && discoveredApiUrl) {
      console.log(`  [Moxfield] Fetching ${totalPages - 1} more pages...`);

      for (let pageNum = 2; pageNum <= totalPages; pageNum++) {
        let pageUrl = discoveredApiUrl;
        if (pageUrl.includes("pageNumber=")) {
          pageUrl = pageUrl.replace(
            /pageNumber=\d+/,
            `pageNumber=${pageNum}`
          );
        } else {
          const sep = pageUrl.includes("?") ? "&" : "?";
          pageUrl = `${pageUrl}${sep}pageNumber=${pageNum}`;
        }

        const pageData = await page.evaluate(async (fetchUrl) => {
          try {
            const resp = await fetch(fetchUrl, { credentials: "include" });
            if (!resp.ok) return { error: resp.status };
            return await resp.json();
          } catch (e) {
            return { error: e.message };
          }
        }, pageUrl);

        if (pageData && pageData.data && Array.isArray(pageData.data)) {
          allEntries.push(...pageData.data);
        }

        if (pageData && pageData.error) {
          console.log(`  [Moxfield] Page ${pageNum} error: ${pageData.error}`);
          break;
        }

        await new Promise((r) => setTimeout(r, 100));
      }
    }

    console.log(`  [Moxfield] Total entries collected: ${allEntries.length}`);
    return allEntries;
  } finally {
    await page.close();
  }
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
        console.log(`  [Moxfield] Board "${boardName}": ${cardEntries.length} cards`);
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
// Public Entry Point
// ============================================================

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

  try {
    if (detected.type === "deck") {
      const apiResponse = await fetchDeckWithBrowser(url, detected.id, browser);
      return parseDeckResponse(apiResponse, url);
    }

    if (detected.type === "collection") {
      const entries = await fetchPaginatedListWithBrowser(
        url, detected.id, "collection", browser
      );
      const cards = parseListEntries(entries, url, "collection");
      return { cards, label: `Moxfield Collection (${cards.length} cards)` };
    }

    if (detected.type === "binder") {
      const entries = await fetchPaginatedListWithBrowser(
        url, detected.id, "binder", browser
      );
      const cards = parseListEntries(entries, url, "binder");
      return { cards, label: `Moxfield Binder (${cards.length} cards)` };
    }

    throw new Error(`Unsupported Moxfield URL type: ${detected.type}`);
  } catch (err) {
    throw err;
  }
}