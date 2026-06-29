const express = require('express')
const multer = require('multer')
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const app = express()
const upload = multer({ dest: '/tmp/' })

// Persistent video store directory
const VIDEOS_DIR = '/app/videos'
if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR, { recursive: true })

// Serve stored videos as static files
app.use('/videos', express.static(VIDEOS_DIR))

// ─── /video ──────────────────────────────────────────────────────────────────
// Receives: image (PNG) + audio (MP3)
// Returns:  MP4 binary with Ken Burns breathing effect
app.post('/video', upload.fields([
  { name: 'image' },
  { name: 'audio' }
]), (req, res) => {
  const imgPath = req.files['image'][0].path
  const audPath = req.files['audio'][0].path
  const outPath = `/tmp/output_${Date.now()}.mp4`

  // Starts normal → eases into breathing zoom over first 3 seconds
  // max zoom swing = 0.1 * 2 = 20% — noticeable but not jarring
  const kenBurns = [
    "zoompan=",
    "z='1.0+0.1*min(in/75,1)*(1+sin(2*3.14159265*in/75))':",
    "x='iw/2-(iw/zoom/2)':",
    "y='ih/2-(ih/zoom/2)':",
    "d=100000:",
    "s=1200x674:",
    "fps=25,",
    "scale=trunc(iw/2)*2:trunc(ih/2)*2"
  ].join('')

  const cmd = [
    "ffmpeg",
    "-loop 1 -framerate 25",
    `-i ${imgPath}`,
    `-i ${audPath}`,
    `-vf "${kenBurns}"`,
    "-c:v libx264",
    "-pix_fmt yuv420p",
    "-c:a aac -b:a 128k",
    "-shortest",
    outPath
  ].join(' ')

  try {
    execSync(cmd, { maxBuffer: 100 * 1024 * 1024, stdio: 'pipe' })
    const mp4 = fs.readFileSync(outPath)
    res.set('Content-Type', 'video/mp4')
    res.set('Content-Disposition', 'attachment; filename=slide.mp4')
    res.send(mp4)
  } catch (e) {
    res.status(500).json({ error: e.message })
  } finally {
    if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath)
    if (fs.existsSync(audPath)) fs.unlinkSync(audPath)
    if (fs.existsSync(outPath)) fs.unlinkSync(outPath)
  }
})

// ─── /merge ──────────────────────────────────────────────────────────────────
// Receives: video1, video2, video3 ... (field name controls order)
// Returns:  JSON { url, filename } — video stored on disk, not returned as binary
// Use /delete/:filename to clean up after downloading
app.post('/merge', upload.any(), (req, res) => {
  const files = req.files.sort((a, b) => a.fieldname.localeCompare(b.fieldname))

  if (files.length < 2) {
    return res.status(400).json({ error: 'Need at least 2 videos to merge' })
  }

  const filename = `lesson_${Date.now()}.mp4`
  const outPath = path.join(VIDEOS_DIR, filename)
  const fadeDuration = 1

  try {
    // Get duration of each video
    const durations = files.map(f => {
      const result = execSync(
        `ffprobe -v error -show_entries format=duration -of csv=p=0 ${f.path}`,
        { maxBuffer: 10 * 1024 * 1024 }
      ).toString().trim()
      return parseFloat(result)
    })

    const inputs = files.map(f => `-i ${f.path}`).join(' ')

    // Build chained xfade + acrossfade filters
    const vFilters = []
    const aFilters = []
    let prevV = '0:v'
    let prevA = '0:a'
    let cumulativeDuration = durations[0]

    for (let i = 1; i < files.length; i++) {
      const isLast = i === files.length - 1
      const vOut = isLast ? 'vout' : `v${i}`
      const aOut = isLast ? 'aout' : `a${i}`
      const offset = (cumulativeDuration - fadeDuration).toFixed(3)

      vFilters.push(`[${prevV}][${i}:v]xfade=transition=fade:duration=${fadeDuration}:offset=${offset}[${vOut}]`)
      aFilters.push(`[${prevA}][${i}:a]acrossfade=d=${fadeDuration}[${aOut}]`)

      prevV = vOut
      prevA = aOut
      cumulativeDuration += durations[i] - fadeDuration
    }

    const filterComplex = [...vFilters, ...aFilters].join(';')

    const cmd = [
      'ffmpeg',
      inputs,
      `-filter_complex "${filterComplex}"`,
      '-map "[vout]"',
      '-map "[aout]"',
      '-c:v libx264',
      '-pix_fmt yuv420p',
      '-c:a aac -b:a 128k',
      outPath
    ].join(' ')

    execSync(cmd, { maxBuffer: 100 * 1024 * 1024, stdio: 'pipe' })

    const baseUrl = `${req.protocol}://${req.get('host')}`
    res.json({
      url: `${baseUrl}/videos/${filename}`,
      filename
    })

  } catch (e) {
    res.status(500).json({ error: e.message })
  } finally {
    files.forEach(f => { if (fs.existsSync(f.path)) fs.unlinkSync(f.path) })
  }
})

// ─── /delete/:filename ────────────────────────────────────────────────────────
// Deletes a stored merged video by filename
// Call this after you have downloaded/sent the video to WhatsApp
app.delete('/delete/:filename', (req, res) => {
  const filename = req.params.filename

  // Block path traversal attempts
  if (filename.includes('/') || filename.includes('..')) {
    return res.status(400).json({ error: 'Invalid filename' })
  }

  const filePath = path.join(VIDEOS_DIR, filename)

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' })
  }

  fs.unlinkSync(filePath)
  res.json({ deleted: filename })
})

// ─── /health ─────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  const stored = fs.readdirSync(VIDEOS_DIR).length
  res.json({ status: 'ok', stored_videos: stored })
})

app.listen(4000, () => console.log('ATLAS FFmpeg service running on :4000'))
