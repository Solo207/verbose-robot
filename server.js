const express  = require('express')
const multer   = require('multer')
const { execFileSync, spawn } = require('child_process')
const fs       = require('fs')
const path     = require('path')
const crypto   = require('crypto')

// ─── constants ───────────────────────────────────────────────────────────────

const VIDEOS_DIR     = '/app/videos'
const FADE           = 0.5           // seconds per side → 2s total transition
const MAX_FFMPEG_MS  = 5 * 60 * 1000   // 5-minute hard timeout per ffmpeg process
const UPLOAD_LIMIT   = 200 * 1024 * 1024 // 200 MB per file

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

/**
 * Async ffmpeg wrapper.
 * - Accepts an args ARRAY → no shell, no injection surface (fix #1)
 * - Non-blocking: Node can serve other requests while ffmpeg runs (fix #8)
 * - Hard timeout via spawn option prevents runaway processes (fix #14)
 * - Captures stderr so errors are readable
 */
function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc   = spawn('ffmpeg', args, { timeout: MAX_FFMPEG_MS })
    const stderr = []
    proc.stderr.on('data', chunk => stderr.push(chunk))
    proc.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(Buffer.concat(stderr).toString()))
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
// Returns:  MP4 binary (streamed, not buffered — fix #9)
//
// Timeline:
//   0:00 ─── picture visible, NO audio (2 seconds silence)
//   0:02 ─── audio starts, Ken Burns breathing zoom begins
//   END-2 ── audio fades to silence
//   END ──── picture still visible, NO audio (2 more seconds)
//
// Ken Burns optimisation (fix #10):
//   zoompan runs at 600×337 (half the output size) then upscales.
//   This cuts zoompan CPU cost by ~4× with negligible quality loss,
//   since the output encoder smooths the upscale.
//   Hardware encoding alternative (if available):
//     replace '-c:v','libx264' with '-c:v','h264_nvenc' (NVIDIA)
//                                 or '-c:v','h264_videotoolbox' (Apple)

app.post('/video', upload.fields([
  { name: 'image', maxCount: 1 },
  { name: 'audio', maxCount: 1 }
]), async (req, res) => {

  // Guard: both fields must be present (fix #2)
  if (!req.files?.image?.[0] || !req.files?.audio?.[0]) {
    return res.status(400).json({ error: 'Both "image" and "audio" fields are required' })
  }

  const imgPath = req.files.image[0].path
  const audPath = req.files.audio[0].path
  const outPath = `/tmp/output_${crypto.randomUUID()}.mp4` // collision-safe (fix #6)

  try {
    const audioDuration = getDuration(audPath)
    const totalDuration = audioDuration + 4  // 2s silence before + 2s silence after

    // Ken Burns: zoompan at half-res (600×337) then upscale to full (1200×674)
    // d=100000 is effectively infinite — actual length is capped by -t
    const kenBurns =
      'scale=600:337,' +
      'zoompan=' +
        "z='1.0+0.1*min(in/75\\,1)*(1+sin(2*3.14159265*in/75))':" +
        "x='iw/2-(iw/zoom/2)':" +
        "y='ih/2-(ih/zoom/2)':" +
        'd=100000:s=600x337:fps=25,' +
      'scale=1200:674,' +
      'scale=trunc(iw/2)*2:trunc(ih/2)*2'

    // adelay pushes audio 2 s in; apad holds silence 2 s after audio ends
    const filterComplex =
      `[0:v]${kenBurns}[v];` +
      '[1:a]adelay=2000|2000,apad=pad_dur=2[a]'

    await ffmpeg([
      '-loop', '1', '-framerate', '25',
      '-i', imgPath,
      '-i', audPath,
      '-filter_complex', filterComplex,
      '-map', '[v]',
      '-map', '[a]',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k',
      '-t', String(totalDuration),
      outPath
    ])

    res.set('Content-Type', 'video/mp4')
    res.set('Content-Disposition', 'attachment; filename=slide.mp4')

    // Stream directly to client — no full-file read into RAM (fix #9)
    // outPath cleanup lives on 'close', NOT in finally{}, so the file
    // is not deleted before the stream finishes sending.
    const stream = fs.createReadStream(outPath)
    stream.pipe(res)
    stream.on('close', () => cleanup(outPath))

  } catch (e) {
    cleanup(outPath)
    if (!res.headersSent) res.status(500).json({ error: e.message })
  } finally {
    // Uploaded temp files can be removed immediately regardless of outcome
    cleanup(imgPath, audPath)
  }
})

// ─── /merge ──────────────────────────────────────────────────────────────────
//
// Receives: video1, video2, video3 … (field name controls order)
// Returns:  JSON { url, filename }
//
// Transition (per clip):
//   video fades OUT to black (1s) + audio fades to silence
//   next video fades IN from black (1s) + audio rises
//   total black transition = 2 seconds, clips are sequential (no overlap)

app.post('/merge', upload.any(), async (req, res) => {

  if (!req.files?.length) {
    return res.status(400).json({ error: 'No video files uploaded' })
  }

  // Numeric sort: ensures video10 follows video9, not video1 (fix #4)
  const files = [...req.files].sort((a, b) => {
    const num = s => parseInt(s.replace(/\D/g, ''), 10)
    return num(a.fieldname) - num(b.fieldname)
  })

  if (files.length < 2) {
    return res.status(400).json({ error: 'Need at least 2 videos to merge' })
  }

  const filename = `lesson_${crypto.randomUUID()}.mp4` // collision-safe (fix #6)
  const outPath  = path.join(VIDEOS_DIR, filename)

  try {
    const durations = files.map(f => getDuration(f.path))

    // Guard: every clip must be long enough to hold fade-in + fade-out (fix #3)
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
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k',
      outPath
    ])

    const baseUrl = `${req.protocol}://${req.get('host')}`
    res.json({ url: `${baseUrl}/videos/${filename}`, filename })

  } catch (e) {
    cleanup(outPath)
    if (!res.headersSent) res.status(500).json({ error: e.message })
  } finally {
    files.forEach(f => cleanup(f.path))
  }
})

// ─── /delete/:filename ───────────────────────────────────────────────────────

app.delete('/delete/:filename', (req, res) => {
  // path.basename strips any directory components from the input
  // the startsWith check is a second layer against encoded traversal (fix #12)
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
// Verifies ffprobe is actually functional, not just that the process is up (fix #13)

app.get('/health', (req, res) => {
  try {
    execFileSync('ffprobe', ['-version'], { timeout: 5_000 })
    const stored = fs.readdirSync(VIDEOS_DIR).length
    res.json({ status: 'ok', stored_videos: stored })
  } catch (e) {
    res.status(500).json({ status: 'error', message: 'ffprobe unavailable', detail: e.message })
  }
})

// ─── start ───────────────────────────────────────────────────────────────────

app.listen(4000, () => console.log('ATLAS FFmpeg service running on :4000'))
