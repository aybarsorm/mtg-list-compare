import "dotenv/config";
import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { compareCards } from "./matching/engine.js";
import { detectMoxfieldUrl, fetchAndParseMoxfield } from "./parsers/moxfield.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "5mb" }));

// Serve static files
const publicPath = path.join(__dirname, "..", "public");
if (fs.existsSync(publicPath)) {
  const files = fs.readdirSync(publicPath);
  console.log(`[Static] Files: ${files.join(", ")}`);
}
app.use(express.static(publicPath));

// Verify API key
if (!process.env.MOXFIELD_USER_AGENT) {
  console.warn(
    "\n⚠️  WARNING: MOXFIELD_USER_AGENT is not set. API calls to Moxfield will fail."
  );
  console.warn(
    "   Create a .env file with: MOXFIELD_USER_AGENT=your_key_here\n"
  );
} else {
  console.log("[Config] Moxfield API key configured ✓");
}

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    moxfieldKeyConfigured: !!process.env.MOXFIELD_USER_AGENT,
  });
});

/**
 * GET /api/compare-stream?url1=...&url2=...
 * Server-Sent Events endpoint for real-time progress.
 */
app.get("/api/compare-stream", async (req, res) => {
  const startTime = Date.now();
  const { url1, url2 } = req.query;

  // Set up SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Helper to send an SSE event
  function sendEvent(type, data) {
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  // Handle client disconnect
  let aborted = false;
  req.on("close", () => {
    aborted = true;
  });

  try {
    // Validate URLs
    if (!url1 || !url2) {
      sendEvent("error", { error: "Please provide both URLs." });
      res.end();
      return;
    }

    const trimmedUrl1 = url1.trim();
    const trimmedUrl2 = url2.trim();

    if (!detectMoxfieldUrl(trimmedUrl1)) {
      sendEvent("error", {
        error: `Unsupported URL: ${trimmedUrl1}\n\nSupported:\n• moxfield.com/decks/{id}\n• moxfield.com/collection/{id}\n• moxfield.com/binders/{id}`,
      });
      res.end();
      return;
    }

    if (!detectMoxfieldUrl(trimmedUrl2)) {
      sendEvent("error", {
        error: `Unsupported URL: ${trimmedUrl2}\n\nSupported:\n• moxfield.com/decks/{id}\n• moxfield.com/collection/{id}\n• moxfield.com/binders/{id}`,
      });
      res.end();
      return;
    }

    let result1, result2;

    if (trimmedUrl1 === trimmedUrl2) {
      console.log("\n[Compare] Same URL — fetching once...");
      sendEvent("progress", { stage: "list1", message: "Fetching list (same URL for both)..." });

      result1 = await fetchAndParseMoxfield(trimmedUrl1, (msg) => {
        if (!aborted) sendEvent("progress", { stage: "list1", message: msg });
      });

      result2 = {
        cards: result1.cards.map((c) => ({ ...c })),
        label: result1.label,
      };
    } else {
      // Fetch list 1
      console.log("\n[Compare] Fetching list 1...");
      sendEvent("progress", { stage: "list1", message: "Fetching List 1..." });

      result1 = await fetchAndParseMoxfield(trimmedUrl1, (msg) => {
        if (!aborted) sendEvent("progress", { stage: "list1", message: `List 1: ${msg}` });
      });

      if (aborted) return;

      sendEvent("progress", {
        stage: "list1",
        message: `List 1: ${result1.cards.length} cards loaded ✓`,
      });

      // Fetch list 2
      console.log("[Compare] Fetching list 2...");
      sendEvent("progress", { stage: "list2", message: "Fetching List 2..." });

      result2 = await fetchAndParseMoxfield(trimmedUrl2, (msg) => {
        if (!aborted) sendEvent("progress", { stage: "list2", message: `List 2: ${msg}` });
      });

      if (aborted) return;

      sendEvent("progress", {
        stage: "list2",
        message: `List 2: ${result2.cards.length} cards loaded ✓`,
      });
    }

    // Matching
    console.log(
      `[Compare] List 1: ${result1.cards.length} cards, List 2: ${result2.cards.length} cards`
    );
    console.log("[Compare] Matching...");
    sendEvent("progress", {
      stage: "matching",
      message: `Comparing ${result1.cards.length} vs ${result2.cards.length} cards...`,
    });

    const comparison = compareCards(result1.cards, result2.cards);

    // Console logging
    const catSummary = [];
    for (const [catName, pairs] of Object.entries(comparison.categories)) {
      const qty = pairs.reduce((sum, p) => sum + p.matchedQuantity, 0);
      if (qty > 0) catSummary.push(`${catName}: ${qty}`);
    }
    if (catSummary.length > 0) console.log(`  ${catSummary.join(", ")}`);
    console.log(`  Unmatched: ${comparison.summary.totalUnmatched1}`);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Compare] Done in ${elapsed}s`);

    // Send final result
    sendEvent("result", {
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

    res.end();
  } catch (err) {
    console.error("[Compare] Error:", err.message);
    if (!aborted) {
      sendEvent("error", { error: err.message || "Internal server error" });
    }
    res.end();
  }
});

/**
 * POST /api/compare — kept for backward compatibility / non-SSE clients
 */
app.post("/api/compare", async (req, res) => {
  const startTime = Date.now();

  try {
    const { url1, url2 } = req.body;

    if (!url1 || !url2) {
      return res.status(400).json({ success: false, error: "Please provide both URLs." });
    }

    const trimmedUrl1 = url1.trim();
    const trimmedUrl2 = url2.trim();

    if (!detectMoxfieldUrl(trimmedUrl1)) {
      return res.status(400).json({
        success: false,
        error: `Unsupported URL: ${trimmedUrl1}`,
      });
    }

    if (!detectMoxfieldUrl(trimmedUrl2)) {
      return res.status(400).json({
        success: false,
        error: `Unsupported URL: ${trimmedUrl2}`,
      });
    }

    let result1, result2;

    if (trimmedUrl1 === trimmedUrl2) {
      console.log("\n[Compare] Same URL — fetching once...");
      result1 = await fetchAndParseMoxfield(trimmedUrl1);
      result2 = {
        cards: result1.cards.map((c) => ({ ...c })),
        label: result1.label,
      };
    } else {
      console.log("\n[Compare] Fetching list 1...");
      result1 = await fetchAndParseMoxfield(trimmedUrl1);
      console.log("[Compare] Fetching list 2...");
      result2 = await fetchAndParseMoxfield(trimmedUrl2);
    }

    console.log(
      `[Compare] List 1: ${result1.cards.length} cards, List 2: ${result2.cards.length} cards`
    );
    console.log("[Compare] Matching...");
    const comparison = compareCards(result1.cards, result2.cards);

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
    console.error("[Compare] Error:", err.message);
    res.status(500).json({ success: false, error: err.message || "Internal server error" });
  }
});

app.listen(PORT, () => {
  console.log(`========================================`);
  console.log(`  MTG List Comparator is running!`);
  console.log(`  Open http://localhost:${PORT} in your browser`);
  console.log(`========================================`);
});