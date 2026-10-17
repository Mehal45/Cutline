// Background removal for people: MediaPipe's selfie segmenter (Apache-2.0) runs on each frame and
// its mask becomes the clip's alpha. The model (~250 KB) and runtime load from the web on first use.
import { setState } from "./store.js";

const VISION = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
const MODEL = "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite";

let status = "idle"; // idle | loading | ready | failed
let segmenter = null;
let loading = null;

export const cutoutStatus = () => status;

/** Loads the segmenter once. Resolves true when ready. */
export function loadCutout() {
  loading ??= (async () => {
    status = "loading";
    setState({ cutoutStatus: status });
    try {
      const { FilesetResolver, ImageSegmenter } = await import(/* @vite-ignore */ `${VISION}/vision_bundle.mjs`);
      const files = await FilesetResolver.forVisionTasks(`${VISION}/wasm`);
      const make = (delegate) => ImageSegmenter.createFromOptions(files, {
        baseOptions: { modelAssetPath: MODEL, delegate },
        runningMode: "IMAGE",
        outputCategoryMask: false,
        outputConfidenceMasks: true,
      });
      segmenter = await make("GPU").catch(() => make("CPU"));
      status = "ready";
    } catch (err) {
      console.warn("Background removal unavailable:", err);
      status = "failed";
      loading = null; // allow a retry later
    }
    setState({ cutoutStatus: status });
    return status === "ready";
  })();
  return loading;
}

const cache = new Map(); // item id -> { key, canvas }
let input = null, maskCanvas = null;

/** Identifies the frame currently shown by a drawable, so a paused preview doesn't re-segment. */
function frameKey(el) {
  if (typeof VideoFrame !== "undefined" && el instanceof VideoFrame) return "f" + el.timestamp;
  if (el instanceof HTMLVideoElement) return "v" + el.currentTime + ":" + el.readyState;
  return "i" + (el.src || "");
}

/**
 * Returns a canvas of the source frame with the background made transparent, or null while the model
 * is loading (the clip then draws normally). item.cutout = { mode: "person", invert?, feather? }.
 */
export function cutoutFrame(item, el, sw, sh) {
  if (status !== "ready") { if (status === "idle") loadCutout(); return null; }
  const key = frameKey(el) + ":" + sw + "x" + sh + ":" + (item.cutout.invert ? 1 : 0) + ":" + (item.cutout.feather ?? 2);
  let entry = cache.get(item.id);
  if (entry?.key === key) return entry.canvas;
  try {
    // Segment a downscaled copy; the mask is then stretched back over the full frame.
    const scale = Math.min(1, 512 / Math.max(sw, sh));
    const iw = Math.max(1, Math.round(sw * scale)), ih = Math.max(1, Math.round(sh * scale));
    input ??= document.createElement("canvas");
    if (input.width !== iw || input.height !== ih) { input.width = iw; input.height = ih; }
    const ictx = input.getContext("2d", { willReadFrequently: false });
    ictx.drawImage(el, 0, 0, iw, ih);
    const result = segmenter.segment(input);
    const masks = result.confidenceMasks || [];
    const mask = masks[masks.length - 1]; // the person class is the last mask
    const mw = mask.width, mh = mask.height;
    const conf = mask.getAsFloat32Array();
    maskCanvas ??= document.createElement("canvas");
    if (maskCanvas.width !== mw || maskCanvas.height !== mh) { maskCanvas.width = mw; maskCanvas.height = mh; }
    const mctx = maskCanvas.getContext("2d");
    const img = mctx.createImageData(mw, mh);
    const inv = !!item.cutout.invert;
    for (let i = 0; i < conf.length; i++) {
      let a = Math.min(1, Math.max(0, (conf[i] - 0.3) / 0.4)); // soft threshold
      if (inv) a = 1 - a;
      img.data[i * 4 + 3] = a * 255;
    }
    mctx.putImageData(img, 0, 0);
    masks.forEach((m) => m.close());
    result.close?.();

    const out = entry?.canvas && entry.canvas.width === sw && entry.canvas.height === sh ? entry.canvas : new OffscreenCanvas(sw, sh);
    const octx = out.getContext("2d");
    octx.globalCompositeOperation = "copy";
    octx.drawImage(el, 0, 0, sw, sh);
    octx.globalCompositeOperation = "destination-in";
    const feather = item.cutout.feather ?? 2;
    octx.filter = feather > 0 ? `blur(${(feather * sw) / 1000}px)` : "none";
    octx.drawImage(maskCanvas, 0, 0, sw, sh);
    octx.filter = "none";
    octx.globalCompositeOperation = "source-over";
    cache.set(item.id, { key, canvas: out });
    return out;
  } catch (err) {
    console.warn("Cutout failed for a frame:", err);
    return null;
  }
}
