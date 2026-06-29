const express  = require('express')
const multer   = require('multer')
const { execFileSync, spawn } = require('child_process')
const fs       = require('fs')
const path     = require('path')
const crypto   = require('crypto')

// ─── constants ───────────────────────────────────────────────────────────────

const VIDEOS_DIR     = '/app/videos'
const FADE           = 0.5              // seconds per side → 2s total transition
const MAX_FFMPEG_MS  = 5 * 60 * 1000   // 5-minute hard timeout per ffmpeg process
const UPLOAD_LIMIT   = 200 * 1024 * 1024 // 200 MB per file
const MAX_CONCURRENT = 2               // max simultaneous ffmpeg jobs (ALL endpoints combined)
                                        // rough guide: floor(available_RAM_GB * 1024 / 300)
                                        // e.g. 2 on a 1 GB container, 6 on a 2 GB container

// ─── quality settings ────────────────────────────────────────────────────────
// Centralised so a single edit controls both /video and /merge.
//
//  CRF 18    → visually lossless for most content (was default 23)
//  preset    → 'slow' squeezes ~15–20 % more quality out of the same CRF
//              at the cost of extra encode time (was unset → 'medium')
//  PROFILE   → 'high' unlocks 8×8 DCT and better inter-prediction
//  LEVEL     → '4.1' supports up to 1080p60; safe for all modern players
//  AUDIO_BR  → 192k AAC; audible improvement over 128k on music/voiceover
//  OUT_W/H   → 1920×1080 output (was 1200×674)
//  KB_W/KB_H → 960×540 intermediate for Ken Burns zoompan (was 600×337);
//              zoompan CPU scales with pixel count, so half-res is kept as
//              an optimisation — the final upscale is lossless in libx264.

const CRF      = '18'
const PRESET   = 'slow'
const PROFILE  = 'high'
const LEVEL    = '4.1'
const AUDIO_BR = '192k'
const FPS      = 25
const OUT_W    = 1920
const OUT_H    = 1080
const KB_W     = OUT_W / 2   // 960
const KB_H     = OUT_H / 2   // 540

// ─── breathing zoom settings ─────────────────────────────────────────────────
//
// The /video endpoint applies a continuous slow zoom-in/zoom-out to the still
// image, giving the impression of gentle motion (sometimes called "Ken Burns
// breathing").  Only two knobs to turn:
//
//  ZOOM_STRENGTH  – how far the zoom travels on each pulse, expressed as a
//                   fraction of the image size.
//                   0.04 = 4 % swing (barely perceptible, good for talking-head slides)
//                   0.08 = 8 % swing  ← default, noticeable but not distracting
//                   0.15 = 15% swing (dramatic; may feel restless on long clips)
//                   Keep below 0.25 to avoid the edges of the frame being reached.
//
//  ZOOM_PERIOD    – seconds for one complete in → out → in cycle.
//                   2  = fast pulse (energetic)
//                   4  ← default, one slow breath every 4 seconds
//                   8  = very slow drift
//
// The formula used is a raised cosine so it starts and ends at the minimum
// zoom level (no visible jump at loop points):
//
//   z(t) = 1 + ZOOM_STRENGTH × ½ × (1 − cos(2π × t / ZOOM_PERIOD))
//
//   t = frame_index / FPS
//
//   • t = 0              → z = 1.0              (no zoom, image fits exactly)
//   • t = ZOOM_PERIOD/2  → z = 1 + ZOOM_STRENGTH (maximum zoom-in)
//   • t = ZOOM_PERIOD    → z = 1.0              (back to start, seamless)

const ZOOM_STRENGTH = 0.10   // fractional zoom swing  (try 0.04 – 0.15)
const ZOOM_PERIOD   = 4      // seconds per full cycle  (try 2 – 8)

// ─── app setup ───────────────────────────────────────────────────────────────

if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR, { recursive: true })

const app    = express()
const upload = multer({ dest: '/tmp/', limits: { fileSize: UPLOAD_LIMIT } })

app.use('/videos', express.static(VIDEOS_DIR))

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Returns media duration in seconds via ffprobe.
 * Uses execFileSync with an args array — no shell, no injection surface.
 * Throws a descriptive error if ffprobe returns a non-numeric value.
 */
function getDuration(filePath) {
  const raw = execFileSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath],
    { maxBuffer: 10 * 1024 * 1024 }
  ).toString().trim()

  const duration = parseFloat(raw)
  if (!isFinite(duration) || duration <= 0) {
    throw new Error(`Invalid duration from ffprobe for: ${filePath}`)
  }
  return duration
}

