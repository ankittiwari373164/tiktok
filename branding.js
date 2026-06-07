// branding.js — FFmpeg post-processing: full-frame overlay image + outro append
const { execFile } = require("child_process");
const fs   = require("fs");
const path = require("path");
const util = require("util");

const execFileAsync = util.promisify(execFile);

/**
 * Apply branding to a video file:
 *  1. Overlay a full-frame PNG (header + footer frame with transparent center)
 *     scaled to match video dimensions and composited on top of the avatar video.
 *  2. Append outro clip (if provided).
 *
 * @param {string} inputPath   - absolute path to the raw downloaded video
 * @param {object} branding    - { overlayPath, outroPath }
 * @param {Function} log       - logging callback
 * @returns {string}           - absolute path to the branded output file
 */
async function applyBranding(inputPath, branding = {}, log = () => {}) {
  const { overlayPath, outroPath } = branding;

  const hasOverlay = overlayPath && fs.existsSync(overlayPath);
  const hasOutro   = outroPath   && fs.existsSync(outroPath);

  if (!hasOverlay && !hasOutro) {
    log("No branding configured — skipping post-processing");
    return inputPath;
  }

  log(`Applying branding: overlay=${hasOverlay}, outro=${hasOutro}`);

  const dir     = path.dirname(inputPath);
  const base    = path.basename(inputPath, path.extname(inputPath));
  const branded = path.join(dir, `${base}_branded.mp4`);
  const concat  = path.join(dir, `${base}_concat.txt`);

  // ── Step 1: composite full-frame overlay PNG onto video ───────────────────
  let step1Output = inputPath;

  if (hasOverlay) {
    step1Output = path.join(dir, `${base}_step1.mp4`);

    // Probe input video dimensions
    const probeArgs = [
      "-v", "quiet",
      "-print_format", "json",
      "-show_streams",
      inputPath,
    ];
    let videoW = 1080, videoH = 1920; // TikTok/portrait default
    try {
      const { stdout } = await execFileAsync("ffprobe", probeArgs);
      const info = JSON.parse(stdout);
      const vs = info.streams?.find(s => s.codec_type === "video");
      if (vs) { videoW = vs.width; videoH = vs.height; }
    } catch { log("ffprobe failed — assuming 1080x1920"); }

    log(`Video dimensions: ${videoW}x${videoH}`);

    // Scale the overlay PNG to exactly match the video frame, then composite.
    // The PNG must have a transparent center so the avatar shows through.
    // overlay=0:0 places it at top-left (full frame coverage).
    const filterComplex =
      `[1:v]scale=${videoW}:${videoH}[ovr];` +
      `[0:v][ovr]overlay=0:0:format=auto,format=yuv420p[v_final]`;

    const args = [
      "-y",
      "-i", inputPath,
      "-i", overlayPath,
      "-filter_complex", filterComplex,
      "-map", "[v_final]",
      "-map", "0:a?",
      "-c:v", "libx264",
      "-preset", "fast",
      "-crf", "22",
      "-c:a", "aac",
      "-b:a", "128k",
      step1Output,
    ];

    log("Running FFmpeg overlay pass...");
    try {
      const { stderr } = await execFileAsync("ffmpeg", args);
      if (stderr && stderr.includes("Error")) log(`FFmpeg warning: ${stderr.slice(-300)}`);
    } catch (e) {
      log(`FFmpeg overlay failed: ${e.message}`);
      throw e;
    }
    log("✓ Frame overlay applied");
  }

  // ── Step 2: append outro ──────────────────────────────────────────────────
  if (hasOutro) {
    const concatContent =
      `file '${step1Output.replace(/\\/g, "/")}'\n` +
      `file '${outroPath.replace(/\\/g, "/")}'`;
    fs.writeFileSync(concat, concatContent);

    log("Appending outro clip...");
    const concatArgs = [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", concat,
      "-c:v", "libx264",
      "-preset", "fast",
      "-crf", "22",
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart",
      branded,
    ];

    try {
      await execFileAsync("ffmpeg", concatArgs);
    } catch (e) {
      log(`FFmpeg concat failed: ${e.message}`);
      try { fs.unlinkSync(concat); } catch {}
      throw e;
    }

    try { fs.unlinkSync(concat); } catch {}
    if (step1Output !== inputPath) {
      try { fs.unlinkSync(step1Output); } catch {}
    }
    log("✓ Outro appended");
    return branded;
  }

  // No outro — rename step1 to final branded output
  if (step1Output !== inputPath) {
    fs.renameSync(step1Output, branded);
    return branded;
  }

  return inputPath;
}

module.exports = { applyBranding };