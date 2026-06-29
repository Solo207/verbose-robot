const express = require('express')
const multer = require('multer')
const { execSync } = require('child_process')
const fs = require('fs')

const app = express()
const upload = multer({ dest: '/tmp/' })

app.post('/video', upload.fields([
  { name: 'image' },
  { name: 'audio' }
]), (req, res) => {
  const imgPath = req.files['image'][0].path
  const audPath = req.files['audio'][0].path
  const outPath = `/tmp/output_${Date.now()}.mp4`

  // Ken Burns effect:
  // - Slowly zooms in from 1x to max 1.5x over the entire video
  // - Stays centered on the image throughout
  // - d=100000 means enough frames to cover any audio length
  // - fps=25 is standard smooth playback
  // - s=1200x674 (not 675 — libx264 requires height divisible by 2)
  // - scale filter at end enforces even dimensions as a safety net
  const kenBurns = [
    "zoompan=",
 "z='1.0+0.05*min(in/75,1)*(1+sin(2*3.14159265*in/75))':",
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
    execSync(cmd, { stdio: 'pipe' })

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

app.get('/health', (req, res) => res.json({ status: 'ok' }))

app.listen(4000, () => console.log('ATLAS FFmpeg service running on :4000'))