// ─── concurrency semaphore ────────────────────────────────────────────────────
//
// Prevents unbounded RAM growth under load.  Each 1080p ffmpeg job holds
// ~150–300 MB inside the child process (libx264 lookahead + zoompan cache +
// decoded image planes).  Without a cap, n simultaneous requests = n × 300 MB.
//
// The semaphore is shared across ALL endpoints (/video and /merge) so a burst
// of /merge calls cannot crowd out /video slots and vice-versa.
//
// Callers that arrive when the semaphore is full receive an immediate 503 so
// the client can retry rather than the request silently queuing in memory.

let activeJobs = 0

function acquireSlot() {
  if (activeJobs >= MAX_CONCURRENT) return false
  activeJobs++
  return true
}

function releaseSlot() {
  activeJobs = Math.max(0, activeJobs - 1)
}

/**
 * Async ffmpeg wrapper.
 * - Accepts an args ARRAY → no shell, no injection surface
 * - Non-blocking: Node can serve other requests while ffmpeg runs
 * - Hard timeout via spawn option prevents runaway processes
 * - Uses -loglevel error -nostats so ffmpeg does NOT emit per-frame progress
 *   lines — the previous approach (buffering all stderr) could accumulate
 *   several MB of progress text in the JS heap for a long 1080p encode
 * - Caps stderr retention to 64 KB so a genuine error message is readable
 *   without holding the entire ffmpeg log in RAM
 */
const MAX_STDERR_BYTES = 64 * 1024  // 64 KB — enough for any real error message

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    // Prepend flags that suppress per-frame progress output.
    // -loglevel error : only print actual errors, not stats/info
    // -nostats        : belt-and-braces suppression of the progress line
    const proc = spawn('ffmpeg', ['-loglevel', 'error', '-nostats', ...args], {
      timeout: MAX_FFMPEG_MS
    })

    // Rolling tail-buffer: keeps only the last MAX_STDERR_BYTES of stderr.
    // A plain array that grows forever was the old RAM leak for verbose encodes.
    let stderrBuf = Buffer.alloc(0)
    proc.stderr.on('data', chunk => {
      stderrBuf = Buffer.concat([stderrBuf, chunk])
      if (stderrBuf.length > MAX_STDERR_BYTES) {
        stderrBuf = stderrBuf.slice(stderrBuf.length - MAX_STDERR_BYTES)
      }
    })

    proc.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(stderrBuf.toString()))
    })
    proc.on('error', reject)
  })
}

/**
 * Best-effort cleanup of one or more temp paths.
 * Safe to call multiple times on the same path (try/catch swallows ENOENT).
 */
function cleanup(...paths) {
  for (const p of paths) {
    try { if (p && fs.existsSync(p)) fs.unlinkSync(p) } catch {}
  }
}

// ─── /video ──────────────────────────────────────────────────────────────────
//
// Receives: image (PNG) + audio (MP3)
// Returns:  MP4 binary (streamed, not buffered)
//
// Timeline:
//   0:00 ─── picture visible, NO audio (2 seconds silence)
//   0:02 ─── audio starts, Ken Burns breathing zoom begins
//   END-2 ── audio fades to silence
//   END ──── picture still visible, NO audio (2 more seconds)
//
// Ken Burns optimisation:
//   zoompan runs at KB_W×KB_H (half the output size) then upscales to OUT_W×OUT_H.
//   This cuts zoompan CPU cost by ~4× with negligible quality loss because
//   libx264 is encoding the upscaled output at CRF 18 (near-lossless).

