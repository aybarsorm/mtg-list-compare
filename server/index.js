import "dotenv/config";
import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { compareCards } from "./matching/engine.js";
import {
  detectMoxfieldUrl,
  fetchAndParseMoxfield,
  getQueueLength,
} from "./parsers/moxfield.js";

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

// ============================================================
// Job Queue — serializes compare operations
// ============================================================

const jobQueue = [];
let activeJob = null;

function getJobPosition(jobId) {
  if (activeJob && activeJob.id === jobId) return 0;
  const idx = jobQueue.findIndex((j) => j.id === jobId);
  return idx === -1 ? -1 : idx + 1;
}

function getTotalJobs() {
  return jobQueue.length + (activeJob ? 1 : 0);
}

function enqueueJob(job) {
  return new Promise((resolve) => {
    job._startResolve = resolve;
    jobQueue.push(job);
    console.log(
      `[Queue] Job ${job.id} added. Queue size: ${jobQueue.length}, active: ${activeJob ? activeJob.id : "none"}`
    );
    processJobQueue();
  });
}

async function processJobQueue() {
  if (activeJob) return;
  if (jobQueue.length === 0) return;

  activeJob = jobQueue.shift();
  console.log(
    `[Queue] Starting job ${activeJob.id}. Remaining in queue: ${jobQueue.length}`
  );

  // Signal the job to start
  activeJob._startResolve();
}

function finishJob(jobId) {
  if (activeJob && activeJob.id === jobId) {
    console.log(`[Queue] Job ${jobId} finished.`);
    activeJob = null;
    // Process next job
    processJobQueue();
  }
}

let jobIdCounter = 0;

// ============================================================
// Health check
// ============================================================

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    moxfieldKeyConfigured: !!process.env.MOXFIELD_USER_AGENT,
    queueLength: getTotalJobs(),
  });
});

// ============================================================
// SSE Compare Endpoint with Queue
// ============================================================

app.get("/api/compare-stream", async (req, res) => {
  const startTime = Date.now();
  const { url1, url2 } = req.query;

  // SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  function sendEvent(type, data) {
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }

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

    // Create a job and enter the queue
    const jobId = ++jobIdCounter;
    const job = { id: jobId };

    // Check if we need to wait
    const currentTotal = getTotalJobs();
    if (currentTotal > 0) {
      sendEvent("progress", {
        stage: "queue",
        message: `In queue — position ${currentTotal + 1} of ${currentTotal + 1}`,
        position: currentTotal + 1,
        total: currentTotal + 1,
      });
    }

    // Start a polling interval to update queue position while waiting
    const queueInterval = setInterval(() => {
      if (aborted) {
        clearInterval(queueInterval);
        return;
      }
      const pos = getJobPosition(jobId);
      const total = getTotalJobs();
      if (pos > 0) {
        sendEvent("progress", {
          stage: "queue",
          message: `In queue — position ${pos} of ${total}`,
          position: pos,
          total: total,
        });
      }
    }, 2000);

    // Wait for our turn
    await enqueueJob(job);
    clearInterval(queueInterval);

    if (aborted) {
      finishJob(jobId);
      return;
    }

    sendEvent("progress", { stage: "list1", message: "Fetching List 1..." });

    try {
      let result1, result2;

      if (trimmedUrl1 === trimmedUrl2) {
        console.log("\n[Compare] Same URL — fetching once...");
        sendEvent("progress", {
          stage: "list1",
          message: "Fetching list (same URL for both)...",
        });

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

        result1 = await fetchAndParseMoxfield(trimmedUrl1, (msg) => {
          if (!aborted)
            sendEvent("progress", { stage: "list1", message: `List 1: ${msg}` });
        });

        if (aborted) {
          finishJob(jobId);
          return;
        }

        sendEvent("progress", {
          stage: "list1",
          message: `List 1: ${result1.cards.length} cards loaded ✓`,
        });

        // Fetch list 2
        console.log("[Compare] Fetching list 2...");
        sendEvent("progress", { stage: "list2", message: "Fetching List 2..." });

        result2 = await fetchAndParseMoxfield(trimmedUrl2, (msg) => {
          if (!aborted)
            sendEvent("progress", { stage: "list2", message: `List 2: ${msg}` });
        });

        if (aborted) {
          finishJob(jobId);
          return;
        }

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

      const catSummary = [];
      for (const [catName, pairs] of Object.entries(comparison.categories)) {
        const qty = pairs.reduce((sum, p) => sum + p.matchedQuantity, 0);
        if (qty > 0) catSummary.push(`${catName}: ${qty}`);
      }
      if (catSummary.length > 0) console.log(`  ${catSummary.join(", ")}`);
      console.log(`  Unmatched: ${comparison.summary.totalUnmatched1}`);

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[Compare] Done in ${elapsed}s`);

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
      finishJob(jobId);
    } catch (innerErr) {
      console.error("[Compare] Error:", innerErr.message);
      if (!aborted) {
        sendEvent("error", {
          error: innerErr.message || "Internal server error",
        });
      }
      res.end();
      finishJob(jobId);
    }
  } catch (err) {
    console.error("[Compare] Error:", err.message);
    if (!aborted) {
      sendEvent("error", { error: err.message || "Internal server error" });
    }
    res.end();
  }
});

// ============================================================
// POST endpoint — backward compatibility (no queue)
// ============================================================

app.post("/api/compare", async (req, res) => {
  const startTime = Date.now();

  try {
    const { url1, url2 } = req.body;

    if (!url1 || !url2) {
      return res
        .status(400)
        .json({ success: false, error: "Please provide both URLs." });
    }

    const trimmedUrl1 = url1.trim();
    const trimmedUrl2 = url2.trim();

    if (!detectMoxfieldUrl(trimmedUrl1)) {
      return res
        .status(400)
        .json({ success: false, error: `Unsupported URL: ${trimmedUrl1}` });
    }

    if (!detectMoxfieldUrl(trimmedUrl2)) {
      return res
        .status(400)
        .json({ success: false, error: `Unsupported URL: ${trimmedUrl2}` });
    }

    let result1, result2;

    if (trimmedUrl1 === trimmedUrl2) {
      result1 = await fetchAndParseMoxfield(trimmedUrl1);
      result2 = {
        cards: result1.cards.map((c) => ({ ...c })),
        label: result1.label,
      };
    } else {
      result1 = await fetchAndParseMoxfield(trimmedUrl1);
      result2 = await fetchAndParseMoxfield(trimmedUrl2);
    }

    const comparison = compareCards(result1.cards, result2.cards);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

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
    res
      .status(500)
      .json({ success: false, error: err.message || "Internal server error" });
  }
});

app.listen(PORT, () => {
  console.log(`========================================`);
  console.log(`  MTG List Comparator is running!`);
  console.log(`  Open http://localhost:${PORT} in your browser`);
  console.log(`========================================`);
});