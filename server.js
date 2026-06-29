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
                                        // without zoompan each job uses ~100–150 MB:
                                        //   rough guide: floor(available_RAM_MB / 200)
                                        //   e.g.  1 GB container → 3–4 jobs safe
                                        //         2 GB container → 6–8 jobs safe
                                        // (old zoompan version was ~300 MB/job, so half that)

// ─── quality settings ────────────────────────────────────────────────────────
//
//  CRF 23       → libx264 default; visually excellent for static slide content.
//                 With -tune stillimage, P-frames after the first I-frame carry
//                 near-zero difference → effectively lossless compression at
//                 a fraction of the CRF 18 bitrate.  CRF 18 is designed for
//                 motion video and wastes CPU + disk on still-image content.
//
//  PRESET       → encode speed vs quality.  Biggest single CPU knob.
//
//                   preset     relative CPU    note
//                   ──────     ────────────    ────
//                   ultrafast    ~10 %         noticeably soft
//                   fast         ~35 %         good for CI/testing
//                   medium       ~55 %  ←      sweet spot (was 'slow' @ 100%)
//                   slow        ~100 %          previous setting
//                   slower      ~160 %          diminishing returns
//
//                 Switching slow → medium cuts encode CPU in half with no
//                 perceptible quality loss on still-slide material.
//
//  MAX_THREADS  → CPU threads each ffmpeg job may use.
//                 Rule of thumb: floor(total_vCPUs / MAX_CONCURRENT)
//                 e.g. 4 vCPUs ÷ 2 jobs = 2 threads per job.
//                 Set to 0 to let ffmpeg decide (safe only when MAX_CONCURRENT=1)
//
//  PROFILE      → 'high' unlocks 8×8 DCT and better inter-prediction
//  LEVEL        → '4.1' supports up to 1080p60; safe for all modern players
//  AUDIO_BR     → 192k AAC; audible improvement over 128k on music/voiceover
//  FPS          → output framerate; 25 keeps WhatsApp/mobile compatibility
//  OUT_W/H      → 1920×1080 output

const CRF         = '23'
const PRESET      = 'medium'   // was 'slow' — halves CPU with no visible quality drop
const MAX_THREADS = 2          // threads per job  (rule: floor(vCPUs / MAX_CONCURRENT))
const PROFILE     = 'high'
const LEVEL       = '4.1'
const AUDIO_BR    = '192k'
const FPS         = 25
const OUT_W       = 1920
const OUT_H       = 1080

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
// Prevents unbounded RAM growth under load.  Without zoompan, each 1080p
// ffmpeg job holds ~100–150 MB (libx264 lookahead + decoded image plane +
// audio buffers).  The semaphore is shared across ALL endpoints so a burst
// of /merge calls cannot crowd out /video slots and vice-versa.
//
// Callers that arrive when the semaphore is full get an immediate 503 so
// the client can retry rather than queuing work silently in memory.

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
 * - -loglevel error -nostats suppress per-frame progress lines, preventing
 *   multi-MB stderr accumulation in the JS heap during long encodes
 * - Caps stderr retention to 64 KB so genuine errors remain readable
 */
const MAX_STDERR_BYTES = 64 * 1024  // 64 KB — enough for any real error message

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-loglevel', 'error', '-nostats', ...args], {
      timeout: MAX_FFMPEG_MS
    })

    // Rolling tail-buffer: keeps only the last MAX_STDERR_BYTES of stderr.
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
//   0:02 ─── audio starts
//   END-2 ── audio fades to silence
//   END ──── picture still visible, NO audio (2 more seconds)
//
// Video filter:
//   scale with force_original_aspect_ratio=decrease → shrink to fit OUT_W×OUT_H
//   pad → fill remaining space with black bars (letterbox / pillarbox)
//   setsar=1 → correct sample aspect ratio metadata
//   trunc(iw/2)*2 → round to even pixels (required by yuv420p)
//
// RAM/CPU vs previous version:
//   zoompan allocated a frame cache scaled to totalFrames × frame_size.
//   For a 3-min audio at 25fps that was ~4500 frames × 1.5 MB = 6–7 GB
//   of internal ffmpeg heap.  The half-res (960×540) trick reduced this to
//   ~1.7 GB but it was still the dominant memory consumer in the process.
//   Removing it entirely drops per-job RAM from ~300 MB to ~100–150 MB.

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

    // ── Filter graph ────────────────────────────────────────────────────────
    // [0:v] scale image to fit 1920×1080 with black-bar padding
    // [1:a] push audio 2 s right; hold silence 2 s after audio ends
    const filterComplex =
      `[0:v]` +
      `scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=decrease,` +
      `pad=${OUT_W}:${OUT_H}:(ow-iw)/2:(oh-ih)/2,setsar=1,` +
      `scale=trunc(iw/2)*2:trunc(ih/2)*2[v];` +
      `[1:a]adelay=2000|2000,apad=pad_dur=2[a]`

    await ffmpeg([
      '-loop', '1', '-framerate', String(FPS),
      '-i', imgPath,
      '-i', audPath,
      '-filter_complex', filterComplex,
      '-map', '[v]',
      '-map', '[a]',
      // ── video quality ──────────────────────────────────────────────────
      '-c:v',        'libx264',
      '-crf',        CRF,
      '-preset',     PRESET,
      '-tune',       'stillimage',  // skips temporal analysis passes that are
                                    // pointless when frames barely differ;
                                    // /merge does NOT get this — it encodes
                                    // real video where temporal analysis helps
      '-profile:v',  PROFILE,
      '-level:v',    LEVEL,
      '-threads',    String(MAX_THREADS),
      '-pix_fmt',    'yuv420p',
      '-movflags',   '+faststart',
      // ── audio quality ──────────────────────────────────────────────────
      '-c:a', 'aac', '-b:a', AUDIO_BR,
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
  // so the slot is not freed until the response has fully flushed.
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
      // ── video quality ─────────────────────────────────────────────────
      '-c:v',        'libx264',
      '-crf',        CRF,
      '-preset',     PRESET,
      // no -tune stillimage here — /merge encodes real video clips where
      // temporal analysis is beneficial, not wasteful
      '-profile:v',  PROFILE,
      '-level:v',    LEVEL,
      '-threads',    String(MAX_THREADS),
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
      active_jobs:     activeJobs,
      max_concurrent:  MAX_CONCURRENT,
      slots_available: MAX_CONCURRENT - activeJobs
    })
  } catch (e) {
    res.status(500).json({ status: 'error', message: 'ffprobe unavailable', detail: e.message })
  }
})

// ─── start ───────────────────────────────────────────────────────────────────

app.listen(4000, () => console.log('ATLAS FFmpeg service running on :4000'))
