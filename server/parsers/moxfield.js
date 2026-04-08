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
    ],
  };

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
  await page.setViewport({ width: 1280, height: 720 });
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
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

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
    const allApiCalls = [];

    page.on("response", async (response) => {
      const responseUrl = response.url();
      if (!responseUrl.includes("api2.moxfield.com")) return;

      allApiCalls.push({
        url: responseUrl,
        status: response.status(),
      });

      if (response.status() !== 200) return;

      try {
        const text = await response.text();
        let json;
        try {
          json = JSON.parse(text);
        } catch (e) {
          return;
        }

        // Paginated response with data array
        if (json && json.data && Array.isArray(json.data) && json.data.length > 0) {
          if (!firstPageData) {
            discoveredApiUrl = responseUrl;
            firstPageData = json;
            console.log(
              `  [Moxfield] ${listType} data captured: ${json.data.length} items, page ${json.pageNumber || 1}/${json.totalPages || 1}, ${json.totalResults || "?"} total`
            );
          }
        }

        // Board-style response
        if (json && json.boards && !firstPageData) {
          discoveredApiUrl = responseUrl;
          firstPageData = { _isBoardFormat: true, ...json };
          console.log(`  [Moxfield] ${listType} data captured (board format)`);
        }
      } catch (e) {}
    });

    console.log(`  [Moxfield] Loading ${listType} page...`);
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

    // If nothing intercepted during initial load, try scrolling
    if (!firstPageData) {
      console.log(`  [Moxfield] Waiting for data after scroll...`);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await new Promise((r) => setTimeout(r, 4000));
    }

    // Log all API calls for debugging
    if (!firstPageData) {
      console.log(`  [Moxfield] API calls seen (${allApiCalls.length}):`);
      for (const call of allApiCalls) {
        console.log(`    ${call.status} ${call.url.substring(0, 150)}`);
      }
    }

    // If still no data, try known API patterns from within the browser
    if (!firstPageData) {
      console.log(`  [Moxfield] Trying known API patterns...`);

      const patterns = [];
      if (listType === "collection") {
        patterns.push(
          `https://api2.moxfield.com/v1/collections/search/${listId}?sortType=cardName&sortDirection=ascending&pageNumber=1&pageSize=100&playStyle=paperDollars&pricingProvider=cardkingdom`
        );
      } else if (listType === "binder") {
        patterns.push(
          `https://api2.moxfield.com/v1/binders/search/${listId}?sortType=cardName&sortDirection=ascending&pageNumber=1&pageSize=100`,
          `https://api2.moxfield.com/v2/binders/${listId}/cards?pageNumber=1&pageSize=100`,
          `https://api2.moxfield.com/v1/binders/${listId}/cards?pageNumber=1&pageSize=100`
        );
      }

      for (const apiUrl of patterns) {
        console.log(`  [Moxfield] Trying: ${apiUrl.substring(0, 120)}...`);
        const result = await page.evaluate(async (fetchUrl) => {
          try {
            const resp = await fetch(fetchUrl, { credentials: "include" });
            if (!resp.ok) return { error: resp.status };
            return await resp.json();
          } catch (e) {
            return { error: e.message };
          }
        }, apiUrl);

        if (result && !result.error && result.data && Array.isArray(result.data) && result.data.length > 0) {
          discoveredApiUrl = apiUrl;
          firstPageData = result;
          console.log(
            `  [Moxfield] Pattern worked: ${result.data.length} items, ${result.totalPages || 1} pages, ${result.totalResults || "?"} total`
          );
          break;
        } else if (result && !result.error && result.boards) {
          firstPageData = { _isBoardFormat: true, ...result };
          console.log(`  [Moxfield] Pattern worked (board format)`);
          break;
        } else {
          console.log(`  [Moxfield] → ${result?.error || "no data"}`);
        }
      }
    }

    if (!firstPageData) {
      throw new Error(
        `Could not find card data for this ${listType}. It may be private or empty.`
      );
    }

    // Handle board-style response
    if (firstPageData._isBoardFormat) {
      return { type: "boards", data: firstPageData };
    }

    // Handle paginated data — fetch ALL pages
    const allEntries = [...firstPageData.data];
    const totalPages = firstPageData.totalPages || 1;
    const totalResults = firstPageData.totalResults || allEntries.length;

    console.log(
      `  [Moxfield] Page 1 loaded: ${allEntries.length} items. Total: ${totalResults} across ${totalPages} pages`
    );

    if (totalPages > 1 && discoveredApiUrl) {
      // Make sure we're using pageSize=100 for efficiency
      let baseUrl = discoveredApiUrl;
      if (baseUrl.includes("pageSize=50")) {
        baseUrl = baseUrl.replace("pageSize=50", "pageSize=100");
        // Recalculate pages with new page size
        const newTotalPages = Math.ceil(totalResults / 100);
        console.log(
          `  [Moxfield] Switched to pageSize=100, fetching ${newTotalPages} pages total...`
        );

        // Re-fetch page 1 with larger page size
        const page1Data = await page.evaluate(async (fetchUrl) => {
          try {
            const resp = await fetch(fetchUrl, { credentials: "include" });
            if (!resp.ok) return { error: resp.status };
            return await resp.json();
          } catch (e) {
            return { error: e.message };
          }
        }, baseUrl);

        if (page1Data && page1Data.data && Array.isArray(page1Data.data)) {
          // Replace with the larger first page
          allEntries.length = 0;
          allEntries.push(...page1Data.data);
          const updatedTotalPages = page1Data.totalPages || newTotalPages;

          console.log(
            `  [Moxfield] Page 1 re-fetched: ${allEntries.length} items, ${updatedTotalPages} pages`
          );

          for (let pageNum = 2; pageNum <= updatedTotalPages; pageNum++) {
            let pageUrl = baseUrl.replace(
              /pageNumber=\d+/,
              `pageNumber=${pageNum}`
            );

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
              console.log(
                `  [Moxfield] Page ${pageNum} error: ${pageData.error}`
              );
              break;
            }

            // Log progress every 10 pages
            if (pageNum % 10 === 0 || pageNum === updatedTotalPages) {
              console.log(
                `  [Moxfield] Progress: page ${pageNum}/${updatedTotalPages} (${allEntries.length} cards)`
              );
            }

            // Small delay to avoid rate limiting
            await new Promise((r) => setTimeout(r, 100));
          }
        }
      } else {
        // Fetch remaining pages with original URL
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

          await new Promise((r) => setTimeout(r, 100));
        }
      }
    }

    console.log(`  [Moxfield] Total entries collected: ${allEntries.length}`);
    return { type: "list", data: allEntries };
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
      const apiResponse = await fetchDeckWithBrowser(
        url,
        detected.id,
        browser
      );
      return parseDeckResponse(apiResponse, url);
    }

    if (detected.type === "collection" || detected.type === "binder") {
      const result = await fetchPaginatedListWithBrowser(
        url,
        detected.id,
        detected.type,
        browser
      );

      // Handle board-style response
      if (result.type === "boards") {
        const parsed = parseDeckResponse(result.data, url);
        const label =
          detected.type === "collection"
            ? `Moxfield Collection (${parsed.cards.length} cards)`
            : `Moxfield Binder (${parsed.cards.length} cards)`;
        return { cards: parsed.cards, label };
      }

      // Handle flat list response
      const cards = parseListEntries(result.data, url, detected.type);
      const label =
        detected.type === "collection"
          ? `Moxfield Collection (${cards.length} cards)`
          : `Moxfield Binder (${cards.length} cards)`;
      return { cards, label };
    }

    throw new Error(`Unsupported Moxfield URL type: ${detected.type}`);
  } catch (err) {
    throw err;
  }
}