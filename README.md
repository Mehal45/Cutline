# Cutline

A free, open-source CapCut-style video editor for Windows and Mac: multi-clip timeline, text with animations, GPU transitions,
on-device auto-captions (Whisper), and MP4 export. No account, no watermark.

## Install

Cutline installs like any other app. You don't need Node.js or a particular browser, because it brings its own video engine.

### Windows 10 / 11

1. Go to **[Releases](https://github.com/Mehal45/Cutline/releases/latest)** and download **`Cutline-Setup-….exe`**.
2. Open it. If Windows shows *"Windows protected your PC"*, click **More info → Run anyway**. This appears because the app isn't code-signed yet (signing costs money), not because something is wrong.
3. Click **Next** through the installer. It adds Cutline to the Start menu and the desktop.

To uninstall, go to **Settings → Apps → Installed apps → Cutline → Uninstall**.

### Mac (Apple silicon and Intel)

1. Go to **[Releases](https://github.com/Mehal45/Cutline/releases/latest)** and download **`Cutline-…-mac.dmg`**.
2. Open it and drag **Cutline** into **Applications**.
3. The first time, macOS blocks it because it isn't notarized by Apple. Open **System Settings → Privacy & Security**, scroll down, and click **Open Anyway** next to the Cutline message.
   - Or run this once in Terminal: `xattr -dr com.apple.quarantine /Applications/Cutline.app`

### Good to know

- **Internet:** Cutline needs a connection to start, because a few editor libraries load online. The caption model downloads once, the first time you use Auto captions.
- **Your videos never leave your computer.** Editing, captions and export all run locally.

### Run from source (developers)

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
git clone https://github.com/Mehal45/Cutline.git
cd Cutline
npm install
npm start            # the desktop app
npm run web          # or: in Chrome/Edge at http://localhost:5173 (no install needed)
npm run dist:win     # build the Windows installer into dist/
npm run dist:mac     # build the Mac .dmg (run this on a Mac)
```

**Releases:** pushing a tag like `v1.0.1` makes GitHub Actions build both installers and publish a release.

## Use

- **Import** clips (or drop files on the left panel), then click a clip to add it to the timeline.
- **Edit in the preview:** click a clip or text to select it, drag to move (it snaps to the centre),
  drag a corner to resize, or drag the top handle to rotate (hold Shift to snap to 15°).
- **Timeline:** drag clip edges to trim. Drag across empty space to box-select, and Shift/Ctrl+click to add
  to the selection. Drag text blocks to move them in time.
- **Speed:** select a clip and pick 0.25×–4× in the right panel, or use the slider for 0.1×–10×.
- **Transitions:** use the Transitions tab on the left (13 styles), or click the **◆** between two clips.
- **Text:** use the Text tab for presets, then style, position and animate in the right panel.

### Shortcuts

| Keys | Action |
|---|---|
| Space | Play / pause |
| Ctrl+Z · Ctrl+Y (or Ctrl+Shift+Z) | Undo · redo |
| Ctrl+C · Ctrl+X · Ctrl+V | Copy · cut · paste at the playhead |
| Ctrl+D · Ctrl+A | Duplicate · select all |
| S or Ctrl+B | Split at the playhead |
| Delete / Backspace · Esc | Delete · clear selection |
| ← → (Shift: 1 s) · Home / End | Step a frame · jump to start / end |
| + / − · ? | Zoom the timeline · show the shortcut list |
- **Auto captions** transcribes the timeline audio in your browser and adds word-highlighted captions.
- **Export** renders an H.264 MP4 at the project's resolution.

## Files

| File | What it does |
|---|---|
| `src/store.js` | Project model (seconds), undo/redo snapshots |
| `src/engine.js` | Compositing, animation presets, text rendering, WebGL transition shaders, video sync |
| `src/export.js` | Offline audio mix + WebCodecs H.264/AAC encode → mp4-muxer |
| `src/decode.js` | mp4box demux + forward-only WebCodecs decoders that feed export frames |
| `src/captions.js`, `src/whisper-worker.js` | Whisper (transformers.js) in a worker; words → caption segments |
| `src/actions.js` | Editing commands: split, delete, clipboard, speed, transitions, playback clock |
| `src/app.js` | UI (React + htm): panels, preview transform overlay, timeline, shortcuts |
| `desktop/main.cjs` | Desktop app (Electron): serves the editor inside the app and opens its window |
| `server.mjs` | Run in a normal browser instead (`npm run web`) |
| `.github/workflows/release.yml` | Builds the Windows and Mac installers on each version tag |

## Known limits

- **One main video track**, where clips play back to back, plus one text track. There are no separate audio, overlay or picture-in-picture tracks.
- **Fast export needs MP4/MOV clips** (H.264, HEVC, VP9 or AV1, if the browser can decode the codec). Other formats, such as WebM, export through a much slower seek-per-frame path.
- **Sped-up audio changes pitch in the exported file.** The live preview keeps the original pitch.
- **Projects aren't saved yet:** closing the app clears the timeline.
