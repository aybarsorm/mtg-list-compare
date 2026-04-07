import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { fetchAndParseUrl, detectProvider } from "./parsers/index.js";
import { compareCards } from "./matching/engine.js";
import { closeSharedBrowser } from "./parsers/moxfield.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "5mb" }));
// Serve static files
const publicPath = path.join(__dirname, "..", "public");
console.log(`[Static] Serving files from: ${publicPath}`);

// Check if public directory exists
if (fs.existsSync(publicPath)) {
  const files = fs.readdirSync(publicPath);
  console.log(`[Static] Files found: ${files.join(", ")}`);
} else {
  console.log(`[Static] WARNING: public directory not found!`);
}

app.use(express.static(publicPath));

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

/**
 * POST /api/compare
 */
app.post("/api/compare", async (req, res) => {
  const startTime = Date.now();

  try {
    const { url1, url2 } = req.body;

    if (!url1 || !url2) {
      return res.status(400).json({
        success: false,
        error: "Please provide both URLs.",
      });
    }

    // Trim URLs
    const trimmedUrl1 = url1.trim();
    const trimmedUrl2 = url2.trim();

    // Validate URLs
    if (!detectProvider(trimmedUrl1)) {
      return res.status(400).json({
        success: false,
        error: `Unsupported URL: ${trimmedUrl1}\n\nSupported:\n• moxfield.com/decks/{id}\n• moxfield.com/collection/{id}\n• moxfield.com/binders/{id}`,
      });
    }

    if (!detectProvider(trimmedUrl2)) {
      return res.status(400).json({
        success: false,
        error: `Unsupported URL: ${trimmedUrl2}\n\nSupported:\n• moxfield.com/decks/{id}\n• moxfield.com/collection/{id}\n• moxfield.com/binders/{id}`,
      });
    }

    let result1, result2;

    // Optimization: if both URLs are identical, only fetch once
    if (trimmedUrl1 === trimmedUrl2) {
      console.log("\n[Compare] Both URLs are the same — fetching once...");
      result1 = await fetchAndParseUrl(trimmedUrl1);
      result2 = {
        cards: result1.cards.map((c) => ({ ...c })),
        label: result1.label,
        provider: result1.provider,
      };
    } else {
      console.log("\n[Compare] Fetching list 1...");
      result1 = await fetchAndParseUrl(trimmedUrl1);

      console.log("[Compare] Fetching list 2...");
      result2 = await fetchAndParseUrl(trimmedUrl2);
    }

    // Close the shared browser after fetching
    await closeSharedBrowser();

    console.log(
      `[Compare] List 1: ${result1.cards.length} cards, List 2: ${result2.cards.length} cards`
    );

    // Run matching engine
    console.log("[Compare] Running matching engine...");
    const comparison = compareCards(result1.cards, result2.cards);

    // Log summary
    const catSummary = [];
    for (const [catName, pairs] of Object.entries(comparison.categories)) {
      const qty = pairs.reduce((sum, p) => sum + p.matchedQuantity, 0);
      if (qty > 0) catSummary.push(`${catName}: ${qty}`);
    }
    if (catSummary.length > 0) console.log(`  ${catSummary.join(", ")}`);
    console.log(`  Unmatched: ${comparison.summary.totalUnmatched1}`);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Compare] Done in ${elapsed}s`);

    res.json({
      success: true,
      list1Label: result1.label,
      list2Label: result2.label,
      list1Count: result1.cards.length,
      list2Count: result2.cards.length,
      list1TotalQty: result1.cards.reduce((sum, c) => sum + c.quantity, 0),
      list2TotalQty: result2.cards.reduce((sum, c) => sum + c.quantity, 0),
      categories: comparison.categories,
      unmatched1: comparison.unmatched1,
      summary: comparison.summary,
      elapsed: `${elapsed}s`,
    });
  } catch (err) {
    // Make sure browser is closed on error too
    await closeSharedBrowser().catch(() => {});

    console.error("[Compare] Error:", err.message);
    res.status(500).json({
      success: false,
      error: err.message || "Internal server error",
    });
  }
});

// Cleanup on server shutdown
process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  await closeSharedBrowser().catch(() => {});
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await closeSharedBrowser().catch(() => {});
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`========================================`);
  console.log(`  MTG List Comparator is running!`);
  console.log(`  Open http://localhost:${PORT} in your browser`);
  console.log(`========================================`);
});