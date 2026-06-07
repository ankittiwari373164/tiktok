// youtubeApi.js — YouTube Data API v3 (OAuth2, per-client) upload + auth helpers
const fs = require("fs");
const { google } = require("googleapis");

const SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
];

function requireEnv() {
  const id     = process.env.YT_CLIENT_ID;
  const secret = process.env.YT_CLIENT_SECRET;
  const redirect = process.env.YT_REDIRECT_URI ||
    `http://localhost:${process.env.PORT || 3000}/api/youtube/oauth/callback`;
  if (!id || !secret) {
    throw new Error("YouTube OAuth is not configured. Set YT_CLIENT_ID and YT_CLIENT_SECRET in .env");
  }
  return { id, secret, redirect };
}

// Build an OAuth2 client (optionally pre-seeded with a refresh token)
function oauthClient(refreshToken) {
  const { id, secret, redirect } = requireEnv();
  const client = new google.auth.OAuth2(id, secret, redirect);
  if (refreshToken) client.setCredentials({ refresh_token: refreshToken });
  return client;
}

// URL the user visits to grant access. `state` carries the client id.
function getAuthUrl(state) {
  const client = oauthClient();
  return client.generateAuthUrl({
    access_type: "offline",     // get a refresh_token
    prompt: "consent",          // force refresh_token even on re-auth
    scope: SCOPES,
    state,
  });
}

// Exchange the ?code= for tokens; also fetch the channel name/id.
async function exchangeCode(code) {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  let channelName = "", channelId = "";
  try {
    const yt = google.youtube({ version: "v3", auth: client });
    const me = await yt.channels.list({ part: ["snippet"], mine: true });
    const ch = me.data.items?.[0];
    if (ch) { channelName = ch.snippet?.title || ""; channelId = ch.id || ""; }
  } catch {}

  return {
    refreshToken: tokens.refresh_token || null,
    channelName,
    channelId,
  };
}

/**
 * Upload a video via resumable upload.
 * @param {string} refreshToken  client's stored refresh token
 * @param {string} filePath      absolute path to the .mp4
 * @param {object} meta          { title, description, tags: string[] }
 * @param {object} opts          { categoryId?, onLog?(msg) }
 * @returns {Promise<{videoId, url}>}
 */
async function uploadVideo(refreshToken, filePath, meta, opts = {}) {
  const log = opts.onLog || (() => {});
  if (!refreshToken) throw new Error("Channel not connected (no refresh token). Reconnect YouTube.");
  if (!fs.existsSync(filePath)) throw new Error(`Video file not found: ${filePath}`);

  const auth = oauthClient(refreshToken);
  const youtube = google.youtube({ version: "v3", auth });

  const fileSize = fs.statSync(filePath).size;
  let lastPct = -1;

  log(`📤 Uploading to YouTube (${(fileSize / 1048576).toFixed(1)} MB)...`);

  const res = await youtube.videos.insert(
    {
      part: ["snippet", "status"],
      requestBody: {
        snippet: {
          title: meta.title,
          description: meta.description,
          tags: meta.tags || [],
          categoryId: opts.categoryId || "22", // 22 = People & Blogs
        },
        status: {
          privacyStatus: "public",
          selfDeclaredMadeForKids: false, // "No, it's not made for kids"
          madeForKids: false,
        },
      },
      media: { body: fs.createReadStream(filePath) },
    },
    {
      // Resumable upload progress
      onUploadProgress: (evt) => {
        const pct = Math.floor((evt.bytesRead / fileSize) * 100);
        if (pct !== lastPct && pct % 10 === 0) {
          lastPct = pct;
          log(`   …upload ${pct}% (${(evt.bytesRead / 1048576).toFixed(1)}/${(fileSize / 1048576).toFixed(1)} MB)`);
        }
      },
    }
  );

  const videoId = res.data.id;
  const url = `https://youtu.be/${videoId}`;
  log("✓ Upload complete — YouTube is now processing the video");
  log("ℹ Note: 'Show how many viewers like this video' is not settable via the API (stays at channel default).");
  return { videoId, url };
}

module.exports = { getAuthUrl, exchangeCode, uploadVideo, SCOPES };