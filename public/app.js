document.addEventListener("DOMContentLoaded", () => {
  const url1Input = document.getElementById("url1");
  const url2Input = document.getElementById("url2");
  const compareBtn = document.getElementById("compareBtn");
  const statusDiv = document.getElementById("status");
  const progressDiv = document.getElementById("progress");
  const progressFill = document.getElementById("progressFill");
  const progressText = document.getElementById("progressText");
  const resultsDiv = document.getElementById("results");

  let displayMode = localStorage.getItem("displayMode") || "image";
  let lastResults = null;

  compareBtn.addEventListener("click", () => {
    const url1 = url1Input.value.trim();
    const url2 = url2Input.value.trim();

    if (!url1 || !url2) {
      showStatus("Please enter both URLs.", "error");
      return;
    }

    if (!url1.includes("moxfield.com")) {
      showStatus(
        "First URL doesn't look like a Moxfield link. Supported: moxfield.com/decks/, /collection/, /binders/",
        "error"
      );
      return;
    }
    if (!url2.includes("moxfield.com")) {
      showStatus(
        "Second URL doesn't look like a Moxfield link. Supported: moxfield.com/decks/, /collection/, /binders/",
        "error"
      );
      return;
    }

    compareBtn.disabled = true;
    resultsDiv.innerHTML = "";
    showStatus("", "");
    showProgress("Connecting...", 0);

    const params = new URLSearchParams({ url1, url2 });
    const evtSource = new EventSource(
      `/api/compare-stream?${params.toString()}`
    );

    evtSource.addEventListener("progress", (e) => {
      try {
        const data = JSON.parse(e.data);
        const msg = data.message || "Working...";

        if (data.stage === "queue") {
          // Show queue position with a pulsing style
          showProgress(`⏳ ${msg}`, 0);
          progressFill.classList.add("queue-waiting");
          return;
        }

        // Once out of queue, remove pulsing
        progressFill.classList.remove("queue-waiting");

        // Extract percentage from page progress messages
        const pctMatch = msg.match(/(\d+)%/);
        const pct = pctMatch ? parseInt(pctMatch[1]) : null;

        // Map stages to overall progress ranges
        let overallPct = 0;
        if (data.stage === "list1") {
          overallPct = pct !== null ? Math.round(pct * 0.4) : 20;
        } else if (data.stage === "list2") {
          overallPct = pct !== null ? 40 + Math.round(pct * 0.5) : 60;
        } else if (data.stage === "matching") {
          overallPct = 92;
        }

        showProgress(msg, overallPct);
      } catch (err) {
        // ignore
      }
    });

    evtSource.addEventListener("result", (e) => {
      evtSource.close();
      progressFill.classList.remove("queue-waiting");

      try {
        const data = JSON.parse(e.data);
        if (!data.success) {
          hideProgress();
          showStatus(`Error: ${data.error}`, "error");
          compareBtn.disabled = false;
          return;
        }

        showProgress("Done!", 100);

        setTimeout(() => {
          hideProgress();
          const elapsed = data.elapsed ? ` (${data.elapsed})` : "";
          showStatus(`✅ Comparison complete!${elapsed}`, "success");
          lastResults = data;
          renderResults(data);
          compareBtn.disabled = false;
        }, 400);
      } catch (err) {
        hideProgress();
        showStatus(`Error parsing results: ${err.message}`, "error");
        compareBtn.disabled = false;
      }
    });

    evtSource.addEventListener("error", (e) => {
      progressFill.classList.remove("queue-waiting");

      if (e.data) {
        evtSource.close();
        try {
          const data = JSON.parse(e.data);
          hideProgress();
          showStatus(`Error: ${data.error}`, "error");
        } catch {
          hideProgress();
          showStatus("An unexpected error occurred.", "error");
        }
        compareBtn.disabled = false;
        return;
      }

      evtSource.close();
      hideProgress();
      showStatus("Connection lost. Please try again.", "error");
      compareBtn.disabled = false;
    });
  });

  // ---- Status ----

  function showStatus(message, type) {
    statusDiv.textContent = message;
    statusDiv.className = `status ${type}`;
  }

  // ---- Progress ----

  function showProgress(message, percent) {
    progressDiv.classList.add("visible");
    progressText.textContent = message;
    progressFill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
  }

  function hideProgress() {
    progressDiv.classList.remove("visible");
    progressFill.style.width = "0%";
    progressFill.classList.remove("queue-waiting");
    progressText.textContent = "";
  }

  // ---- Categories ----

  const CATEGORY_ORDER = [
    {
      key: "fullMatch",
      label: "Full Match",
      desc: "Same card, set, collector #, and foil status",
    },
    {
      key: "almostFullMatch",
      label: "Almost Full Match",
      desc: "Same card & set, promo/variant collector #, same foil",
    },
    {
      key: "fullMatchNoFoil",
      label: "Full Match No Foil",
      desc: "Same card, set, collector # — different foil status",
    },
    {
      key: "setMatch",
      label: "Set Match",
      desc: "Same card & set, different collector #",
    },
    {
      key: "sameCard",
      label: "Same Card",
      desc: "Same card, different set",
    },
  ];

  // ---- Render ----

  function renderResults(data) {
    let html = "";

    const totalMatched = data.summary ? data.summary.totalMatched : 0;
    const totalUnmatched1 = data.summary ? data.summary.totalUnmatched1 : 0;

    html += `
      <div class="summary-bar">
        <div class="summary-item">
          <div class="summary-number">${data.list1Count}</div>
          <div class="summary-label">Cards in List 1</div>
        </div>
        <div class="summary-item">
          <div class="summary-number">${data.list2Count}</div>
          <div class="summary-label">Cards in List 2</div>
        </div>
        <div class="summary-item">
          <div class="summary-number" style="color: #2ecc71;">${totalMatched}</div>
          <div class="summary-label">Matched</div>
        </div>
        <div class="summary-item">
          <div class="summary-number" style="color: #e74c3c;">${totalUnmatched1}</div>
          <div class="summary-label">Unmatched</div>
        </div>
      </div>
    `;

    html += `
      <div class="toggle-bar">
        <button class="toggle-btn ${displayMode === "image" ? "active" : ""}" data-mode="image">🖼️ Images</button>
        <button class="toggle-btn ${displayMode === "text" ? "active" : ""}" data-mode="text">📝 Text</button>
      </div>
    `;

    for (const cat of CATEGORY_ORDER) {
      const pairs = data.categories[cat.key];
      if (!pairs || pairs.length === 0) continue;

      const totalQty = pairs.reduce((sum, p) => sum + p.matchedQuantity, 0);

      html += `
        <div class="category-section">
          <div class="category-header">
            <h2 class="category-title">${cat.label}</h2>
            <span class="category-count">${totalQty} card${totalQty !== 1 ? "s" : ""}</span>
          </div>
          <div class="category-desc">${cat.desc}</div>
          <div class="column-headers">
            <div class="column-header">List 1</div>
            <div></div>
            <div class="column-header column-header-right">List 2</div>
          </div>
      `;

      for (const pair of pairs) {
        html += renderMatchRow(pair);
      }

      html += `</div>`;
    }

    if (data.unmatched1 && data.unmatched1.length > 0) {
      html += renderUnmatchedSection(
        data.unmatched1,
        "Unmatched Cards",
        totalUnmatched1
      );
    }

    if (totalMatched === 0 && totalUnmatched1 === 0) {
      html += `<p style="text-align:center; color:#888; margin-top:30px;">No cards to compare.</p>`;
    }

    resultsDiv.innerHTML = html;

    document.querySelectorAll(".toggle-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        displayMode = btn.dataset.mode;
        localStorage.setItem("displayMode", displayMode);
        if (lastResults) renderResults(lastResults);
      });
    });
  }

  // ---- Match Row ----

  function renderMatchRow(pair) {
    if (displayMode === "image") {
      return `
        <div class="match-row">
          <div class="card-side">
            ${renderCardImage(pair.card1)}
            ${renderCardInfo(pair.card1, pair.matchedQuantity)}
          </div>
          <div class="match-separator">⟷</div>
          <div class="card-side right">
            ${renderCardImage(pair.card2)}
            ${renderCardInfo(pair.card2, pair.matchedQuantity)}
          </div>
        </div>
      `;
    } else {
      return `
        <div class="match-row">
          <div class="card-side-text">
            ${renderCardText(pair.card1, pair.matchedQuantity)}
          </div>
          <div class="match-separator">⟷</div>
          <div class="card-side-text right">
            ${renderCardText(pair.card2, pair.matchedQuantity)}
          </div>
        </div>
      `;
    }
  }

  function renderCardImage(card) {
    if (card.imageUrl) {
      return `<img class="card-image" src="${card.imageUrl}" alt="${escapeHtml(card.cardName)}" loading="lazy" />`;
    }
    return `<div class="card-image" style="width:150px;height:210px;background:#0d1117;border-radius:8px;display:flex;align-items:center;justify-content:center;color:#555;font-size:0.8rem;text-align:center;padding:10px;">No image</div>`;
  }

  function renderCardInfo(card, qty) {
    return `
      <div class="card-info">
        <div class="card-name">${escapeHtml(card.cardName)}</div>
        <div class="card-set">${escapeHtml(card.setName || card.setCode)} (${escapeHtml(card.setCode)})</div>
        <div class="card-details">#${escapeHtml(card.collectorNumber || "?")}</div>
        ${card.foil ? '<div class="card-foil">⭐ Foil</div>' : ""}
        ${qty > 1 ? `<div class="card-qty">×${qty}</div>` : ""}
      </div>
    `;
  }

  function renderCardText(card, qty) {
    const qtyStr = qty > 1 ? `×${qty} ` : "";
    const foilStr = card.foil ? " ⭐ Foil" : "";
    return `
      <div class="card-name">${qtyStr}${escapeHtml(card.cardName)}</div>
      <div class="card-set">${escapeHtml(card.setName || card.setCode)} (${escapeHtml(card.setCode)}) · #${escapeHtml(card.collectorNumber || "?")}${foilStr}</div>
    `;
  }

  // ---- Unmatched ----

  function renderUnmatchedSection(cards, title, totalQty) {
    let html = `
      <div class="unmatched-section">
        <div class="unmatched-header">
          <h2 class="unmatched-title">${escapeHtml(title)}</h2>
          <span class="unmatched-count">${totalQty} card${totalQty !== 1 ? "s" : ""}</span>
        </div>
        <div class="unmatched-grid">
    `;

    for (const card of cards) {
      const foilStr = card.foil ? " ⭐ Foil" : "";
      const qtyStr = card.quantity > 1 ? `×${card.quantity} ` : "";

      if (displayMode === "image" && card.imageUrl) {
        html += `
          <div class="unmatched-card">
            <img src="${card.imageUrl}" alt="${escapeHtml(card.cardName)}" style="width:100%;border-radius:6px;margin-bottom:6px;" loading="lazy" />
            <div class="unmatched-card-name">${qtyStr}${escapeHtml(card.cardName)}</div>
            <div class="unmatched-card-details">
              ${escapeHtml(card.setName || card.setCode)} (${escapeHtml(card.setCode)})
              · #${escapeHtml(card.collectorNumber || "?")}${foilStr}
            </div>
          </div>
        `;
      } else {
        html += `
          <div class="unmatched-card">
            <div class="unmatched-card-name">${qtyStr}${escapeHtml(card.cardName)}</div>
            <div class="unmatched-card-details">
              ${escapeHtml(card.setName || card.setCode)} (${escapeHtml(card.setCode)})
              · #${escapeHtml(card.collectorNumber || "?")}${foilStr}
            </div>
          </div>
        `;
      }
    }

    html += `</div></div>`;
    return html;
  }

  // ---- Utility ----

  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
});