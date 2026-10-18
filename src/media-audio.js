// Decoded audio for media files (cached), shared by the export mix, captions and loudness levelling.
import { loudnessGain } from "./audiofx.js";
import { byteSource, decodeBigAudio } from "./bigfile.js";

const decoded = new Map(); // mediaId -> Promise<AudioBuffer | null>
const levels = new Map(); // mediaId -> gain (computed once per file)

export function decodeMedia(media) {
  if (!decoded.has(media.id)) {
    decoded.set(media.id, (async () => {
      if (media.kind !== "video" && media.kind !== "audio") return null;
      // Big recordings: decoded a piece at a time (loading a multi-GB file whole would fail).
      const big = /\.(mkv|webm|mp4|m4v|mov)$/i.test(media.name) && (await byteSource(media).then((s) => s.size).catch(() => 0)) > (globalThis.CUTLINE_LAZY_BYTES ?? 512e6);
      if (big) return decodeBigAudio(media).catch((e) => { console.warn("audio", media.name, e); return null; });
      try {
        const ctx = new OfflineAudioContext(1, 1, 48000);
        return await ctx.decodeAudioData(await media.file.arrayBuffer());
      } catch {
        // Some containers the browser's decoder can't open whole; try reading the sound track directly.
        return decodeBigAudio(media).catch(() => null); // null = silent video
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
