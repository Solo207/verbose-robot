const express = require('express')
const multer = require('multer')
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const app = express()
const upload = multer({ dest: '/tmp/' })

const VIDEOS_DIR = '/app/videos'
if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR, { recursive: true })

app.use('/videos', express.static(VIDEOS_DIR))

// helper — get media duration in seconds via ffprobe
function getDuration(filePath) {
  return parseFloat(
    execSync(
      `ffprobe -v error -show_entries format=duration -of csv=p=0 ${filePath}`,
      { maxBuffer: 10 * 1024 * 1024 }
    ).toString().trim()
  )
}

// ─── /video ──────────────────────────────────────────────────────────────────
// Receives: image (PNG) + audio (MP3)
// Returns:  MP4 binary
//
// Timeline:
//   0:00 ─── picture visible, NO audio (2 seconds silence)
//   0:02 ─── audio starts, Ken Burns breathing zoom begins
//   END-2 ── audio fades to silence
//   END ──── picture still visible, NO audio (2 more seconds)
app.post('/video', upload.fields([
  { name: 'image' },
  { name: 'audio' }
]), (req, res) => {
  const imgPath = req.files['image'][0].path
  const audPath = req.files['audio'][0].path
  const outPath = `/tmp/output_${Date.now()}.mp4`

  try {
    const audioDuration = getDuration(audPath)
    const totalDuration = audioDuration + 4 // 2s silence before + 2s silence after

    // Ken Burns: starts normal, eases into breathing zoom after 3s
    const kenBurns =
      "zoompan=" +
      "z='1.0+0.1*min(in/75\\,1)*(1+sin(2*3.14159265*in/75))':" +
      "x='iw/2-(iw/zoom/2)':" +
      "y='ih/2-(ih/zoom/2)':" +
      "d=100000:s=1200x674:fps=25," +
      "scale=trunc(iw/2)*2:trunc(ih/2)*2"

    // adelay pushes audio 2 seconds in (silence at start)
    // apad holds silence 2 seconds after audio ends
    const filterComplex =
      `[0:v]${kenBurns}[v];` +
      `[1:a]adelay=2000|2000,apad=pad_dur=2[a]`

    const cmd = [
      "ffmpeg",
      "-loop 1 -framerate 25",
      `-i ${imgPath}`,
      `-i ${audPath}`,
      `-filter_complex "${filterComplex}"`,
      `-map "[v]"`,
      `-map "[a]"`,
      "-c:v libx264",
      "-pix_fmt yuv420p",
      "-c:a aac -b:a 128k",
      `-t ${totalDuration}`,
      outPath
    ].join(' ')

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
// Returns:  JSON { url, filename }
//
// Slideshow transition (per clip):
//   video fades OUT to black  (1.75s) — audio goes silent
//   next video fades IN from black (1.75s) — audio rises
//   total black transition = 3.5 seconds, no overlap between slides
app.post('/merge', upload.any(), (req, res) => {
  const files = req.files.sort((a, b) => a.fieldname.localeCompare(b.fieldname))

  if (files.length < 2) {
    return res.status(400).json({ error: 'Need at least 2 videos to merge' })
  }

  const filename = `lesson_${Date.now()}.mp4`
  const outPath = path.join(VIDEOS_DIR, filename)
  const FADE = 1.75 // seconds per side → 3.5s total transition

  try {
    const durations = files.map(f => getDuration(f.path))
    const inputs = files.map(f => `-i ${f.path}`).join(' ')

    // Each clip: fade video in from black + audio from silence
    //            fade video out to black  + audio to silence
    // Then concat all clips — sequential, no overlap
    const filters = []
    const concatParts = []

    for (let i = 0; i < files.length; i++) {
      const fadeOutAt = (durations[i] - FADE).toFixed(3)

      filters.push(
        `[${i}:v]fade=t=in:st=0:d=${FADE},fade=t=out:st=${fadeOutAt}:d=${FADE}[v${i}]`
      )
      filters.push(
        `[${i}:a]afade=t=in:st=0:d=${FADE},afade=t=out:st=${fadeOutAt}:d=${FADE}[a${i}]`
      )
      concatParts.push(`[v${i}][a${i}]`)
    }

    filters.push(
      `${concatParts.join('')}concat=n=${files.length}:v=1:a=1[vout][aout]`
    )

    const cmd = [
      'ffmpeg',
      inputs,
      `-filter_complex "${filters.join(';')}"`,
      '-map "[vout]"',
      '-map "[aout]"',
      '-c:v libx264',
      '-pix_fmt yuv420p',
      '-c:a aac -b:a 128k',
      outPath
    ].join(' ')

    execSync(cmd, { maxBuffer: 100 * 1024 * 1024, stdio: 'pipe' })

    const baseUrl = `${req.protocol}://${req.get('host')}`
    res.json({ url: `${baseUrl}/videos/${filename}`, filename })

  } catch (e) {
    res.status(500).json({ error: e.message })
  } finally {
    files.forEach(f => { if (fs.existsSync(f.path)) fs.unlinkSync(f.path) })
  }
})

// ─── /delete/:filename ───────────────────────────────────────────────────────
app.delete('/delete/:filename', (req, res) => {
  const filename = req.params.filename

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
