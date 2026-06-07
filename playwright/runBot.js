// playwright/runBot.js
const { expect } = require("@playwright/test");
const loginWithCookies = require("./login");
const fs = require("fs");
const path = require("path");

async function runBot(client, onLog = () => {}) {
  const log = (msg) => { console.log(msg); onLog(msg); };

  const { avatarId, script, name } = client;
  log(`Starting bot for client: ${name}`);

  // login.js handles: cookies → cookie banner → T&C accept → skip promo
  const { browser, page } = await loginWithCookies();

  try {

    // ─── GO DIRECTLY TO AVATAR PAGE ───────────────────────────────
    log("Navigating to avatar page...");
    await page.goto(
      "https://ads.tiktok.com/creative/creativestudio/avatar",
      { waitUntil: "domcontentloaded", timeout: 60000 }
    );
    await page.waitForTimeout(5000);
    log(`Current URL: ${page.url()}`);
    log("Avatar page ready");

    // ─── SEARCH AVATAR ────────────────────────────────────────────
    const searchInput = page
      .locator('input[placeholder="Avatar ID"]')
      .filter({ visible: true })
      .first();
    await searchInput.waitFor({ state: "visible", timeout: 30000 });
    await searchInput.click();
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
    await searchInput.fill(avatarId);
    log(`Avatar ID entered: ${avatarId}`);
    await page.waitForTimeout(5000);

    // ─── CLICK AVATAR CARD ────────────────────────────────────────
    const avatar = page.locator('[data-testid="avatar-preview-item"]').first();
    await avatar.waitFor({ state: "attached", timeout: 15000 });
    log("Clicking avatar...");
    await avatar.evaluate((el) => el.click());
    await page.waitForTimeout(5000);

    // ─── CONTINUE ─────────────────────────────────────────────────
    const continueBtn = page.getByRole("button", { name: /continue/i }).first();
    await continueBtn.waitFor({ state: "visible", timeout: 30000 });
    await continueBtn.click();
    log("Continue clicked");
    await page.waitForTimeout(5000);

    // ─── TYPE SCRIPT ──────────────────────────────────────────────
    log("Waiting for editor...");
    const editor = page.locator('div[contenteditable="true"][role="textbox"]').first();
    await editor.waitFor({ state: "visible", timeout: 30000 });
    await editor.click();
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
    await page.keyboard.type(script, { delay: 10 });
    log("Script inserted");
    await page.waitForTimeout(3000);

    // ─── SAVE (optional) ──────────────────────────────────────────
    try {
      const saveBtn = page.getByRole("button", { name: /save/i }).first();
      if (await saveBtn.isVisible()) {
        await saveBtn.click();
        log("Save clicked");
        await page.waitForTimeout(3000);
      }
    } catch { log("Save not required"); }

    // ─── WAIT FOR PREVIEW ─────────────────────────────────────────
    log("Waiting for voice preview...");
    try { await page.getByText("Loading preview").waitFor({ state: "hidden", timeout: 180000 }); } catch {}
    try { await page.getByText("Please wait for the voice update").waitFor({ state: "hidden", timeout: 180000 }); } catch {}
    await page.waitForTimeout(5000);
    log("Preview ready");

    // ─── GENERATE ─────────────────────────────────────────────────
    const generateBtn = page.getByRole("button", { name: /generate/i }).first();
    await generateBtn.waitFor({ state: "visible", timeout: 30000 });
    await expect(generateBtn).toBeEnabled({ timeout: 180000 });

    // Intercept the history API so we know exactly which item ID was just created
    // We'll capture the API response right after clicking Generate
    let newItemId = null;

    // Listen for network responses from the history/list endpoint
    page.on("response", async (response) => {
      try {
        const url = response.url();
        if (
          url.includes("/creative/creativestudio/create/history") ||
          url.includes("aigc") ||
          url.includes("history") ||
          url.includes("generation")
        ) {
          const text = await response.text().catch(() => "");
          // Look for a JSON payload with a list of items
          if (text.includes('"status"') && text.includes('"id"')) {
            const json = JSON.parse(text);
            // Try to find the newest item (first in list, status = generating/pending)
            const items =
              json?.data?.list ||
              json?.data?.items ||
              json?.data?.generations ||
              json?.list ||
              [];
            if (items.length > 0 && !newItemId) {
              newItemId = items[0]?.id || items[0]?.task_id || null;
              if (newItemId) log(`Captured new item ID: ${newItemId}`);
            }
          }
        }
      } catch {}
    });

    await generateBtn.click();
    log("Generate clicked — navigating to history in 15s...");
    await page.waitForTimeout(15000);

    // ─── OPEN HISTORY ─────────────────────────────────────────────
    log("Opening Assets history...");
    await page.goto(
      "https://ads.tiktok.com/creative/creativestudio/create/history",
      { waitUntil: "domcontentloaded", timeout: 60000 }
    );
    await page.waitForTimeout(8000);

    // ─── WAIT FOR FIRST CARD TO FINISH GENERATING ─────────────────
    // Strategy: the first card in the grid is always the newest.
    // We wait until that card's container NO LONGER contains "Generating"
    // text AND contains a <video> element — meaning it's fully rendered.
    // We check using page.evaluate so we look at the actual DOM directly,
    // not Playwright's cached state, and we reload between checks.

    log("Waiting for the newest card to finish generating...");

    const MAX_WAIT_MINUTES = 15;
    const CHECK_INTERVAL_MS = 20000; // 20s between reloads
    const MAX_CHECKS = (MAX_WAIT_MINUTES * 60 * 1000) / CHECK_INTERVAL_MS;

    let videoReady = false;

    for (let g = 0; g < MAX_CHECKS; g++) {

      // Reload fresh page state every iteration
      if (g > 0) {
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForTimeout(8000);
      }

      // Check first card status directly in the DOM
      const firstCardState = await page.evaluate(() => {
        // Find all grid item containers — TikTok uses various class names
        // We pick the first child of the grid/list
        const selectors = [
          '[class*="card"]',
          '[class*="item"]',
          '[class*="grid"] > *',
          '[class*="list"] > *',
        ];

        let firstCard = null;
        for (const sel of selectors) {
          const els = document.querySelectorAll(sel);
          if (els.length > 0) { firstCard = els[0]; break; }
        }

        if (!firstCard) {
          // fallback: first element that contains a video or generating text
          firstCard = document.querySelector("video")?.closest("div[class]") || null;
        }

        const pageText = document.body.innerText || "";
        const hasGenerating = pageText.includes("Generating") || pageText.includes("generating");
        const hasVideo = !!document.querySelector("video");

        // Get text of first card specifically
        const firstCardText = firstCard ? firstCard.innerText : "";
        const firstCardHasGenerating =
          firstCardText.includes("Generating") ||
          firstCardText.includes("generating") ||
          firstCardText.includes("This may take");
        const firstCardHasVideo = firstCard ? !!firstCard.querySelector("video") : false;

        return {
          hasGenerating,
          hasVideo,
          firstCardHasGenerating,
          firstCardHasVideo,
          pageText: pageText.slice(0, 300),
        };
      });

      log(`Check ${g + 1}: firstCardGenerating=${firstCardState.firstCardHasGenerating}, firstCardVideo=${firstCardState.firstCardHasVideo}, pageGenerating=${firstCardState.hasGenerating}`);

      // Ready condition: first card has a video AND is NOT generating
      if (firstCardState.firstCardHasVideo && !firstCardState.firstCardHasGenerating) {
        log("✓ First card is fully rendered and ready!");
        videoReady = true;
        break;
      }

      // Also accept if no "Generating" text anywhere on the page and video exists
      if (!firstCardState.hasGenerating && firstCardState.hasVideo) {
        log("✓ No generating text found, video is ready!");
        videoReady = true;
        break;
      }

      log(`Still generating... waiting ${CHECK_INTERVAL_MS / 1000}s`);
    }

    if (!videoReady) {
      throw new Error("Video never finished generating after 15 minutes");
    }

    await page.waitForTimeout(3000);

    // ─── DOWNLOAD FIRST (NEWEST) CARD ─────────────────────────────
    log("Attempting to download the first video card...");

    let filePath = null;

    for (let i = 0; i < 10; i++) {
      log(`Download attempt ${i + 1}/10`);

      try {
        const firstVideo = page.locator("video").first();
        await firstVideo.waitFor({ state: "visible", timeout: 15000 });
        await firstVideo.scrollIntoViewIfNeeded();
        await page.waitForTimeout(1000);

        // Hover the first video card to reveal action buttons
        await firstVideo.hover({ force: true });
        await page.waitForTimeout(2500);

        const downloadBtn = page.getByText("Download").first();
        const visible = await downloadBtn.isVisible().catch(() => false);

        if (visible) {
          log("Download button visible — clicking...");
          const downloadPromise = page.waitForEvent("download");
          await downloadBtn.click();
          const download = await downloadPromise;

          const fileName = `${name.replace(/\s+/g, "_")}-${Date.now()}.mp4`;
          const downloadsDir = path.join(__dirname, "../downloads");
          if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });

          filePath = path.join(downloadsDir, fileName);
          await download.saveAs(filePath);
          log(`✓ Downloaded: ${fileName}`);
          break;
        } else {
          log("Download button not visible — re-hovering...");
          // Move mouse away and try again
          await page.mouse.move(0, 0);
          await page.waitForTimeout(1000);
        }
      } catch (e) {
        log(`Attempt ${i + 1} error: ${e.message}`);
      }

      if (i < 9) {
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForTimeout(8000);
      }
    }

    await browser.close();

    if (!filePath) throw new Error("Could not download video after 10 attempts");
    return filePath;

  } catch (err) {
    log(`ERROR: ${err.message}`);
    try {
      const title = await page.title().catch(() => "");
      log(`Page title at failure: "${title}" — URL: ${page.url()}`);
    } catch {}
    try {
      const fname = `error-${Date.now()}.png`;
      const errPath = path.join(__dirname, `../downloads/${fname}`);
      await page.screenshot({ path: errPath, fullPage: true });
      // /downloads is served statically — open this in a browser to SEE the page
      log(`📸 Screenshot saved — view it at: /downloads/${fname}`);
    } catch {}
    await browser.close();
    throw err;
  }
}

module.exports = runBot;