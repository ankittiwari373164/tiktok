// playwright/youtubeUpload.js
// Uploads a finished video to a client's YouTube channel via Studio automation.
// Mirrors the cookie-based Playwright pattern used by login.js / runBot.js.
//
// Per-client session cookies live at: ../youtube_cookies/<clientId>.json
// (export them with a "Get cookies.txt"/EditThisCookie style extension while
//  logged into that channel's YouTube account — same approach as cookies.json)

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const COOKIE_DIR = path.resolve(__dirname, "../youtube_cookies");

function loadClientCookies(clientId) {
  const p = path.join(COOKIE_DIR, `${clientId}.json`);
  if (!fs.existsSync(p)) {
    throw new Error(`No YouTube cookies for this client. Connect the channel first (upload its cookies).`);
  }
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  return raw.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || "/",
    expires: c.expirationDate ? Math.floor(c.expirationDate) : -1,
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    sameSite:
      c.sameSite === "no_restriction"
        ? "None"
        : ["Strict", "Lax", "None"].includes(c.sameSite)
        ? c.sameSite
        : "Lax",
  }));
}

// Try a list of locators; click the first visible one. Returns true on success.
async function clickFirst(page, locators, log, label) {
  for (const make of locators) {
    try {
      const loc = make();
      if (await loc.isVisible({ timeout: 2500 }).catch(() => false)) {
        await loc.click({ timeout: 5000 });
        log(`  → ${label} clicked`);
        return true;
      }
    } catch {}
  }
  return false;
}

/**
 * @param {object} client   { _id, name }
 * @param {string} filePath absolute path to the .mp4 to upload
 * @param {object} meta     { title, description, tags: string[] }
 * @param {function} onLog
 * @returns {Promise<{videoUrl: string|null}>}
 */
