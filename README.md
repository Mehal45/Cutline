# Cutline

A free, open-source CapCut-style video editor for Windows and Mac. No account, no watermark, no upload: everything runs on your computer.

- **Multi-track:** a main video track plus picture-in-picture layers, audio tracks (music, voice-overs) and timeline effects
- **Keyframes** for position, scale, rotation, opacity, volume, colour and effect strength, with a curve editor
- **57 GPU effects, 20 filters, 14 colour adjustments and 25 transitions**, all live in the preview
- **Background removal** for people, plus a **chroma key** (green screen)
- **Auto-captions** (Whisper) and **text-to-speech** with 16 natural voices (Kokoro), both on-device
- **Voice cleanup** (reduce noise, enhance voice, level loudness) and **13 voice effects** (chipmunk, robot, telephone…)
- **Titles:** 32 built-in fonts plus every font installed on your computer, outline, shadow, background plate, letter spacing and 18 presets
- **Speed curves:** smooth speed ramps (e.g. normal → fast → normal) with presets and an editable curve, plus one-click smooth (ease in & out) motion for keyframes
- **Preview quality** Full / ½ / ¼ for smooth playback on slower computers (export is always full quality)
- **Cut fast:** split, trim, ripple delete, merge, freeze frame, detach audio, speed 0.1–10×, magnetic snapping
- **Blend modes, crop and flips** on any clip or layer
- **Export** H.264, HEVC, AV1 or VP9 MP4 up to 4K 60 fps at any bitrate (e.g. 40,000 kbps), plus WAV audio and PNG stills
- **Projects** save and open as `.cutline` files, with autosave and crash recovery in the desktop app

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

- **Import** clips (or drop files on the left panel). They go into the **media library**, not straight onto the timeline.
- **Preview before adding:** click a library item to play it in the viewer. Mark **In** / **Out** (I / O) to use only part of it. Press **Add to timeline** (Enter) or **Add as layer**.
- **Other ways to add:** double-click a library item, click **＋ Add** / **＋ Layer** on it, or drag it straight onto the timeline where you want it.
- **Edit in the preview:** click a clip, layer or text to select it, drag to move (it snaps to the centre), drag a corner to resize, or drag the top handle to rotate (hold Shift to snap to 15°).
- **Timeline:** drag edges to trim and drag items to move them; the clip follows the mouse. Drag main-track clips left/right to reorder them, or up to turn them into a layer; drag a layer down onto the main track to put it back. Hold a dragged clip near the edge and the timeline keeps scrolling. Zoom from about 2 hours on screen down to single frames (Ctrl + mouse wheel, the slider, or **⤢ Fit**). Drag across empty space to box-select, and Shift/Ctrl+click to add to the selection. **🧲 Snap** lines edges up with the playhead and other clips. Drag the top edge of the timeline to resize it.
- **Inspector tabs** (right panel), for a selected clip or layer:
  - **Basic:** position, size, opacity, speed, timing, blend mode, crop, flips, freeze frame and merge.
  - **Colour:** filters and adjustments.
  - **Effects:** stacked effects with an amount for each.
  - **Cutout:** remove the background or a colour.
  - **Audio:** volume, fades, cleanup and voice effects.
  - **Animate:** in/out animations and keyframe curves.
- **Keyframes:** move the playhead and press **◆** next to any slider. Move the playhead again and change the value, and it animates between them. Yellow diamonds on the timeline show where the keyframes are.
- **Effects / Filters tabs** (left panel) show live previews on the current frame. Click one to apply it to the selected clips, or with nothing selected to add a timeline effect over everything below it. **+ Adjustment layer** grades every clip under it at once.
- **Audio tab:** add music, or type text and press **Generate voice-over** (text-to-speech; the ~90 MB voice model downloads once).
- **Auto captions** transcribes the timeline audio on your computer and adds word-highlighted captions.
  - **Style all captions at once:** select a caption and tick **Apply changes to all captions**. Font, size, colours, outline, shadow, background and in/out animation then change on every caption.
  - **Edit several at once:** press **Select all** (or box-select texts on the timeline). The inspector shows one set of font, size, colour, animation and position controls for all of them.
- **File menu:** new, open, save (Ctrl+S), save as, export the current frame (PNG) and export the audio (WAV).
- **Export:** choose the resolution (720p–4K), frame rate (24–60), format (H.264, HEVC, AV1, VP9) and quality.

### Shortcuts

Press **?** in the app for the full list. On a Mac, use ⌘ where it says Ctrl.

