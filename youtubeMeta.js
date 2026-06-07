// youtubeMeta.js — generate YouTube title/description/hashtags/tags from a script via Groq
const Groq = require("groq-sdk");

function groqClient() {
  if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY is not set in .env");
  return new Groq({ apiKey: process.env.GROQ_API_KEY });
}

function clampTags(tags, maxTotalChars = 480) {
  // YouTube limits the tags field to 500 characters total. Keep a safe margin.
  const out = [];
  let total = 0;
  for (const raw of tags) {
    const t = String(raw || "").trim().replace(/^#/, "");
    if (!t) continue;
    const add = (out.length ? 1 : 0) + t.length; // comma + tag
    if (total + add > maxTotalChars) break;
    out.push(t);
    total += add;
  }
  return out;
}

function normHashtags(list) {
  return [...new Set(
    (list || [])
      .map(h => String(h || "").trim())
      .filter(Boolean)
      .map(h => (h.startsWith("#") ? h : "#" + h))
      .map(h => h.replace(/\s+/g, ""))
  )];
}

/**
 * Generate metadata for a YouTube upload.
 * @param {string} script        The spoken avatar script.
 * @param {object} client        Client object ({ name, youtube: { titleTemplate, descriptionTemplate, defaultHashtags, defaultTags } })
 * @param {string} topicTitle    Optional topic hint (from calendar / RSS article).
 */
async function generateYouTubeMetadata(script, client = {}, topicTitle = "") {
  const yt = client.youtube || {};
  const groq = groqClient();

  const system = `You are a YouTube Shorts SEO expert.
Given a short-form video script, produce optimized upload metadata.
Output ONLY a valid JSON object — no markdown, no backticks, no commentary.
Exact keys:
  "title": string, max 90 characters, punchy, click-worthy, no surrounding quotes, no emojis spam (1 emoji max, optional)
  "description": string, 2-4 sentences summarizing the video with a soft call-to-action (subscribe / comment). Do NOT put hashtags in here.
  "hashtags": array of 4-6 short relevant hashtags WITHOUT the # symbol (e.g. "news", "ai", "shorts")
  "tags": array of 12-18 SEO keyword phrases (1-3 words each, no #), ordered most→least relevant`;

  const user = `Channel/brand: ${client.name || "the channel"}
${topicTitle ? `Topic: ${topicTitle}` : ""}

Video script:
"""${script}"""

Generate the JSON metadata now.`;

  const completion = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    temperature: 0.7,
    max_tokens: 800,
  });

  const raw = completion.choices[0]?.message?.content?.trim() || "{}";
  const cleaned = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();

  let meta;
  try { meta = JSON.parse(cleaned); }
  catch { throw new Error("Groq returned invalid JSON for YouTube metadata"); }

  // ─── Title ────────────────────────────────────────────────
  let title = (meta.title || topicTitle || `${client.name || "New"} video`).trim();
  if (yt.titleTemplate) {
    title = yt.titleTemplate
      .replace(/\{title\}/gi, title)
      .replace(/\{topic\}/gi, topicTitle || title)
      .replace(/\{client\}/gi, client.name || "");
  }
  title = title.slice(0, 100); // YouTube hard limit

  // ─── Hashtags (AI + client defaults) ──────────────────────
  const hashtags = normHashtags([
    ...(meta.hashtags || []),
    ...(yt.defaultHashtags || []),
  ]).slice(0, 8); // YouTube only shows first 3 above title; keep a sensible cap

  // ─── Description (AI body + template + hashtags appended) ──
  let body = (meta.description || "").trim();
  if (yt.descriptionTemplate) {
    body = yt.descriptionTemplate
      .replace(/\{description\}/gi, body)
      .replace(/\{title\}/gi, title)
      .replace(/\{client\}/gi, client.name || "");
  }
  const description = [body, "", hashtags.join(" ")].join("\n").trim().slice(0, 4900); // 5000 limit

  // ─── Tags (AI + client defaults, char-limited) ────────────
  const tags = clampTags([
    ...(meta.tags || []),
    ...(yt.defaultTags || []),
    ...hashtags.map(h => h.replace(/^#/, "")),
  ]);

  return { title, description, hashtags, tags };
}

module.exports = { generateYouTubeMetadata };