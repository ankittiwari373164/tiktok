// scheduler.js — daily auto-pipeline: fetch unique article → script → bot → YouTube
// Runs N videos/day per client at a custom start time, spaced by a fixed gap.
const cron = require("node-cron");
const { supabase } = require("./db");
const { fetchUniqueScript } = require("./rssGroq");

let runBotAsync = null;        // injected from server.js (avoids circular require)
let mapClient = (r) => r;      // canonical clientRow mapper, injected from server.js
let activityLog = () => {};    // global dashboard logger, injected from server.js
const jobs = new Map();        // clientId -> [cron tasks]

function init(runBotFn, mapClientFn, activityLogFn) {
  runBotAsync = runBotFn;
  if (typeof mapClientFn === "function") mapClient = mapClientFn;
  if (typeof activityLogFn === "function") activityLog = activityLogFn;
}

// log to both the server console and the dashboard activity feed
function slog(msg) { console.log(`[scheduler] ${msg}`); activityLog(msg, "scheduler"); }

// Build the list of {hour,minute} slots from a schedule config.
function computeSlots(s = {}) {
  const count = Math.max(1, Math.min(24, s.count || 5));
  const gap   = Math.max(1, s.gapHours || 3);
  const startH = Number.isInteger(s.startHour)   ? s.startHour   : 9;
  const startM = Number.isInteger(s.startMinute) ? s.startMinute : 0;
  const slots = [];
  for (let i = 0; i < count; i++) {
    const total = startH * 60 + startM + i * gap * 60;
    slots.push({ hour: Math.floor(total / 60) % 24, minute: total % 60 });
  }
  return slots;
}

// Set of already-used article keys (links + titles) for a client.
async function usedKeysFor(clientId) {
  const keys = new Set();
  try {
    const { data } = await supabase
      .from("videos")
      .select("article_link, article_title")
      .eq("client_id", clientId);
    (data || []).forEach((v) => {
      if (v.article_link)  keys.add(String(v.article_link).trim().toLowerCase());
      if (v.article_title) keys.add(String(v.article_title).trim().toLowerCase());
    });
  } catch (e) {
    console.log(`[scheduler] could not load used articles (${e.message}) — article_link/title columns may be missing`);
  }
  return keys;
}

// Run one scheduled video for a client (called when a slot fires).
async function runScheduledVideo(clientId) {
  if (!runBotAsync) return;
  try {
    const { data: row, error } = await supabase
      .from("clients").select("*").eq("id", clientId).single();
    if (error || !row) return;

    const client = mapClient(row);  // includes avatarId, script, branding, youtube, etc.
    if (!client) return;

    if (!client.rssFeeds.length) { slog(`${client.name}: no RSS feeds, skipping`); return; }
    if (!client.avatarId) { slog(`${client.name}: no Avatar ID set — skipping (set it in Edit client)`); return; }

    slog(`${client.name}: picking a fresh article...`);
    const used = await usedKeysFor(clientId);
    const pick = await fetchUniqueScript(client.rssFeeds, client.name, used);

    if (!pick) { slog(`${client.name}: no NEW article available right now — skipped (avoids duplicate)`); return; }
    if (!pick.script || !pick.script.trim()) { slog(`${client.name}: Groq returned an empty script — skipped`); return; }

    const articleLink  = pick.article.link || "";
    const articleTitle = pick.article.title || "";
    client.script = pick.script;

    // Persist latest script on the client (keeps manual UI consistent)
    try { await supabase.from("clients").update({ script: pick.script }).eq("id", clientId); } catch {}

    const insert = {
      client_id: client._id, client_name: client.name,
      status: "running", started_at: new Date(),
      log: [
        { time: new Date(), msg: `⏰ Scheduled run for ${client.name}` },
        { time: new Date(), msg: `📰 Article: "${articleTitle}"` },
        { time: new Date(), msg: `✓ Unique article (not previously used)` },
        { time: new Date(), msg: "🚀 Launching bot..." },
      ],
    };
    // article_link/title are best-effort (columns may not exist on old schemas)
    let vidData;
    try {
      const r = await supabase.from("videos")
        .insert({ ...insert, article_link: articleLink, article_title: articleTitle })
        .select().single();
      if (r.error) throw r.error;
      vidData = r.data;
    } catch {
      const r = await supabase.from("videos").insert(insert).select().single();
      if (r.error) throw r.error;
      vidData = r.data;
    }

    slog(`${client.name}: ✓ unique article picked → launching bot (auto-uploads to YouTube when done)`);
    runBotAsync(client, vidData.id); // auto-uploads to YouTube inside _runBotAsync
  } catch (e) {
    slog(`run failed for ${clientId}: ${e.message}`);
  }
}

// (Re)register cron tasks for a single client based on its schedule config.
function scheduleClient(clientId, schedule, timezoneFallback) {
  // clear existing
  (jobs.get(clientId) || []).forEach((t) => t.stop());
  jobs.delete(clientId);

  if (!schedule || !schedule.enabled) return [];

  const tz = schedule.timezone || timezoneFallback || process.env.SCHEDULE_TZ || "UTC";
  const slots = computeSlots(schedule);
  const tasks = slots.map(({ hour, minute }) => {
    const expr = `${minute} ${hour} * * *`; // every day at HH:MM
    return cron.schedule(expr, () => runScheduledVideo(clientId), { timezone: tz });
  });
  jobs.set(clientId, tasks);

  const human = slots.map((s) => `${String(s.hour).padStart(2, "0")}:${String(s.minute).padStart(2, "0")}`).join(", ");
  slog(`${clientId}: ${slots.length} slots/day @ ${human} (${tz})`);
  return slots;
}

// Load every client and register schedules (called at boot).
async function registerAll() {
  try {
    const { data, error } = await supabase.from("clients").select("id, schedule");
    if (error) {
      if (String(error.message).toLowerCase().includes("schedule"))
        console.log("[scheduler] 'schedule' column missing — run the migration in YOUTUBE_SETUP.md");
      else console.log(`[scheduler] could not load clients: ${error.message}`);
      return;
    }
    let n = 0;
    (data || []).forEach((c) => { if (c.schedule?.enabled) { scheduleClient(c.id, c.schedule); n++; } });
    slog(`registered schedules for ${n} client(s)`);
  } catch (e) {
    console.log(`[scheduler] registerAll error: ${e.message}`);
  }
}

module.exports = { init, registerAll, scheduleClient, computeSlots, runScheduledVideo };