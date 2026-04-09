/**
 * Moxfield Parser
 *
 * Fetches public card lists from Moxfield using their API
 * with an authorized User-Agent key.
 *
 * All API calls go through a global sequential queue to ensure
 * only 1 request per ~1.2s regardless of how many users are active.
 */

import { normalizeCollectorNumber } from "../matching/normalize.js";

// ============================================================
// Global Request Queue — serializes ALL API calls
// ============================================================

let lastRequestTime = 0;
const requestQueue = [];
let queueProcessing = false;

/**
 * Returns the current number of pending items in the queue.
 */
export function getQueueLength() {
  return requestQueue.length;
}

/**
 * Add a fetch call to the global queue.
 * Returns a promise that resolves with the JSON response.
 */
function queuedFetch(url) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ url, resolve, reject });
    processQueue();
  });
}

/**
 * Process the queue one request at a time.
 */
async function processQueue() {
  if (queueProcessing) return;
  queueProcessing = true;

  while (requestQueue.length > 0) {
    const { url, resolve, reject } = requestQueue[0];

    try {
      const result = await executeRateLimitedFetch(url);
      resolve(result);
    } catch (err) {
      reject(err);
    }

    requestQueue.shift();
  }

  queueProcessing = false;
}

/**
 * Execute a single rate-limited fetch with retry on 429.
 */
async function executeRateLimitedFetch(url, maxRetries = 3) {
  const userAgent = process.env.MOXFIELD_USER_AGENT;

  if (!userAgent) {
    throw new Error(
      "MOXFIELD_USER_AGENT environment variable is not set. Cannot access Moxfield API."
    );
  }

  const baseDelay = 1200;
  let attempt = 0;

  while (true) {
    const now = Date.now();
    const timeSinceLastRequest = now - lastRequestTime;

    if (timeSinceLastRequest < baseDelay) {
      const waitTime = baseDelay - timeSinceLastRequest;
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }

    lastRequestTime = Date.now();

    const response = await fetch(url, {
      headers: {
        "User-Agent": userAgent,
        Accept: "application/json",
      },
    });

    if (response.status === 429) {
      attempt++;
      if (attempt > maxRetries) {
        throw new Error(
          "Rate limited by Moxfield after multiple retries. Please wait a few minutes and try again."
        );
      }
      const backoff = 5000 * Math.pow(2, attempt - 1);
      console.log(
        `  [Moxfield] Rate limited (429). Retry ${attempt}/${maxRetries} after ${backoff / 1000}s...`
      );
      await new Promise((resolve) => setTimeout(resolve, backoff));
      continue;
    }

    if (response.status === 404) {
      return { _notFound: true, status: 404 };
    }

    if (response.status === 403 || response.status === 401) {
      throw new Error(
        "Access denied by Moxfield. The list may be private."
      );
    }

    if (!response.ok) {
      throw new Error(`Moxfield API returned status ${response.status}.`);
    }

    return response.json();
  }
}

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
// API Fetching
// ============================================================

async function fetchDeck(deckId) {
  console.log(`  [Moxfield] Fetching deck: ${deckId}`);
  const data = await queuedFetch(
    `https://api2.moxfield.com/v3/decks/all/${deckId}`
  );

  if (data._notFound) {
    throw new Error(
      "List not found. Check that the URL is correct and the list is public."
    );
  }

  return data;
}

async function fetchCollection(collectionId, onProgress) {
  console.log(`  [Moxfield] Fetching collection: ${collectionId}`);
  return fetchAllPages(
    `https://api2.moxfield.com/v1/collections/search/${collectionId}?sortType=cardName&sortDirection=ascending&pageSize=100&playStyle=paperDollars&pricingProvider=cardkingdom`,
    onProgress
  );
}

async function fetchBinder(binderId, onProgress) {
  console.log(`  [Moxfield] Fetching binder: ${binderId}`);
  return fetchAllPages(
    `https://api2.moxfield.com/v1/trade-binders/${binderId}/search?sortType=cardName&sortDirection=ascending&pageSize=100&playStyle=paperDollars&pricingProvider=cardkingdom`,
    onProgress
  );
}

