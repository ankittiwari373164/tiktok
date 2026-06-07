// rssGroq.js
const Groq = require("groq-sdk");

// ═══════════════════════════════════════════════════════
//  RSS XML HELPERS
// ═══════════════════════════════════════════════════════

function between(str, open, close) {
  const s = str.indexOf(open);
  if (s === -1) return "";
  const e = str.indexOf(close, s + open.length);
  if (e === -1) return "";
  return str.slice(s + open.length, e).trim();
}

function stripTags(str) {
  return str
    .replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ").trim();
}

// Try multiple proxy/direct strategies to fetch an RSS feed
async function fetchRssXml(url) {
  const strategies = [
    // 1. Direct fetch with browser-like headers
    () => fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/rss+xml, application/xml, text/xml, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
      },
      signal: AbortSignal.timeout(12000),
    }),
    // 2. RSS2JSON public API (works for most feeds)
    () => fetch(`https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(url)}&count=5`, {
      signal: AbortSignal.timeout(12000),
    }),
    // 3. AllOrigins proxy
    () => fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(url)}`, {
      signal: AbortSignal.timeout(12000),
    }),
  ];

  for (const strategy of strategies) {
    try {
      const res = await strategy();
      if (!res.ok) continue;
      const text = await res.text();
      // rss2json returns JSON — convert back to items
      if (text.includes('"status":"ok"') || text.includes('"items"')) {
        try {
          const json = JSON.parse(text);
          if (json.status === "ok" && json.items?.length) {
            return { type: "json", items: json.items };
          }
        } catch {}
      }
      // allorigins wraps in {contents:"..."}
      if (text.includes('"contents"')) {
        try {
          const json = JSON.parse(text);
          if (json.contents) return { type: "xml", xml: json.contents };
        } catch {}
      }
      // Raw XML
      if (text.includes("<item") || text.includes("<entry")) {
        return { type: "xml", xml: text };
      }
    } catch {}
  }
  throw new Error(`All fetch strategies failed for: ${url}`);
}

async function fetchTopArticles(rssUrl, maxItems = 3) {
  const result = await fetchRssXml(rssUrl);

  if (result.type === "json") {
    // rss2json format
    return result.items.slice(0, maxItems).map(item => ({
      title:       item.title || "Untitled",
      description: stripTags(item.description || item.content || "").slice(0, 600),
      pubDate:     item.pubDate || "",
      link:        item.link || "",
    })).filter(i => i.title && i.title !== "Untitled");
  }

  // XML format
  const xml = result.xml;
  const itemRegex = /<item[\s>][\s\S]*?<\/item>/gi;
  // Also handle Atom feeds
  const entryRegex = /<entry[\s>][\s\S]*?<\/entry>/gi;

  const items = [];
  let match;

  const regex = xml.includes("<item") ? itemRegex : entryRegex;
  while ((match = regex.exec(xml)) !== null && items.length < maxItems) {
    const item = match[0];
    const title = stripTags(
      between(item, "<title>", "</title>") ||
      between(item, "<title ", ">") // Atom title with attributes
    );
    const description = stripTags(
      between(item, "<description>", "</description>") ||
      between(item, "<summary>", "</summary>") ||
      between(item, "<content:encoded>", "</content:encoded>")
    ).slice(0, 600);
    const pubDate = stripTags(
      between(item, "<pubDate>", "</pubDate>") ||
      between(item, "<published>", "</published>") ||
      between(item, "<updated>", "</updated>")
    );
    const link = stripTags(
      between(item, "<link>", "</link>") ||
      between(item, 'href="', '"')
    );
    if (title) items.push({ title, description, pubDate, link });
  }

  if (!items.length) throw new Error(`No articles parsed from feed: ${rssUrl}`);
  return items;
}

// ═══════════════════════════════════════════════════════
//  GROQ SCRIPT GENERATION
// ═══════════════════════════════════════════════════════

function groqClient() {
  if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY is not set in .env");
  return new Groq({ apiKey: process.env.GROQ_API_KEY });
}

async function generateOneScript(article, category, clientName) {
  const groq = groqClient();

  const system = `You are a professional TikTok scriptwriter for avatar videos.
Write engaging, conversational scripts for a single presenter speaking to camera.
Rules:
- Target 120–160 words (roughly 60–75 seconds of natural speech)
- Open with a strong hook — make the first sentence impossible to scroll past
- Use short punchy sentences. Vary rhythm. Avoid academic language.
- Include 1–2 concrete facts or surprising details from the article
- End with a clear call to action or a thought-provoking question
- NO stage directions, NO "HOST:", NO scene labels, NO emojis, NO hashtags
- Output ONLY the script text — no title, no preamble, no quotes around it`;

  const user = `Article headline: "${article.title}"
${article.description ? `Summary: ${article.description}` : ""}
${category ? `Topic category: ${category}` : ""}
${clientName ? `Channel/brand: ${clientName}` : ""}

