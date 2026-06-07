// server.js
require("dotenv").config();

const express  = require("express");
const path     = require("path");
const fs       = require("fs");
const multer   = require("multer");

const { supabase }                               = require("./db");
const runBot                                     = require("./playwright/runBot");
const { fetchAndGenerateScripts, generateContentCalendar } = require("./rssGroq");
const { FEED_LIBRARY }                           = require("./feedLibrary");
const { applyBranding }                          = require("./branding");
const { getAuthUrl, exchangeCode, uploadVideo }  = require("./youtubeApi");
const { generateYouTubeMetadata }                = require("./youtubeMeta");
const scheduler                                  = require("./scheduler");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/downloads", express.static(path.join(__dirname, "downloads")));

// ─── Branding asset storage (per-client uploads) ──────────────────────────────
const BRANDING_DIR = path.join(__dirname, "branding_assets");
if (!fs.existsSync(BRANDING_DIR)) fs.mkdirSync(BRANDING_DIR, { recursive: true });
app.use("/branding_assets", express.static(BRANDING_DIR));

// Overlay image upload (PNG with transparent center — header + footer frame)
const overlayUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, BRANDING_DIR),
    filename:    (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${req.params.id}_overlay${ext}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
});

// Outro video upload
const outroUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, BRANDING_DIR),
    filename:    (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${req.params.id}_outro${ext}`);
    },
  }),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB
});

// ─── SSE log streams ──────────────────────────────────────────────────────────
const sseClients = {};
function sendLog(videoId, msg) {
  const listeners = sseClients[videoId] || [];
  const payload   = JSON.stringify({ time: new Date(), msg });
  listeners.forEach((res) => res.write(`data: ${payload}\n\n`));
}

// ─── Global activity log (server-wide, visible on dashboard) ──────────────────
const GLOBAL_LOG_MAX = 400;
const globalLogBuffer = [];   // [{ time, source, msg }]
const globalSseClients = [];  // open EventSource responses
function globalLog(msg, source = "system") {
  const entry = { time: new Date().toISOString(), source, msg };
  globalLogBuffer.push(entry);
  if (globalLogBuffer.length > GLOBAL_LOG_MAX) globalLogBuffer.shift();
  const payload = JSON.stringify(entry);
  globalSseClients.forEach((res) => { try { res.write(`data: ${payload}\n\n`); } catch {} });
}

// ═══════════════════════════════════════════════════════
//  HELPERS — map DB row ↔ API shape
// ═══════════════════════════════════════════════════════
function clientRow(row) {
  if (!row) return null;
  return {
    _id:             row.id,
    name:            row.name,
    avatarId:        row.avatar_id,
    script:          row.script || "",
    rssFeeds:        row.rss_feeds || [],
    contentCalendar: (row.content_calendar || []).map(calEntry),
    calendarGenAt:   row.calendar_gen_at,
    branding:        row.branding || {},
    youtube:         row.youtube || {},
    schedule:        row.schedule || {},
    createdAt:       row.created_at,
  };
}

function calEntry(e) {
  return {
    _id:        e.id || e._id,
    date:       e.date,
    topicTitle: e.topicTitle || e.topic_title || "",
    script:     e.script || "",
    status:     e.status || "idea",
    videoId:    e.videoId || e.video_id || null,
  };
}

function videoRow(row) {
  if (!row) return null;
  return {
    _id:        row.id,
    clientId:   row.client_id,
    clientName: row.client_name,
    fileName:   row.file_name,
    filePath:   row.file_path,
    status:     row.status,
    youtubeStatus: row.youtube_status || null,
    youtubeUrl:    row.youtube_url || null,
    log:        row.log || [],
    startedAt:  row.started_at,
    finishedAt: row.finished_at,
    createdAt:  row.created_at,
  };
}

// ─── Resolve branding asset paths for a client ────────────────────────────────
function resolveBrandingPaths(clientBranding = {}) {
  const result = {};

  if (clientBranding.overlayFile) {
    const p = path.join(BRANDING_DIR, clientBranding.overlayFile);
    if (fs.existsSync(p)) result.overlayPath = p;
  }
  if (clientBranding.outroFile) {
    const p = path.join(BRANDING_DIR, clientBranding.outroFile);
    if (fs.existsSync(p)) result.outroPath = p;
  }

  return result;
}

// ═══════════════════════════════════════════════════════
//  CLIENT ROUTES
// ═══════════════════════════════════════════════════════

// Strip secret tokens before sending a client to the browser
function sanitizeClientOut(c) {
  if (!c) return c;
  const yt = c.youtube || {};
  const { refreshToken, ...safeYt } = yt;
  return { ...c, youtube: { ...safeYt, connected: !!refreshToken } };
}

app.get("/api/clients", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("clients").select("*").order("created_at", { ascending: false });
    if (error) throw error;
    res.json(data.map(clientRow).map(sanitizeClientOut));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/clients/:id", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("clients").select("*").eq("id", req.params.id).single();
    if (error) return res.status(404).json({ error: "Not found" });
    res.json(sanitizeClientOut(clientRow(data)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/clients", async (req, res) => {
  try {
    const { name, avatarId, script, rssFeeds } = req.body;
    if (!name || !avatarId) return res.status(400).json({ error: "name and avatarId are required" });
    const { data, error } = await supabase.from("clients").insert({
      name, avatar_id: avatarId, script: script || "",
      rss_feeds: rssFeeds || [],
      branding: {},
    }).select().single();
    if (error) throw error;
    res.status(201).json(sanitizeClientOut(clientRow(data)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/api/clients/:id", async (req, res) => {
  try {
    const { name, avatarId, script, rssFeeds } = req.body;
    const { data, error } = await supabase.from("clients").update({
      name, avatar_id: avatarId, script, rss_feeds: rssFeeds,
    }).eq("id", req.params.id).select().single();
    if (error) throw error;
    res.json(sanitizeClientOut(clientRow(data)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/clients/:id", async (req, res) => {
  try {
    const { error } = await supabase.from("clients").delete().eq("id", req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════
//  BRANDING ROUTES (per-client)
// ═══════════════════════════════════════════════════════

// GET branding config
app.get("/api/clients/:id/branding", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("clients").select("branding").eq("id", req.params.id).single();
    if (error) return res.status(404).json({ error: "Not found" });
    res.json(data.branding || {});
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Upload full-frame overlay image (PNG with transparent center)
app.post("/api/clients/:id/branding/overlay",
  overlayUpload.single("overlay"),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });

      const { data: cur } = await supabase
        .from("clients").select("branding").eq("id", req.params.id).single();
      const branding = { ...(cur?.branding || {}), overlayFile: req.file.filename };

      const { error } = await supabase.from("clients")
        .update({ branding }).eq("id", req.params.id);
      if (error) throw error;

      res.json({ ok: true, overlayFile: req.file.filename, url: `/branding_assets/${req.file.filename}` });
    } catch (err) { res.status(500).json({ error: err.message }); }
  }
);

// Upload outro clip (MP4/MOV)
app.post("/api/clients/:id/branding/outro",
  outroUpload.single("outro"),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });

      const { data: cur } = await supabase
        .from("clients").select("branding").eq("id", req.params.id).single();
      const branding = { ...(cur?.branding || {}), outroFile: req.file.filename };

      const { error } = await supabase.from("clients")
        .update({ branding }).eq("id", req.params.id);
      if (error) throw error;

      res.json({ ok: true, outroFile: req.file.filename, url: `/branding_assets/${req.file.filename}` });
    } catch (err) { res.status(500).json({ error: err.message }); }
  }
);

// Delete a specific branding asset
app.delete("/api/clients/:id/branding/:field", async (req, res) => {
  try {
    const field = req.params.field; // "overlay" | "outro"
    const { data: cur } = await supabase
      .from("clients").select("branding").eq("id", req.params.id).single();
    const branding = { ...(cur?.branding || {}) };

    if (field === "overlay") {
      if (branding.overlayFile) {
        const fp = path.join(BRANDING_DIR, branding.overlayFile);
        try { fs.unlinkSync(fp); } catch {}
      }
      delete branding.overlayFile;
    } else if (field === "outro") {
      if (branding.outroFile) {
        const fp = path.join(BRANDING_DIR, branding.outroFile);
        try { fs.unlinkSync(fp); } catch {}
      }
      delete branding.outroFile;
    }

    const { error } = await supabase.from("clients")
      .update({ branding }).eq("id", req.params.id);
    if (error) throw error;

    res.json({ ok: true, branding });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════
//  YOUTUBE ROUTES (per-client OAuth + Data API v3)
// ═══════════════════════════════════════════════════════

// Helper: merge a partial youtube config into the client's youtube column
async function updateYoutubeConfig(clientId, patch) {
  const { data: cur, error: e1 } = await supabase
    .from("clients").select("youtube").eq("id", clientId).single();
  if (e1) throw e1;
  const youtube = { ...(cur?.youtube || {}), ...patch };
  const { error: e2 } = await supabase.from("clients").update({ youtube }).eq("id", clientId);
  if (e2) {
    if (String(e2.message).toLowerCase().includes("youtube") && String(e2.message).toLowerCase().includes("column")) {
      throw new Error("The 'youtube' column is missing. Run the migration SQL in Supabase (see YOUTUBE_SETUP.md).");
    }
    throw e2;
  }
  return youtube;
}

// Strip secrets before returning config to the browser
function publicYoutube(cfg = {}) {
  const { refreshToken, ...safe } = cfg;
  return { ...safe, connected: !!refreshToken };
}

// GET youtube config (no secrets)
app.get("/api/clients/:id/youtube", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("clients").select("youtube").eq("id", req.params.id).single();
    if (error) return res.status(404).json({ error: "Not found" });
    res.json(publicYoutube(data.youtube || {}));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Start OAuth: returns the Google consent URL (front-end opens it)
app.get("/api/clients/:id/youtube/auth", async (req, res) => {
  try {
    const url = getAuthUrl(req.params.id); // state = client id
    res.json({ url });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// OAuth callback: Google redirects here with ?code & ?state(=clientId)
app.get("/api/youtube/oauth/callback", async (req, res) => {
  const send = (title, body, ok) => res.send(`<!doctype html><meta charset=utf-8>
    <body style="font-family:system-ui;background:#0b0b0d;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
    <div style="text-align:center;max-width:420px">
      <div style="font-size:42px">${ok ? "✅" : "⚠️"}</div>
      <h2 style="color:${ok ? "#4ade80" : "#ff6b6b"}">${title}</h2>
      <p style="color:#aaa">${body}</p>
      <p style="color:#666;font-size:13px">You can close this tab and return to the dashboard.</p>
    </div><script>setTimeout(()=>window.close(),2500)</script>`);
  try {
    const { code, state, error } = req.query;
    if (error) return send("Authorization cancelled", String(error), false);
    if (!code || !state) return send("Missing code", "No authorization code returned.", false);

    const { refreshToken, channelName, channelId } = await exchangeCode(code);
    if (!refreshToken) {
      return send("No refresh token",
        "Google did not return a refresh token. Remove this app's access in your Google Account → Security → Third-party access, then connect again.", false);
    }

    await updateYoutubeConfig(state, { refreshToken, channelName, channelId, connected: true });
    send("YouTube connected", `Channel: <b>${channelName || channelId || "linked"}</b>`, true);
  } catch (err) {
    send("Connection failed", err.message, false);
  }
});

// Save youtube settings (auto-upload toggle, templates, default tags/hashtags)
app.put("/api/clients/:id/youtube", async (req, res) => {
  try {
    const { enabled, titleTemplate, descriptionTemplate, defaultHashtags, defaultTags, categoryId } = req.body;
    const patch = {};
    if (enabled             !== undefined) patch.enabled             = !!enabled;
    if (titleTemplate       !== undefined) patch.titleTemplate       = titleTemplate;
    if (descriptionTemplate !== undefined) patch.descriptionTemplate = descriptionTemplate;
    if (defaultHashtags     !== undefined) patch.defaultHashtags     = defaultHashtags;
    if (defaultTags         !== undefined) patch.defaultTags         = defaultTags;
    if (categoryId          !== undefined) patch.categoryId          = categoryId;
    const youtube = await updateYoutubeConfig(req.params.id, patch);
    res.json(publicYoutube(youtube));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Disconnect: clear stored tokens
app.delete("/api/clients/:id/youtube", async (req, res) => {
  try {
    const youtube = await updateYoutubeConfig(req.params.id, { refreshToken: null, connected: false, channelName: "", channelId: "" });
    res.json({ ok: true, youtube: publicYoutube(youtube) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Manually (re)upload an existing finished video to YouTube
app.post("/api/videos/:id/upload-youtube", async (req, res) => {
  try {
    const { data: vid, error } = await supabase
      .from("videos").select("*").eq("id", req.params.id).single();
    if (error) return res.status(404).json({ error: "Video not found" });
    if (vid.status !== "done" || !vid.file_path)
      return res.status(400).json({ error: "Video is not ready yet" });

    const { data: clientData, error: cErr } = await supabase
      .from("clients").select("*").eq("id", vid.client_id).single();
    if (cErr) return res.status(404).json({ error: "Client not found" });
    const client = clientRow(clientData);

    if (!client.youtube?.refreshToken)
      return res.status(400).json({ error: "This client's YouTube channel is not connected." });

    const diskPath = path.join(__dirname, "downloads", path.basename(vid.file_path));

    res.status(202).json({ ok: true, message: "YouTube upload started" });
    _uploadYouTubeAsync(client, vid.id, diskPath, client.script || "");
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════
//  SCHEDULE ROUTES (daily auto-pipeline)
// ═══════════════════════════════════════════════════════

app.get("/api/clients/:id/schedule", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("clients").select("schedule").eq("id", req.params.id).single();
    if (error) return res.status(404).json({ error: "Not found" });
    const schedule = data.schedule || {};
    res.json({ ...schedule, slots: scheduler.computeSlots(schedule) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/api/clients/:id/schedule", async (req, res) => {
  try {
    const { enabled, startHour, startMinute, count, gapHours, timezone } = req.body;
    const { data: cur, error: e1 } = await supabase
      .from("clients").select("schedule").eq("id", req.params.id).single();
    if (e1) throw e1;
    const schedule = { ...(cur?.schedule || {}) };
    if (enabled     !== undefined) schedule.enabled     = !!enabled;
    if (startHour   !== undefined) schedule.startHour   = Number(startHour);
    if (startMinute !== undefined) schedule.startMinute = Number(startMinute);
    if (count       !== undefined) schedule.count       = Number(count);
    if (gapHours    !== undefined) schedule.gapHours    = Number(gapHours);
    if (timezone    !== undefined) schedule.timezone    = timezone;

    const { error: e2 } = await supabase.from("clients").update({ schedule }).eq("id", req.params.id);
    if (e2) {
      if (String(e2.message).toLowerCase().includes("schedule") && String(e2.message).toLowerCase().includes("column"))
        return res.status(400).json({ error: "The 'schedule' column is missing. Run the migration SQL in YOUTUBE_SETUP.md." });
      throw e2;
    }

    // (re)register cron jobs immediately
    const slots = scheduler.scheduleClient(req.params.id, schedule);
    res.json({ ...schedule, slots });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Trigger one scheduled-style run immediately (manual test of the pipeline)
app.post("/api/clients/:id/schedule/run-now", async (req, res) => {
  res.status(202).json({ ok: true, message: "Running one unique video now" });
  scheduler.runScheduledVideo(req.params.id);
});

// ═══════════════════════════════════════════════════════
//  VIDEO ROUTES
// ═══════════════════════════════════════════════════════

app.get("/api/videos", async (req, res) => {
  try {
    let query = supabase.from("videos").select("*").order("created_at", { ascending: false });
    if (req.query.clientId) query = query.eq("client_id", req.query.clientId);
    const { data, error } = await query;
    if (error) throw error;
    res.json(data.map(videoRow));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/videos/:id", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("videos").select("*").eq("id", req.params.id).single();
    if (error) return res.status(404).json({ error: "Not found" });
    res.json(videoRow(data));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════
//  MANUAL RUN
// ═══════════════════════════════════════════════════════

app.post("/api/clients/:id/run", async (req, res) => {
  try {
    const { data: clientData, error: cErr } = await supabase
      .from("clients").select("*").eq("id", req.params.id).single();
    if (cErr) return res.status(404).json({ error: "Client not found" });
    const client = clientRow(clientData);
    if (!client.script) return res.status(400).json({ error: "No script set for this client" });

    const { data: vidData, error: vErr } = await supabase.from("videos").insert({
      client_id: client._id, client_name: client.name,
      status: "running", started_at: new Date(),
      log: [{ time: new Date(), msg: `Manual run started for ${client.name}` }],
    }).select().single();
    if (vErr) throw vErr;

    res.status(202).json({ videoId: vidData.id, message: "Bot started" });
    _runBotAsync(client, vidData.id);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════
//  RSS PREVIEW
// ═══════════════════════════════════════════════════════

app.post("/api/clients/:id/rss-preview", async (req, res) => {
  try {
    const { data: clientData, error: clientErr } = await supabase
      .from("clients").select("*").eq("id", req.params.id).single();

    if (clientErr) {
      console.error("Supabase fetch error:", JSON.stringify(clientErr));
      const isRLS = clientErr.code === "42501" || String(clientErr.message).toLowerCase().includes("access") || String(clientErr.message).toLowerCase().includes("denied");
      if (isRLS) {
        return res.status(403).json({
          error: "Supabase Row Level Security is blocking access.\n\nFix: Go to Supabase → SQL Editor and run:\n\nALTER TABLE clients DISABLE ROW LEVEL SECURITY;\nALTER TABLE videos DISABLE ROW LEVEL SECURITY;"
        });
      }
      return res.status(404).json({ error: "Client not found: " + clientErr.message });
    }

    const client = clientRow(clientData);

    if (!client.rssFeeds?.length)
      return res.status(400).json({ error: "No RSS feeds configured. Edit the client to add feeds." });

    if (!process.env.GROQ_API_KEY)
      return res.status(500).json({ error: "GROQ_API_KEY is not set in .env" });

    const previews = await fetchAndGenerateScripts(client.rssFeeds, client.name);
    res.json({ previews });

  } catch (err) {
    console.error("rss-preview error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════
//  RSS RUN
// ═══════════════════════════════════════════════════════

app.post("/api/clients/:id/rss-run", async (req, res) => {
  try {
    const { script, articleTitle, articleLink } = req.body;
    if (!script) return res.status(400).json({ error: "script is required" });

    const { data: clientData, error } = await supabase
      .from("clients").select("*").eq("id", req.params.id).single();
    if (error) return res.status(404).json({ error: "Client not found" });

    await supabase.from("clients").update({ script }).eq("id", req.params.id);
    const client = clientRow({ ...clientData, script });

    const baseLog = [
      { time: new Date(), msg: `RSS Auto-Run started for ${client.name}` },
      { time: new Date(), msg: `📰 Article: "${articleTitle || "selected article"}"` },
      { time: new Date(), msg: `✓ Script saved (${script.split(" ").length} words)` },
      { time: new Date(), msg: "🚀 Launching Playwright bot..." },
    ];
    let vidData;
    try {
      const r = await supabase.from("videos").insert({
        client_id: client._id, client_name: client.name,
        status: "running", started_at: new Date(), log: baseLog,
        article_link: articleLink || "", article_title: articleTitle || "",
      }).select().single();
      if (r.error) throw r.error;
      vidData = r.data;
    } catch {
      const r = await supabase.from("videos").insert({
        client_id: client._id, client_name: client.name,
        status: "running", started_at: new Date(), log: baseLog,
      }).select().single();
      if (r.error) throw r.error;
      vidData = r.data;
    }

    res.status(202).json({ videoId: vidData.id, message: "RSS bot started" });
    _runBotAsync(client, vidData.id);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════
//  CONTENT CALENDAR
// ═══════════════════════════════════════════════════════

app.post("/api/clients/:id/calendar/generate", async (req, res) => {
  try {
    if (!process.env.GROQ_API_KEY)
      return res.status(500).json({ error: "GROQ_API_KEY is not set in .env" });

    const { data: clientData, error } = await supabase
      .from("clients").select("*").eq("id", req.params.id).single();
    if (error) return res.status(404).json({ error: "Client not found" });
    const client = clientRow(clientData);

    const entries = await generateContentCalendar(client);

    const withIds = entries.map((e, i) => ({
      ...e,
      id: `cal-${Date.now()}-${i}`,
    }));

    const { data: updated, error: uErr } = await supabase.from("clients")
      .update({ content_calendar: withIds, calendar_gen_at: new Date() })
      .eq("id", req.params.id).select().single();
    if (uErr) throw uErr;

    res.json({ calendar: clientRow(updated).contentCalendar, generatedAt: updated.calendar_gen_at });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/clients/:id/calendar", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("clients").select("content_calendar, calendar_gen_at").eq("id", req.params.id).single();
    if (error) return res.status(404).json({ error: "Not found" });
    res.json({
      calendar: (data.content_calendar || []).map(calEntry),
      generatedAt: data.calendar_gen_at,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch("/api/clients/:id/calendar/:entryId", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("clients").select("content_calendar").eq("id", req.params.id).single();
    if (error) return res.status(404).json({ error: "Not found" });

    const calendar = data.content_calendar || [];
    const idx = calendar.findIndex(e => String(e.id || e._id) === String(req.params.entryId));
    if (idx === -1) return res.status(404).json({ error: "Entry not found" });

    const { script, topicTitle, status } = req.body;
    if (script     !== undefined) calendar[idx].script     = script;
    if (topicTitle !== undefined) calendar[idx].topicTitle = topicTitle;
    if (status     !== undefined) calendar[idx].status     = status;

    const { error: uErr } = await supabase
      .from("clients").update({ content_calendar: calendar }).eq("id", req.params.id);
    if (uErr) throw uErr;

    res.json({ entry: calEntry(calendar[idx]) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/clients/:id/calendar/:entryId/run", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("clients").select("*").eq("id", req.params.id).single();
    if (error) return res.status(404).json({ error: "Client not found" });

    const calendar = data.content_calendar || [];
    const idx = calendar.findIndex(e => String(e.id || e._id) === String(req.params.entryId));
    if (idx === -1) return res.status(404).json({ error: "Calendar entry not found" });

    const entry = calendar[idx];
    if (!entry.script) return res.status(400).json({ error: "This calendar entry has no script" });

    calendar[idx].status = "used";
    await supabase.from("clients")
      .update({ script: entry.script, content_calendar: calendar })
      .eq("id", req.params.id);

    const client = clientRow({ ...data, script: entry.script });

    const { data: vidData, error: vErr } = await supabase.from("videos").insert({
      client_id: client._id, client_name: client.name,
      status: "running", started_at: new Date(),
      log: [
        { time: new Date(), msg: `📅 Calendar run: "${entry.topicTitle}"` },
        { time: new Date(), msg: "🚀 Launching Playwright bot..." },
      ],
    }).select().single();
    if (vErr) throw vErr;

    res.status(202).json({ videoId: vidData.id });
    _runBotAsync(client, vidData.id);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════
//  FEED LIBRARY
// ═══════════════════════════════════════════════════════

app.get("/api/feed-library", (req, res) => res.json(FEED_LIBRARY));

// ═══════════════════════════════════════════════════════
//  SHARED BOT RUNNER — with branding post-processing
// ═══════════════════════════════════════════════════════

async function _runBotAsync(client, videoId) {
  const logAndSave = async (msg) => {
    sendLog(videoId, msg);
    globalLog(msg, client.name || "run");
    const { data } = await supabase.from("videos").select("log").eq("id", videoId).single();
    const log = [...(data?.log || []), { time: new Date(), msg }];
    await supabase.from("videos").update({ log }).eq("id", videoId);
  };

  try {
    // 1. Run the Playwright bot → raw video file
    const rawFilePath = await runBot(client, logAndSave);

    // 2. Apply branding (overlay image + outro)
    const brandingConfig = resolveBrandingPaths(client.branding || {});
    const hasAnyBranding = Object.keys(brandingConfig).length > 0;

    let finalFilePath = rawFilePath;
    if (hasAnyBranding) {
      await logAndSave("🎨 Applying branding (frame overlay / outro)...");
      try {
        finalFilePath = await applyBranding(rawFilePath, brandingConfig, logAndSave);
        // Clean up raw file if branding created a new file
        if (finalFilePath !== rawFilePath && fs.existsSync(rawFilePath)) {
          try { fs.unlinkSync(rawFilePath); } catch {}
        }
      } catch (brandErr) {
        await logAndSave(`⚠ Branding failed: ${brandErr.message} — using raw video`);
        finalFilePath = rawFilePath;
      }
    }

    const fileName = path.basename(finalFilePath);
    await supabase.from("videos").update({
      status: "done",
      file_path: `/downloads/${fileName}`,
      file_name: fileName,
      finished_at: new Date(),
      log: await appendLog(videoId, "✓ Video ready"),
    }).eq("id", videoId);
    sendLog(videoId, "✓ DONE");

    // 3. Auto-upload to YouTube (if connected + enabled for this client)
    const yt = client.youtube || {};
    if (yt.enabled && yt.refreshToken) {
      await logAndSave("📤 Auto-uploading to YouTube...");
      await _uploadYouTubeAsync(client, videoId, finalFilePath, client.script || "");
    } else if (yt.enabled && !yt.refreshToken) {
      await logAndSave("⚠ YouTube auto-upload skipped — channel not connected");
    }
  } catch (err) {
    await supabase.from("videos").update({
      status: "failed",
      finished_at: new Date(),
      log: await appendLog(videoId, `✗ FAILED: ${err.message}`),
    }).eq("id", videoId);
    sendLog(videoId, `✗ FAILED: ${err.message}`);
  }
}

async function appendLog(videoId, msg) {
  const { data } = await supabase.from("videos").select("log").eq("id", videoId).single();
  return [...(data?.log || []), { time: new Date(), msg }];
}

// ═══════════════════════════════════════════════════════
//  YOUTUBE UPLOAD RUNNER (shared by auto + manual)
// ═══════════════════════════════════════════════════════
async function _uploadYouTubeAsync(client, videoId, filePath, script) {
  const logAndSave = async (msg) => {
    sendLog(videoId, msg);
    globalLog(msg, `${client.name || "youtube"} ▶`);
    const { data } = await supabase.from("videos").select("log").eq("id", videoId).single();
    const log = [...(data?.log || []), { time: new Date(), msg }];
    await supabase.from("videos").update({ log }).eq("id", videoId);
  };

  // Best-effort: persist youtube_status (column may not exist on older schemas)
  const setYtStatus = async (fields) => {
    try { await supabase.from("videos").update(fields).eq("id", videoId); } catch {}
  };

  try {
    await setYtStatus({ youtube_status: "uploading" });
    await logAndSave("🧠 Generating YouTube title / description / tags via Groq...");
    const meta = await generateYouTubeMetadata(script, client);
    await logAndSave(`  → Title: ${meta.title}`);
    await logAndSave(`  → ${meta.hashtags.length} hashtags, ${meta.tags.length} tags`);

    const { url } = await uploadVideo(
      client.youtube.refreshToken,
      filePath,
      meta,
      { categoryId: client.youtube.categoryId || "22", onLog: (m) => logAndSave(m) }
    );

    await setYtStatus({ youtube_status: "published", youtube_url: url || null });
    await logAndSave(url ? `✅ YouTube: ${url}` : "✅ Published to YouTube");
    sendLog(videoId, "__DONE__");
  } catch (err) {
    await setYtStatus({ youtube_status: "failed" });
    await logAndSave(`✗ YouTube upload failed: ${err.message}`);
    sendLog(videoId, "__DONE__");
  }
}

// ═══════════════════════════════════════════════════════
//  SSE LOGS
// ═══════════════════════════════════════════════════════

// Recent global activity (snapshot)
app.get("/api/logs/recent", (req, res) => {
  res.json(globalLogBuffer);
});

// Global activity stream (all server-side activity, incl. scheduler)
app.get("/api/logs/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  // replay recent buffer so the panel isn't empty on connect
  globalLogBuffer.slice(-100).forEach((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
  globalSseClients.push(res);
  const keepAlive = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 25000);
  req.on("close", () => {
    clearInterval(keepAlive);
    const i = globalSseClients.indexOf(res);
    if (i !== -1) globalSseClients.splice(i, 1);
  });
});

app.get("/api/videos/:id/logs", async (req, res) => {
  const videoId = req.params.id;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  try {
    const { data } = await supabase.from("videos").select("*").eq("id", videoId).single();
    if (data) {
      (data.log || []).forEach(e => res.write(`data: ${JSON.stringify(e)}\n\n`));
      if (data.status === "done" || data.status === "failed") {
        res.write(`data: ${JSON.stringify({ msg: "__DONE__" })}\n\n`);
        return res.end();
      }
    }
  } catch {}

  if (!sseClients[videoId]) sseClients[videoId] = [];
  sseClients[videoId].push(res);
  req.on("close", () => {
    sseClients[videoId] = (sseClients[videoId] || []).filter(r => r !== res);
  });
});

// ─── Start scheduler (daily auto-pipeline) ────────────────────────────────────
scheduler.init(_runBotAsync, clientRow, globalLog);

app.listen(PORT, () => {
  console.log(`✓ Dashboard running → http://localhost:${PORT}`);
  scheduler.registerAll(); // register cron jobs for all clients with scheduling on
});