| Keys | Action |
|---|---|
| Space | Play / pause |
| ← → (Shift: 1 s) · Home / End | Step a frame · jump to start / end |
| Ctrl + mouse wheel | Zoom the timeline around the pointer (trackpad pinch too) |
| Shift + mouse wheel | Scroll the timeline sideways |
| + / − · Ctrl+= / Ctrl+− · Ctrl+0 · Shift+Z | Zoom the timeline in / out · reset zoom · fit the whole project |
| S | Split the selection (or the main clip) at the playhead |
| Ctrl+B | Split everything under the playhead |
| B | Razor tool: click a clip to cut it there |
| H · middle mouse drag | Hand tool: drag to pan the timeline |
| Delete · Shift+Delete · Esc | Delete · ripple delete · clear selection (or leave a tool) |
| M · F · N · G | Mute · freeze frame · snapping · preview guides |
| Ctrl+Z · Ctrl+Y (or Ctrl+Shift+Z) | Undo · redo |
| Ctrl+C · Ctrl+X · Ctrl+V | Copy · cut · paste at the playhead |
| Ctrl+D · Ctrl+A | Duplicate · select all |
| Ctrl+I · Ctrl+E | Import media · export |
| Ctrl+S · Ctrl+Shift+S · Ctrl+O · Ctrl+W · Ctrl+Q | Save · save as · open · close project · quit |

## Files

| File | What it does |
|---|---|
| `src/store.js` | Project model (seconds): main track, texts, layers, audio, timeline effects; undo/redo snapshots |
| `src/keyframes.js` | Keyframe values, easing curves (Bézier), splitting |
| `src/fx.js` | GPU colour grading, filters, chroma key and the effect catalogue (WebGL2) |
| `src/audiofx.js`, `src/voice-worklet.js` | Volume, fades, voice cleanup and voice effects (Web Audio + AudioWorklet), shared by preview and export |
| `src/segment.js` | Background removal for people (MediaPipe selfie segmenter) |
| `src/tts.js`, `src/tts-worker.js` | Text-to-speech (Kokoro-82M via kokoro-js) |
| `src/project-io.js` | Saving/opening `.cutline` projects, relinking media, autosave |
| `src/ui/*.js` | Inspector, timeline, effect/filter/audio/text catalogues, fonts, shared UI pieces |
| `src/engine.js` | Compositing, animation presets, text rendering, WebGL transition shaders, video sync |
| `src/export.js` | Offline audio mix + WebCodecs H.264/AAC encode → mp4-muxer |
| `src/decode.js` | mp4box demux + forward-only WebCodecs decoders that feed export frames |
| `src/captions.js`, `src/whisper-worker.js` | Whisper (transformers.js) in a worker; words → caption segments |
| `src/actions.js` | Editing commands: split, delete, clipboard, speed, transitions, playback clock |
| `src/app.js` | UI (React + htm): panels, preview transform overlay, timeline, shortcuts |
| `desktop/main.cjs`, `desktop/preload.cjs` | Desktop app (Electron): serves the editor and local media files, file dialogs, autosave |
| `server.mjs` | Run in a normal browser instead (`npm run web`) |
| `.github/workflows/release.yml` | Builds the Windows and Mac installers on each version tag |

## Known limits

- **Internet on first use:** the editor libraries, fonts and AI models (captions, voices, background removal) load online. After the first use the models are cached.
- **Fast export needs MP4/MOV clips** (H.264, HEVC, VP9 or AV1, if the computer can decode the codec). Other formats, such as WebM, export through a much slower seek-per-frame path.
- **Sped-up audio changes pitch in the exported file.** The live preview keeps the original pitch.
- **Volume above 100%, voice cleanup and voice effects** are heard in the preview once you've pressed play once (browsers only start audio processing after a click).
- **Background removal** handles people only (not arbitrary objects), and text-to-speech speaks English only.
- **Projects opened in the browser version** ask you to locate media files again; the desktop app remembers where they are.
- **Video formats:** anything Chromium plays works (H.264/HEVC/VP9/AV1 in MP4, MOV, MKV or WebM). Some ProRes, DNxHD and old camera formats can't be shown; Cutline says so on import, and converting them to MP4 (H.264) with HandBrake fixes it.
- **Installed fonts:** they appear automatically in the desktop app. In a browser, click **Show fonts installed on this computer** and allow it once.

## Third-party models and libraries

Cutline's own code is MIT. It downloads these at run time; none of them are bundled:

- [Whisper](https://huggingface.co/Xenova/whisper-tiny.en) via [Transformers.js](https://github.com/huggingface/transformers.js) (Apache-2.0)
- [Kokoro-82M](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) (Apache-2.0) via [kokoro-js](https://github.com/hexgrad/kokoro) (Apache-2.0), which uses espeak-ng (GPL-3.0) for pronunciation
- [MediaPipe selfie segmenter](https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter) (Apache-2.0)
- [Google Fonts](https://fonts.google.com) (SIL Open Font License)
- React, htm, mp4box.js and mp4-muxer (MIT/BSD)