Write the TikTok avatar script now.`;

  const completion = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    temperature: 0.75,
    max_tokens: 400,
  });

  return completion.choices[0]?.message?.content?.trim() || "";
}

// ═══════════════════════════════════════════════════════
//  PUBLIC: Fetch 2-3 scripts from multiple feeds
// ═══════════════════════════════════════════════════════

async function fetchAndGenerateScripts(rssFeeds, clientName = "") {
  if (!rssFeeds || rssFeeds.length === 0) throw new Error("No RSS feeds configured for this client");

  console.log(`Fetching ${rssFeeds.length} RSS feeds...`);

  // Fetch articles from all feeds in parallel (fail-safe per feed)
  const feedResults = await Promise.allSettled(
    rssFeeds.map(async (feed) => {
      try {
        console.log(`  → Fetching: ${feed.label || feed.url}`);
        const articles = await fetchTopArticles(feed.url, 2);
        console.log(`  ✓ Got ${articles.length} articles from ${feed.label || feed.url}`);
        return articles.map(a => ({ ...a, feedLabel: feed.label || feed.url, category: feed.category }));
      } catch (e) {
        console.log(`  ✗ Failed: ${feed.label || feed.url} — ${e.message}`);
        throw e;
      }
    })
  );

  // Flatten successful results
  let allArticles = [];
  feedResults.forEach(r => { if (r.status === "fulfilled") allArticles.push(...r.value); });

  console.log(`Total articles collected: ${allArticles.length}`);
  if (!allArticles.length) throw new Error("No articles could be fetched from any RSS feed. Try different feeds or check your internet connection.");

  // Pick up to 3 — preferring one per category
  const seen = new Set();
  const picked = [];
  for (const a of allArticles) {
    if (picked.length >= 3) break;
    if (!seen.has(a.category)) { seen.add(a.category); picked.push(a); }
  }
  for (const a of allArticles) {
    if (picked.length >= 3) break;
    if (!picked.includes(a)) picked.push(a);
  }

  console.log(`Generating scripts for ${picked.length} articles via Groq...`);

  // Generate scripts in parallel
  const withScripts = await Promise.all(
    picked.map(async (a) => {
      const script = await generateOneScript(a, a.category, clientName);
      return { article: a, script, feedLabel: a.feedLabel, category: a.category };
    })
  );

  return withScripts;
}

// ═══════════════════════════════════════════════════════
//  PUBLIC: Generate 30-day content calendar
// ═══════════════════════════════════════════════════════

async function generateContentCalendar(client) {
  const groq = groqClient();

  const categories = [...new Set((client.rssFeeds || []).map(f => f.category).filter(Boolean))];
  const catHint = categories.length ? categories.join(", ") : "general news and trending topics";

  const today = new Date();
  const dates = Array.from({ length: 30 }, (_, i) => {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    return d.toISOString().split("T")[0];
  });

  const system = `You are a social media content strategist specializing in TikTok avatar videos.
Output ONLY a valid JSON array — no markdown, no backticks, no explanation before or after.
The array must contain exactly 30 objects, each with these exact keys:
  "date": "YYYY-MM-DD",
  "topicTitle": "short punchy topic title (max 8 words)",
  "script": "full TikTok avatar script, 120-160 words, conversational, no stage directions, strong hook, ends with CTA or question"`;

  const user = `Client/channel name: ${client.name}
Content categories: ${catHint}
Dates to cover (use these exact dates in order):
${dates.join(", ")}

Generate a 30-day content calendar with unique, varied topic ideas. Mix breaking-news commentary, trending analysis, opinion takes, and educational content. Make each topic distinct. Output only the JSON array.`;

  const completion = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    temperature: 0.8,
    max_tokens: 8000,
  });

  const raw = completion.choices[0]?.message?.content?.trim() || "[]";
  const cleaned = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();

  let entries;
  try { entries = JSON.parse(cleaned); }
  catch { throw new Error("Groq returned invalid JSON for the calendar. Try again."); }

  if (!Array.isArray(entries)) throw new Error("Calendar response is not an array");

  return entries.map((e, i) => ({
    date:       e.date || dates[i],
    topicTitle: e.topicTitle || `Topic for ${dates[i]}`,
    script:     e.script || "",
    status:     "idea",
  }));
}

// ═══════════════════════════════════════════════════════
//  PUBLIC: Fetch ONE fresh, non-duplicate article + script
//  Used by the daily scheduler. Skips any article whose link
//  or title is already in `usedKeys`.
// ═══════════════════════════════════════════════════════
function normKey(s = "") {
  return String(s).trim().toLowerCase().replace(/\s+/g, " ");
}

async function fetchUniqueScript(rssFeeds, clientName = "", usedKeys = new Set(), perFeed = 8) {
  if (!rssFeeds || rssFeeds.length === 0) throw new Error("No RSS feeds configured for this client");

  const feedResults = await Promise.allSettled(
    rssFeeds.map(async (feed) => {
      const articles = await fetchTopArticles(feed.url, perFeed);
      return articles.map(a => ({ ...a, feedLabel: feed.label || feed.url, category: feed.category }));
    })
  );

  let all = [];
  feedResults.forEach(r => { if (r.status === "fulfilled") all.push(...r.value); });
  if (!all.length) throw new Error("No articles could be fetched from any RSS feed");

  // De-dupe within this batch (same link/title appearing in multiple feeds)
  const batchSeen = new Set();
  const candidates = [];
  for (const a of all) {
    const link = normKey(a.link || "");
    const title = normKey(a.title || "");
    const localKey = link || title;
    if (!localKey || batchSeen.has(localKey)) continue;
    batchSeen.add(localKey);
    // Skip anything already published for this client
    if ((link && usedKeys.has(link)) || (title && usedKeys.has(title))) continue;
    candidates.push(a);
  }

  if (!candidates.length) return null; // nothing new right now

  // Prefer the newest by pubDate when available
  candidates.sort((x, y) => {
    const dx = Date.parse(x.pubDate || "") || 0;
    const dy = Date.parse(y.pubDate || "") || 0;
    return dy - dx;
  });

  const article = candidates[0];
  const script = await generateOneScript(article, article.category, clientName);
  return { article, script, feedLabel: article.feedLabel, category: article.category };
}

module.exports = { fetchAndGenerateScripts, generateContentCalendar, fetchUniqueScript };