app.post('/video', upload.fields([
  { name: 'image', maxCount: 1 },
  { name: 'audio', maxCount: 1 }
]), async (req, res) => {

  // Guard: both fields must be present
  if (!req.files?.image?.[0] || !req.files?.audio?.[0]) {
    return res.status(400).json({ error: 'Both "image" and "audio" fields are required' })
  }

  const imgPath = req.files.image[0].path
  const audPath = req.files.audio[0].path
  const outPath = `/tmp/output_${crypto.randomUUID()}.mp4`

  // Reject early if all encode slots are busy — avoids queuing work in RAM
  if (!acquireSlot()) {
    cleanup(imgPath, audPath)
    return res.status(503).json({
      error: `Server busy — ${MAX_CONCURRENT} encodes already running. Try again shortly.`
    })
  }

  try {
    const audioDuration = getDuration(audPath)
    const totalDuration = audioDuration + 4  // 2s silence before + 2s silence after

    // ── Breathing zoom filter ───────────────────────────────────────────────
    // Runs at half-res (KB_W×KB_H) for CPU efficiency, then upscales.
    //
    // WHY `ot` and not `in`:
    //   zoompan exposes two counters — `in` (input frame index) and `ot`
    //   (output timestamp in seconds).  With -loop 1 feeding a still image,
    //   a single input frame (in=0) produces all `d` output frames, so `in`
    //   is stuck at 0 for the entire clip and any formula written in terms of
    //   `in` evaluates to a constant — the image would never move.
    //   `ot` increments correctly for every output frame and makes the formula
    //   frame-rate independent as a bonus.
    //
    // Shape: raised cosine — starts at minimum zoom, peaks at ZOOM_PERIOD/2,
    //   returns to minimum.  No brightness change, no opacity change.
    //   Camera stays locked to the image centre throughout.
    //
    //   z(ot) = 1  +  ZOOM_STRENGTH × ½ × (1 − cos(2π × ot / ZOOM_PERIOD))
    //
    //   ot = 0             →  z = 1.0               (normal, no zoom)
    //   ot = ZOOM_PERIOD/2 →  z = 1 + ZOOM_STRENGTH (maximum zoom-in)
    //   ot = ZOOM_PERIOD   →  z = 1.0               (back to start, seamless)
    //
    // ── To tune the effect, edit these two constants at the top of the file ─
    //   ZOOM_STRENGTH  →  zoom travel per pulse     e.g. 0.04 (subtle) – 0.20 (dramatic)
    //   ZOOM_PERIOD    →  seconds per full cycle     e.g. 2 (fast) – 8 (slow drift)
    // ────────────────────────────────────────────────────────────────────────
    const totalFrames = Math.ceil(totalDuration * FPS)
    const zoomExpr    = `1+${ZOOM_STRENGTH}*0.5*(1-cos(2*3.14159265*ot/${ZOOM_PERIOD}))`

    const kenBurns =
      `scale=${KB_W}:${KB_H},` +
      'zoompan=' +
        `z='${zoomExpr}':` +
        "x='iw/2-(iw/zoom/2)':" +      // lock to horizontal centre
        "y='ih/2-(ih/zoom/2)':" +      // lock to vertical centre
        `d=${totalFrames}:s=${KB_W}x${KB_H}:fps=${FPS},` +
      `scale=${OUT_W}:${OUT_H},` +
      // ensure dimensions are even (required by yuv420p)
      'scale=trunc(iw/2)*2:trunc(ih/2)*2'

    // adelay pushes audio 2 s in; apad holds silence 2 s after audio ends
    const filterComplex =
      `[0:v]${kenBurns}[v];` +
      '[1:a]adelay=2000|2000,apad=pad_dur=2[a]'

    await ffmpeg([
      '-loop', '1', '-framerate', String(FPS),
      '-i', imgPath,
      '-i', audPath,
      '-filter_complex', filterComplex,
      '-map', '[v]',
      '-map', '[a]',
      // ── video quality ──────────────────────────────────────────────────
      '-c:v',        'libx264',
      '-crf',        CRF,          // 18 → near-lossless (was default 23)
      '-preset',     PRESET,       // 'slow' → better quality at same CRF
      '-profile:v',  PROFILE,      // 'high' → richer encoding tools
      '-level:v',    LEVEL,        // '4.1' → up to 1080p60, universal support
      '-pix_fmt',    'yuv420p',
      '-movflags',   '+faststart', // index at front → instant web playback
      // ── audio quality ──────────────────────────────────────────────────
      '-c:a', 'aac', '-b:a', AUDIO_BR,  // 192k (was 128k)
      '-t', String(totalDuration),
      outPath
    ])

    res.set('Content-Type', 'video/mp4')
    res.set('Content-Disposition', 'attachment; filename=slide.mp4')

    // Stream directly to client — no full-file read into RAM.
    // outPath cleanup lives on 'close', NOT in finally{}, so the file
    // is not deleted before the stream finishes sending.
    const stream = fs.createReadStream(outPath)
    stream.pipe(res)
    stream.on('close', () => { cleanup(outPath); releaseSlot() })

  } catch (e) {
    cleanup(outPath)
    releaseSlot()
    if (!res.headersSent) res.status(500).json({ error: e.message })
  } finally {
    cleanup(imgPath, audPath)
  }

  // NOTE: releaseSlot() on the happy path lives on the stream 'close' event
  // (below) so the slot is not freed until the response has fully flushed.
  // This prevents a second job from starting while the first is still piping
  // its output — which would briefly double the disk I/O and RAM pressure.
})

// ─── /merge ──────────────────────────────────────────────────────────────────
//
// Receives: video1, video2, video3 … (field name controls order)
// Returns:  JSON { url, filename }
//
// Transition (per clip):
//   video fades OUT to black (FADE s) + audio fades to silence
//   next video fades IN from black (FADE s) + audio rises
//   clips are sequential (no overlap)