/**
 * Fetch all pages from a paginated endpoint.
 * onProgress(page, totalPages, itemsSoFar, totalItems) called after each page.
 */
async function fetchAllPages(baseUrl, onProgress) {
  const separator = baseUrl.includes("?") ? "&" : "?";
  const firstPageUrl = `${baseUrl}${separator}pageNumber=1`;

  const firstPage = await queuedFetch(firstPageUrl);

  if (firstPage._notFound) {
    throw new Error(
      "List not found. Check that the URL is correct and the list is public."
    );
  }

  if (!firstPage || !firstPage.data || !Array.isArray(firstPage.data)) {
    throw new Error("No card data found. The list may be private or empty.");
  }

  const allEntries = [...firstPage.data];
  const totalPages = firstPage.totalPages || 1;
  const totalResults = firstPage.totalResults || allEntries.length;

  console.log(
    `  [Moxfield] Page 1/${totalPages} — ${allEntries.length} items (${totalResults} total)`
  );

  if (onProgress) {
    onProgress(1, totalPages, allEntries.length, totalResults);
  }

  for (let pageNum = 2; pageNum <= totalPages; pageNum++) {
    const pageUrl = `${baseUrl}${separator}pageNumber=${pageNum}`;
    const pageData = await queuedFetch(pageUrl);

    if (pageData._notFound) {
      console.warn(
        `  [Moxfield] Page ${pageNum} returned 404 — stopping pagination early.`
      );
      break;
    }

    if (pageData && pageData.data && Array.isArray(pageData.data)) {
      allEntries.push(...pageData.data);
    }

    if (pageNum % 10 === 0 || pageNum === totalPages) {
      console.log(
        `  [Moxfield] Page ${pageNum}/${totalPages} — ${allEntries.length} items`
      );
    }

    if (onProgress) {
      onProgress(pageNum, totalPages, allEntries.length, totalResults);
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
// Public Entry Point
// ============================================================

/**
 * @param {string} url
 * @param {function} [onProgress] - optional callback: (message: string) => void
 */
export async function fetchAndParseMoxfield(url, onProgress) {
  const detected = detectMoxfieldUrl(url);

  if (!detected) {
    throw new Error(
      `Could not parse Moxfield URL: ${url}\n\nSupported:\n` +
        `  - moxfield.com/decks/{id}\n` +
        `  - moxfield.com/collection/{id}\n` +
        `  - moxfield.com/binders/{id}`
    );
  }

  console.log(`  [Moxfield] Type: ${detected.type}, ID: ${detected.id}`);

  if (detected.type === "deck") {
    if (onProgress) onProgress("Fetching deck...");
    const apiResponse = await fetchDeck(detected.id);
    return parseDeckResponse(apiResponse, url);
  }

  if (detected.type === "collection") {
    if (onProgress) onProgress("Fetching collection...");
    const pageProgress = (page, totalPages, items, total) => {
      if (onProgress) {
        const pct = Math.round((page / totalPages) * 100);
        onProgress(`Fetching collection — page ${page}/${totalPages} (${items}/${total} cards) ${pct}%`);
      }
    };
    const entries = await fetchCollection(detected.id, pageProgress);
    const cards = parseListEntries(entries, url, "collection");
    return {
      cards,
      label: `Moxfield Collection (${cards.length} cards)`,
    };
  }

  if (detected.type === "binder") {
    if (onProgress) onProgress("Fetching binder...");
    const pageProgress = (page, totalPages, items, total) => {
      if (onProgress) {
        const pct = Math.round((page / totalPages) * 100);
        onProgress(`Fetching binder — page ${page}/${totalPages} (${items}/${total} cards) ${pct}%`);
      }
    };
    const entries = await fetchBinder(detected.id, pageProgress);
    const cards = parseListEntries(entries, url, "binder");
    return {
      cards,
      label: `Moxfield Binder (${cards.length} cards)`,
    };
  }

  throw new Error(`Unsupported Moxfield URL type: ${detected.type}`);
}

export async function closeSharedBrowser() {
  // No-op — kept for backward compatibility
}