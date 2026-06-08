// playwright/login.js
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

async function loginWithCookies() {
  // Cookies come from cookies.json on disk (local) OR the TIKTOK_COOKIES_JSON
  // env var (Render, where the file isn't committed). File wins if present.
  let rawCookies;
  const cookiesPath = path.resolve(__dirname, "../cookies.json");
  if (fs.existsSync(cookiesPath)) {
    rawCookies = JSON.parse(fs.readFileSync(cookiesPath, "utf8"));
  } else if (process.env.TIKTOK_COOKIES_JSON) {
    try {
      rawCookies = JSON.parse(process.env.TIKTOK_COOKIES_JSON);
    } catch {
      throw new Error("TIKTOK_COOKIES_JSON is set but is not valid JSON");
    }
  } else {
    throw new Error("No TikTok cookies found: add cookies.json locally, or set TIKTOK_COOKIES_JSON on Render");
  }
  if (!Array.isArray(rawCookies) || !rawCookies.length) {
    throw new Error("TikTok cookies are empty or not a JSON array");
  }

  const cookies = rawCookies.map((c) => ({
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

  const HEADLESS = process.env.HEADLESS ? process.env.HEADLESS === "true" : false;

  // Optional proxy (recommended on cloud hosts where TikTok blocks datacenter IPs).
  // Set PROXY_SERVER (e.g. "http://host:port" or "socks5://host:port") and,
  // if the proxy needs auth, PROXY_USERNAME / PROXY_PASSWORD.
  const launchOpts = {
    headless: HEADLESS,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  };
  if (process.env.PROXY_SERVER) {
    launchOpts.proxy = {
      server: process.env.PROXY_SERVER,
      ...(process.env.PROXY_USERNAME ? { username: process.env.PROXY_USERNAME } : {}),
      ...(process.env.PROXY_PASSWORD ? { password: process.env.PROXY_PASSWORD } : {}),
    };
    console.log(`✓ Using proxy: ${process.env.PROXY_SERVER}`);
  }
  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext();

  // ─── STEP 1: INJECT SESSION COOKIES ───────────────────────────
  await context.addCookies(cookies);
  console.log(`✓ ${cookies.length} session cookies injected`);

  const page = await context.newPage();

  // ─── STEP 2: LOAD APP ENTRY POINT ─────────────────────────────
  console.log("Loading app entry point...");
  await page.goto(
    "https://ads.tiktok.com/creative/creativestudio/create",
    { waitUntil: "domcontentloaded", timeout: 60000 }
  );
  console.log(`Page loaded: ${page.url()}`);

  // ─── STEP 3: WAIT FOR COOKIE BANNER AND CLICK IT ──────────────
  // Wait up to 15 seconds for the banner to appear in DOM
  console.log("Waiting for cookie banner to appear...");
  let bannerFound = false;
  for (let w = 1; w <= 15; w++) {
    await page.waitForTimeout(1000);
    const exists = await page.evaluate(() => !!document.querySelector("tiktok-cookie-banner"));
    if (exists) {
      console.log(`✓ Cookie banner found after ${w}s`);
      bannerFound = true;
      break;
    }
    console.log(`Waiting for cookie banner... ${w}s`);
  }

  if (bannerFound) {
    // Now try clicking it up to 10 times until confirmed gone
    for (let attempt = 1; attempt <= 10; attempt++) {
      console.log(`Cookie banner click attempt ${attempt}/10...`);

      // Try all strategies in sequence each attempt
      // Strategy 1: pierce
      try {
        const btn = page.locator("tiktok-cookie-banner >> button").filter({ hasText: /allow all/i });
        if (await btn.isVisible({ timeout: 1000 })) {
          await btn.click();
          console.log("  → Clicked (strategy 1: pierce)");
          await page.waitForTimeout(1500);
        }
      } catch {}

      // Strategy 2: shadowRoot evaluate
      try {
        await page.evaluate(() => {
          const host = document.querySelector("tiktok-cookie-banner");
          if (!host) return;
          const root = host.shadowRoot || host;
          const btns = root.querySelectorAll("button");
          for (const btn of btns) {
            if ((btn.innerText || btn.textContent || "").trim().toLowerCase() === "allow all") {
              btn.click();
            }
          }
        });
        console.log("  → Clicked (strategy 2: shadowRoot)");
        await page.waitForTimeout(1500);
      } catch {}

      // Strategy 3: deep shadow walker
      try {
        await page.evaluate(() => {
          function findInShadows(root) {
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
            let node = walker.nextNode();
            while (node) {
              if (node.shadowRoot) {
                const found = findInShadows(node.shadowRoot);
                if (found) return found;
              }
              if (
                node.tagName === "BUTTON" &&
                (node.innerText || node.textContent || "").trim().toLowerCase() === "allow all"
              ) return node;
              node = walker.nextNode();
            }
            return null;
          }
          const btn = findInShadows(document);
          if (btn) btn.click();
        });
        console.log("  → Clicked (strategy 3: deep walker)");
        await page.waitForTimeout(1500);
      } catch {}

      // Strategy 4: getBoundingClientRect coordinates
      try {
        const coords = await page.evaluate(() => {
          const host = document.querySelector("tiktok-cookie-banner");
          if (!host) return null;
          const rect = host.getBoundingClientRect();
          return { x: rect.right - 120, y: rect.top + rect.height / 2 };
        });
        if (coords) {
          await page.mouse.click(coords.x, coords.y);
          console.log(`  → Clicked (strategy 4: coords ${Math.round(coords.x)},${Math.round(coords.y)})`);
          await page.waitForTimeout(1500);
        }
      } catch {}

      // Check if banner is gone
      const stillThere = await page.evaluate(() => {
        const host = document.querySelector("tiktok-cookie-banner");
        if (!host) return false;
        const style = window.getComputedStyle(host);
        return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
      });

      if (!stillThere) {
        console.log(`✓ Cookie banner gone after attempt ${attempt}`);
        break;
      }

      if (attempt === 10) {
        console.log("Warning: Cookie banner still present after 10 attempts");
      }

      await page.waitForTimeout(1000);
    }
  } else {
    console.log("Cookie banner never appeared — continuing");
  }

  await page.waitForTimeout(2000);

  // ─── STEP 4: ACCEPT T&C (button is disabled until terms scrolled / agreed) ──
  console.log("Checking for T&C accept button...");
  let tcAccepted = false;
  for (let attempt = 1; attempt <= 5; attempt++) {
    console.log(`T&C accept attempt ${attempt}/5...`);
    try {
      const btn = page.getByRole("button", { name: /accept|agree|continue|confirm/i }).first();
      await btn.waitFor({ timeout: 15000 });

      // The Accept button is often disabled until you scroll the terms to the
      // bottom and/or tick an "I agree" checkbox. Do that, then wait for enable.
      for (let i = 0; i < 10; i++) {
        const enabled = await btn.evaluate(
          (el) => !(el.disabled || el.getAttribute("aria-disabled") === "true")
        ).catch(() => false);
        if (enabled) break;

        await page.evaluate(() => {
          const handle = (root) => {
            // scroll every scrollable container to the bottom
            root.querySelectorAll("*").forEach((el) => {
              try {
                const s = getComputedStyle(el);
                if ((s.overflowY === "auto" || s.overflowY === "scroll") &&
                    el.scrollHeight > el.clientHeight + 4) {
                  el.scrollTop = el.scrollHeight;
                }
              } catch {}
            });
            // tick any agreement checkbox
            root.querySelectorAll('input[type="checkbox"], [role="checkbox"]').forEach((cb) => {
              try {
                const checked = cb.checked || cb.getAttribute("aria-checked") === "true";
                if (!checked) cb.click();
              } catch {}
            });
            // recurse into shadow roots
            root.querySelectorAll("*").forEach((el) => { if (el.shadowRoot) handle(el.shadowRoot); });
          };
          handle(document);
        });
        await page.waitForTimeout(1500);
      }

      await btn.click({ timeout: 8000 }).catch(async () => { await btn.click({ force: true }); });
      console.log("✓ T&C accepted");
      await page.waitForTimeout(3000);
      tcAccepted = true;
      break;
    } catch (e) {
      console.log(`  T&C attempt ${attempt} error: ${e.message}`);
    }
  }
  if (!tcAccepted) console.log("T&C modal never appeared — continuing");

  // ─── STEP 5: SKIP PROMO MODAL ─────────────────────────────────
  console.log("Checking for promo/skip modal...");
  let skipped = false;
  for (let attempt = 1; attempt <= 5; attempt++) {
    console.log(`Skip attempt ${attempt}/5...`);
    try {
      const btn = page.getByRole("button", { name: /skip/i });
      await btn.waitFor({ timeout: 15000 });
      await btn.click();
      console.log("✓ Promo modal skipped");
      await page.waitForTimeout(2000);
      skipped = true;
      break;
    } catch (e) {
      console.log(`  Skip attempt ${attempt} error: ${e.message}`);
    }
  }
  if (!skipped) console.log("No promo modal found — continuing");

  // ─── STEP 6: CONFIRM APP READY ────────────────────────────────
  try {
    await page.locator('text="Avatar videos"').waitFor({ state: "visible", timeout: 15000 });
    console.log("✓ App sidebar ready");
  } catch {
    console.log("Sidebar not confirmed — continuing anyway");
  }

  await page.waitForTimeout(2000);
  console.log("✓ Login complete — handing off to runBot");

  return { browser, context, page };
}

module.exports = loginWithCookies;