async function uploadToYouTube(client, filePath, meta, onLog = () => {}) {
  const log = (m) => { console.log(m); onLog(m); };

  if (!fs.existsSync(filePath)) throw new Error(`Video file not found: ${filePath}`);
  const cookies = loadClientCookies(client._id);

  log(`▶ YouTube upload starting for "${client.name}"`);
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ acceptDownloads: false });
  await context.addCookies(cookies);
  log(`✓ ${cookies.length} YouTube cookies injected`);

  const page = await context.newPage();

  try {
    // ─── 1. OPEN STUDIO ──────────────────────────────────────────
    log("Opening YouTube Studio...");
    await page.goto("https://studio.youtube.com", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(6000);

    if (/accounts\.google\.com|signin/i.test(page.url())) {
      throw new Error("Not logged in — YouTube cookies are invalid or expired. Reconnect the channel.");
    }
    log(`Studio ready: ${page.url()}`);

    // ─── 2. OPEN UPLOAD DIALOG ───────────────────────────────────
    // Preferred: trigger the upload dialog directly.
    log("Opening upload dialog...");
    let dialogOpen = await clickFirst(page, [
      () => page.locator("#create-icon").first(),
      () => page.getByRole("button", { name: /create/i }).first(),
      () => page.locator('ytcp-button:has-text("Create")').first(),
    ], log, "Create");

    if (dialogOpen) {
      await page.waitForTimeout(1500);
      await clickFirst(page, [
        () => page.getByText(/^Upload videos?$/i).first(),
        () => page.locator('tp-yt-paper-item:has-text("Upload videos")').first(),
        () => page.locator('#text-item-0').first(),
      ], log, "Upload videos");
    } else {
      // Fallback: direct upload URL
      log("Create button not found — using direct upload URL fallback");
      await page.goto("https://www.youtube.com/upload", { waitUntil: "domcontentloaded", timeout: 60000 });
    }
    await page.waitForTimeout(4000);

    // ─── 3. SELECT FILE ──────────────────────────────────────────
    log(`Selecting file: ${path.basename(filePath)}`);
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.waitFor({ state: "attached", timeout: 30000 });
    await fileInput.setInputFiles(filePath);
    log("✓ File handed to uploader — upload running in background");
    await page.waitForTimeout(8000);

    // ─── 4. TITLE ────────────────────────────────────────────────
    log("Setting title...");
    const titleBox = page.locator('#title-textarea #textbox, ytcp-social-suggestions-textbox[id="title-textarea"] #textbox, #textbox[aria-label*="title" i]').first();
    await titleBox.waitFor({ state: "visible", timeout: 60000 });
    await titleBox.click();
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(500);
    await titleBox.fill(meta.title);
    log(`  → Title: ${meta.title}`);
    await page.waitForTimeout(1500);

    // ─── 5. DESCRIPTION (includes hashtags) ──────────────────────
    log("Setting description...");
    try {
      const descBox = page.locator('#description-textarea #textbox, #textbox[aria-label*="description" i]').first();
      await descBox.click({ timeout: 8000 });
      await page.keyboard.press("Control+A");
      await page.keyboard.press("Backspace");
      await descBox.fill(meta.description);
      log("  → Description set");
    } catch (e) {
      log(`  ⚠ Could not set description: ${e.message}`);
    }
    await page.waitForTimeout(1500);

    // ─── 6. "NO, IT'S NOT MADE FOR KIDS" ─────────────────────────
    log("Setting audience → Not made for kids...");
    const mfkDone = await clickFirst(page, [
      () => page.locator('tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]').first(),
      () => page.getByRole("radio", { name: /not made for kids/i }).first(),
      () => page.locator('#audience').getByText(/no, it'?s not made for kids/i).first(),
      () => page.getByText(/no, it'?s not made for kids/i).first(),
    ], log, "Not made for kids");
    if (!mfkDone) log("  ⚠ Could not find 'Not made for kids' radio — verify manually");
    await page.waitForTimeout(1000);

    // ─── 7. SHOW MORE (expand advanced options) ──────────────────
    log("Expanding 'Show more'...");
    await clickFirst(page, [
      () => page.locator("#toggle-button").first(),
      () => page.getByRole("button", { name: /show more/i }).first(),
      () => page.locator('ytcp-button:has-text("Show more")').first(),
    ], log, "Show more");
    await page.waitForTimeout(2000);

    // ─── 8. TAGS ─────────────────────────────────────────────────
    if (meta.tags && meta.tags.length) {
      log(`Setting ${meta.tags.length} tags...`);
      try {
        const tagsInput = page.locator('#tags-container input, input[aria-label*="tag" i]').first();
        await tagsInput.scrollIntoViewIfNeeded();
        await tagsInput.click({ timeout: 8000 });
        // Studio accepts comma-separated entry
        await tagsInput.type(meta.tags.join(",") + ",", { delay: 8 });
        log("  → Tags set");
      } catch (e) {
        log(`  ⚠ Could not set tags: ${e.message}`);
      }
      await page.waitForTimeout(1000);
    }

    // ─── 9. UNTICK "Show how many viewers like this video" ───────
    log("Unchecking 'Show how many viewers like this video'...");
    try {
      const likeCheckbox = page
        .locator('ytcp-checkbox-lit, ytcp-checkbox')
        .filter({ hasText: /show how many viewers like this video/i })
        .first();

      // Fall back to locating the row by text then its checkbox.
      let target = likeCheckbox;
      if (!(await target.isVisible({ timeout: 2500 }).catch(() => false))) {
        const row = page.getByText(/show how many viewers like this video/i).first();
        await row.scrollIntoViewIfNeeded().catch(() => {});
        target = row.locator('xpath=ancestor::*[self::div or self::ytcp-checkbox-lit][1]').first();
      }
      await target.scrollIntoViewIfNeeded().catch(() => {});

      const isChecked = await target.evaluate((el) => {
        const cb = el.matches('[aria-checked]') ? el : el.querySelector('[aria-checked]');
        return cb ? cb.getAttribute("aria-checked") === "true" : null;
      }).catch(() => null);

      if (isChecked === false) {
        log("  → Already unticked");
      } else {
        await target.click({ timeout: 5000 });
        log("  → Unticked like-count visibility");
      }
    } catch (e) {
      log(`  ⚠ Could not toggle like-count visibility: ${e.message} — verify manually`);
    }
    await page.waitForTimeout(1000);

    // ─── 10. NEXT × 3 (Details → Elements → Checks → Visibility) ─
    log("Advancing through steps...");
    for (let i = 0; i < 3; i++) {
      const clicked = await clickFirst(page, [
        () => page.locator("#next-button").first(),
        () => page.getByRole("button", { name: /^next$/i }).first(),
      ], log, `Next (${i + 1}/3)`);
      if (!clicked) { log(`  ⚠ Next button ${i + 1} not found`); }
      await page.waitForTimeout(2500);
    }

    // ─── 11. VISIBILITY → PUBLIC ─────────────────────────────────
    log("Setting visibility → Public...");
    const pubDone = await clickFirst(page, [
      () => page.locator('tp-yt-paper-radio-button[name="PUBLIC"]').first(),
      () => page.getByRole("radio", { name: /^public$/i }).first(),
      () => page.locator('#privacy-radios').getByText(/^public$/i).first(),
    ], log, "Public");
    if (!pubDone) log("  ⚠ Could not select Public — verify manually");
    await page.waitForTimeout(2000);

    // ─── 12. WAIT FOR PROCESSING ENOUGH TO PUBLISH ───────────────
    // The publish/done button is disabled until upload reaches a usable %.
    log("Waiting for upload to be publishable...");
    const doneBtn = page.locator("#done-button").first();
    for (let w = 0; w < 60; w++) { // up to ~10 min
      const visible = await doneBtn.isVisible().catch(() => false);
      const disabled = visible
        ? await doneBtn.evaluate((el) => el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true").catch(() => true)
        : true;
      if (visible && !disabled) break;
      if (w % 6 === 0) log(`  …still processing (${w * 10}s)`);
      await page.waitForTimeout(10000);
    }

    // ─── 13. PUBLISH ─────────────────────────────────────────────
    log("Publishing...");
    const published = await clickFirst(page, [
      () => page.locator("#done-button").first(),
      () => page.getByRole("button", { name: /^(publish|done)$/i }).first(),
    ], log, "Publish");
    if (!published) throw new Error("Publish/Done button never became clickable");
    await page.waitForTimeout(6000);

    // ─── 14. CAPTURE SHARE URL ───────────────────────────────────
    let videoUrl = null;
    try {
      const link = page.locator('a[href*="youtu.be/"], a[href*="watch?v="]').first();
      if (await link.isVisible({ timeout: 8000 }).catch(() => false)) {
        videoUrl = await link.getAttribute("href");
      }
    } catch {}
    if (videoUrl) log(`✓ Published → ${videoUrl}`);
    else log("✓ Published (share URL not captured — check the channel)");

    // Close the confirmation dialog if present
    await clickFirst(page, [
      () => page.getByRole("button", { name: /^close$/i }).first(),
      () => page.locator("#close-button").first(),
    ], log, "Close dialog");

    await browser.close();
    return { videoUrl };

  } catch (err) {
    log(`✗ YouTube upload ERROR: ${err.message}`);
    try {
      const dir = path.resolve(__dirname, "../downloads");
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const errPath = path.join(dir, `yt-error-${Date.now()}.png`);
      await page.screenshot({ path: errPath, fullPage: true });
      log(`  (screenshot saved: ${path.basename(errPath)})`);
    } catch {}
    await browser.close();
    throw err;
  }
}

module.exports = { uploadToYouTube, COOKIE_DIR };