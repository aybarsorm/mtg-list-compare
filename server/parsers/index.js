/**
 * Provider Detection & Routing
 *
 * Takes any URL and routes it to the correct parser.
 * Currently supports: Moxfield
 */

import {
  detectMoxfieldUrl,
  fetchAndParseMoxfield,
} from "./moxfield.js";

const providers = [
  {
    name: "Moxfield",
    detect: detectMoxfieldUrl,
    fetchAndParse: fetchAndParseMoxfield,
  },
];

/**
 * Detect which provider a URL belongs to.
 */
export function detectProvider(url) {
  if (!url || typeof url !== "string") return null;

  for (const provider of providers) {
    const result = provider.detect(url);
    if (result) {
      return {
        name: provider.name,
        fetchAndParse: provider.fetchAndParse,
      };
    }
  }
  return null;
}

/**
 * Fetch and parse a card list from any supported URL.
 */
export async function fetchAndParseUrl(url) {
  const provider = detectProvider(url);

  if (!provider) {
    const supportedSites = providers.map((p) => p.name).join(", ");
    throw new Error(
      `Unsupported URL: ${url}\n\nCurrently supported sites: ${supportedSites}\n\nPlease provide a public deck or list URL from one of these sites.`
    );
  }

  const result = await provider.fetchAndParse(url);

  return {
    cards: result.cards,
    label: result.label,
    provider: provider.name,
  };
}