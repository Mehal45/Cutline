// Decoded audio for media files (cached), shared by the export mix, captions and loudness levelling.
import { loudnessGain } from "./audiofx.js";

const decoded = new Map(); // mediaId -> Promise<AudioBuffer | null>
const levels = new Map(); // mediaId -> gain (computed once per file)

export function decodeMedia(media) {
  if (!decoded.has(media.id)) {
    decoded.set(media.id, (async () => {
      if (media.kind !== "video" && media.kind !== "audio") return null;
      try {
        const ctx = new OfflineAudioContext(1, 1, 48000);
        return await ctx.decodeAudioData(await media.file.arrayBuffer());
      } catch {
        return null; // silent video
      }
    })());
  }
  return decoded.get(media.id);
}

/** Loudness-levelling gain for a whole file; null until it has been measured (measuring starts on first ask). */
export function levelFor(media) {
  if (levels.has(media.id)) return levels.get(media.id);
  levels.set(media.id, null);
  decodeMedia(media).then((buf) => levels.set(media.id, buf ? loudnessGain(buf) : 1));
  return null;
}