app.post('/merge', upload.any(), async (req, res) => {

  if (!req.files?.length) {
    return res.status(400).json({ error: 'No video files uploaded' })
  }

  // Numeric sort: ensures video10 follows video9, not video1
  const files = [...req.files].sort((a, b) => {
    const num = s => parseInt(s.replace(/\D/g, ''), 10)
    return num(a.fieldname) - num(b.fieldname)
  })

  if (files.length < 2) {
    return res.status(400).json({ error: 'Need at least 2 videos to merge' })
  }

  const filename = `lesson_${crypto.randomUUID()}.mp4`
  const outPath  = path.join(VIDEOS_DIR, filename)

  // Reject early if all encode slots are busy
  if (!acquireSlot()) {
    files.forEach(f => cleanup(f.path))
    return res.status(503).json({
      error: `Server busy — ${MAX_CONCURRENT} encodes already running. Try again shortly.`
    })
  }

  try {
    const durations = files.map(f => getDuration(f.path))

    // Guard: every clip must be long enough to hold fade-in + fade-out
    for (let i = 0; i < files.length; i++) {
      if (durations[i] < FADE * 2) {
        return res.status(400).json({
          error: `Clip "${files[i].fieldname}" is ${durations[i].toFixed(2)}s — ` +
                 `minimum is ${(FADE * 2).toFixed(2)}s for transitions`
        })
      }
    }

    // Build filter graph: fade each clip in and out, then concat sequentially
    const inputArgs   = files.flatMap(f => ['-i', f.path])
    const filters     = []
    const concatParts = []

    for (let i = 0; i < files.length; i++) {
      const fadeOutAt = (durations[i] - FADE).toFixed(3)
      filters.push(`[${i}:v]fade=t=in:st=0:d=${FADE},fade=t=out:st=${fadeOutAt}:d=${FADE}[v${i}]`)
      filters.push(`[${i}:a]afade=t=in:st=0:d=${FADE},afade=t=out:st=${fadeOutAt}:d=${FADE}[a${i}]`)
      concatParts.push(`[v${i}][a${i}]`)
    }

    filters.push(`${concatParts.join('')}concat=n=${files.length}:v=1:a=1[vout][aout]`)

    await ffmpeg([
      ...inputArgs,
      '-filter_complex', filters.join(';'),
      '-map', '[vout]',
      '-map', '[aout]',
      // ── video quality (same settings as /video) ────────────────────────
      '-c:v',        'libx264',
      '-crf',        CRF,
      '-preset',     PRESET,
      '-profile:v',  PROFILE,
      '-level:v',    LEVEL,
      '-pix_fmt',    'yuv420p',
      '-movflags',   '+faststart',
      // ── audio quality ──────────────────────────────────────────────────
      '-c:a', 'aac', '-b:a', AUDIO_BR,
      outPath
    ])

    const baseUrl = `${req.protocol}://${req.get('host')}`
    res.json({ url: `${baseUrl}/videos/${filename}`, filename })
    releaseSlot()

  } catch (e) {
    cleanup(outPath)
    releaseSlot()
    if (!res.headersSent) res.status(500).json({ error: e.message })
  } finally {
    files.forEach(f => cleanup(f.path))
  }
})

// ─── /delete/:filename ───────────────────────────────────────────────────────

app.delete('/delete/:filename', (req, res) => {
  const filename = path.basename(req.params.filename)
  const filePath = path.join(VIDEOS_DIR, filename)

  if (!filePath.startsWith(VIDEOS_DIR + path.sep)) {
    return res.status(400).json({ error: 'Invalid filename' })
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' })
  }

  fs.unlinkSync(filePath)
  res.json({ deleted: filename })
})

// ─── /health ─────────────────────────────────────────────────────────────────
// Verifies ffprobe is actually functional, not just that the process is up

app.get('/health', (req, res) => {
  try {
    execFileSync('ffprobe', ['-version'], { timeout: 5_000 })
    const stored = fs.readdirSync(VIDEOS_DIR).length
    res.json({
      status:          'ok',
      stored_videos:   stored,
      active_jobs:     activeJobs,        // currently running ffmpeg processes
      max_concurrent:  MAX_CONCURRENT,    // configured cap
      slots_available: MAX_CONCURRENT - activeJobs
    })
  } catch (e) {
    res.status(500).json({ status: 'error', message: 'ffprobe unavailable', detail: e.message })
  }
})

// ─── start ───────────────────────────────────────────────────────────────────

app.listen(4000, () => console.log('ATLAS FFmpeg service running on :4000'))
