// runOnce.js — generate + upload ONE unique video for each scheduled client, then exit.
// Designed for GitHub Actions (cron) so no server/PC is needed.
//
//   node runOnce.js            → process every client with schedule.enabled
//   node runOnce.js <clientId> → process just that client
//
// Reuses the same pipeline as the dashboard: unique article → bot → branding → YouTube.
require("dotenv").config();
const fs = require("fs");
const path = require("path");

const { supabase } = require("./db");
const runBot = require("./playwright/runBot");
const { applyBranding } = require("./branding");
const { fetchUniqueScript } = require("./rssGroq");
const { generateYouTubeMetadata } = require("./youtubeMeta");
const { uploadVideo } = require("./youtubeApi");

const BRANDING_DIR = path.join(__dirname, "branding_assets");
const log = (m) => console.log(`[runOnce] ${m}`);

function clientRow(row) {
  if (!row) return null;
  return {
    _id: row.id, name: row.name, avatarId: row.avatar_id,
    script: row.script || "", rssFeeds: row.rss_feeds || [],
    branding: row.branding || {}, youtube: row.youtube || {},
    schedule: row.schedule || {},
  };
}

function resolveBrandingPaths(b = {}) {
  const r = {};
  if (b.overlayFile) { const p = path.join(BRANDING_DIR, b.overlayFile); if (fs.existsSync(p)) r.overlayPath = p; }
  if (b.outroFile)   { const p = path.join(BRANDING_DIR, b.outroFile);   if (fs.existsSync(p)) r.outroPath = p; }
  return r;
}

async function usedKeysFor(clientId) {
  const keys = new Set();
  try {
    const { data } = await supabase.from("videos")
      .select("article_link, article_title").eq("client_id", clientId);
    (data || []).forEach((v) => {
      if (v.article_link)  keys.add(String(v.article_link).trim().toLowerCase());
      if (v.article_title) keys.add(String(v.article_title).trim().toLowerCase());
    });
  } catch {}
  return keys;
}

async function appendLog(videoId, msg) {
  const { data } = await supabase.from("videos").select("log").eq("id", videoId).single();
  return [...(data?.log || []), { time: new Date(), msg }];
}

async function processClient(row) {
  const client = clientRow(row);
  const tag = client.name;

  if (!client.rssFeeds.length) { log(`${tag}: no RSS feeds — skip`); return; }
  if (!client.avatarId)        { log(`${tag}: no Avatar ID — skip`); return; }

  log(`${tag}: picking a fresh, non-duplicate article...`);
  const used = await usedKeysFor(client._id);
  const pick = await fetchUniqueScript(client.rssFeeds, client.name, used);
  if (!pick)                                { log(`${tag}: no NEW article available — skip (avoids duplicate)`); return; }
  if (!pick.script || !pick.script.trim())  { log(`${tag}: empty script from Groq — skip`); return; }

  client.script = pick.script;
  const articleLink  = pick.article.link || "";
  const articleTitle = pick.article.title || "";
  log(`${tag}: article "${articleTitle}"`);

  try { await supabase.from("clients").update({ script: pick.script }).eq("id", client._id); } catch {}

  // create the video row
  const insert = {
    client_id: client._id, client_name: client.name,
    status: "running", started_at: new Date(),
    log: [
      { time: new Date(), msg: `⏰ Scheduled (GitHub Actions) run for ${client.name}` },
      { time: new Date(), msg: `📰 Article: "${articleTitle}"` },
      { time: new Date(), msg: "🚀 Launching bot..." },
    ],
  };
  let vid;
  try {
    const r = await supabase.from("videos")
      .insert({ ...insert, article_link: articleLink, article_title: articleTitle }).select().single();
    if (r.error) throw r.error; vid = r.data;
  } catch {
    const r = await supabase.from("videos").insert(insert).select().single();
    if (r.error) throw r.error; vid = r.data;
  }
  const videoId = vid.id;

  const save = async (msg) => {
    log(`${tag}: ${msg}`);
    try { await supabase.from("videos").update({ log: await appendLog(videoId, msg) }).eq("id", videoId); } catch {}
  };

  try {
    // 1. bot → raw file
    const rawFilePath = await runBot(client, save);

    // 2. branding
    const brandingConfig = resolveBrandingPaths(client.branding || {});
    let finalFilePath = rawFilePath;
    if (Object.keys(brandingConfig).length) {
      await save("🎨 Applying branding...");
      try {
        finalFilePath = await applyBranding(rawFilePath, brandingConfig, save);
        if (finalFilePath !== rawFilePath && fs.existsSync(rawFilePath)) { try { fs.unlinkSync(rawFilePath); } catch {} }
      } catch (e) { await save(`⚠ Branding failed: ${e.message} — using raw video`); finalFilePath = rawFilePath; }
    }

    const fileName = path.basename(finalFilePath);
    await supabase.from("videos").update({
      status: "done", file_path: `/downloads/${fileName}`, file_name: fileName,
      finished_at: new Date(), log: await appendLog(videoId, "✓ Video ready"),
    }).eq("id", videoId);

    // 3. YouTube upload
    const yt = client.youtube || {};
    if (yt.refreshToken) {
      try {
        await save("🧠 Generating YouTube metadata...");
        const meta = await generateYouTubeMetadata(client.script, client);
        await save(`▶ Uploading "${meta.title}" to YouTube...`);
        const { url } = await uploadVideo(yt.refreshToken, finalFilePath, meta,
          { categoryId: yt.categoryId || "22", onLog: save });
        try { await supabase.from("videos").update({ youtube_status: "published", youtube_url: url || null }).eq("id", videoId); } catch {}
        await save(url ? `✅ YouTube: ${url}` : "✅ Published to YouTube");
      } catch (e) {
        try { await supabase.from("videos").update({ youtube_status: "failed" }).eq("id", videoId); } catch {}
        await save(`✗ YouTube upload failed: ${e.message}`);
      }
    } else {
      await save("⚠ YouTube not connected for this client — video generated but not uploaded");
    }
  } catch (err) {
    await supabase.from("videos").update({
      status: "failed", finished_at: new Date(), log: await appendLog(videoId, `✗ FAILED: ${err.message}`),
    }).eq("id", videoId);
    log(`${tag}: ✗ FAILED — ${err.message}`);
  }
}

async function main() {
  const targetId = process.argv[2];
  let clients;
  if (targetId) {
    const { data, error } = await supabase.from("clients").select("*").eq("id", targetId).single();
    if (error || !data) { log(`client ${targetId} not found`); process.exit(1); }
    clients = [data];
  } else {
    const { data, error } = await supabase.from("clients").select("*");
    if (error) { log(`could not load clients: ${error.message}`); process.exit(1); }
    clients = (data || []).filter((c) => c.schedule && c.schedule.enabled);
  }

  if (!clients.length) { log("no scheduled clients to run"); process.exit(0); }
  log(`processing ${clients.length} client(s) one at a time...`);

  // strictly serial — never two browsers at once
  for (const row of clients) {
    try { await processClient(row); }
    catch (e) { log(`run failed for ${row.id}: ${e.message}`); }
  }

  log("all done");
  process.exit(0);
}

main().catch((e) => { console.error("[runOnce] fatal:", e); process.exit(1); });