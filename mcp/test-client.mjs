// Smoke test: drives server.mjs over stdio like an assistant would.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
const dir = process.argv[2], face = process.argv[3], screen = process.argv[4];
const c = new Client({ name: "test", version: "1" });
await c.connect(new StdioClientTransport({ command: "node", args: [fileURLToPath(new URL("./server.mjs", import.meta.url))] }));
const call = async (name, args) => {
  const r = await c.callTool({ name, arguments: args });
  if (r.isError) throw new Error(name + ": " + r.content[0].text);
  const t = r.content.find((x) => x.type === "text")?.text;
  try { return JSON.parse(t); } catch { return { text: t, content: r.content }; }
};
const P = dir + "/t3.cutline";
console.log((await c.listTools()).tools.map((t) => t.name).join(", "));
await call("create_project", { project: P, overwrite: true });
const f = await call("add_media", { project: P, file: face });
const s = await call("add_media", { project: P, file: screen });
await call("add_background", { project: P, dur: 30, type: "glow", colors: ["#96121a", "#780a1e", "#be2a1e"], intensity: 0.9 });
await call("add_clip", { project: P, mediaId: f.mediaId, in: 0, dur: 6 });
const sc = await call("add_clip", { project: P, mediaId: s.mediaId, in: 28, dur: 9, props: {
  transition: { type: "crossfade", dur: 0.5 }, transform: { x: 0.5, y: 0.5, scale: 0.9, rotation: 0 },
  crop: { l: 0, t: 82 / 1080, r: 0, b: 64 / 1080 }, mask: { shape: "rect", x: 0.5, y: 549 / 1080, w: 1, h: 934 / 1080, radius: 0.035, feather: 0 },
  shadow: { blur: 90, y: 40, opacity: 0.75 }, border: { width: 1.5, color: "rgba(255,255,255,.12)" } } });
await call("zoom_inside_frame", { project: P, id: sc.id, at: 1.5, hold: 2, zoom: 1.4, focusX: 0.3, focusY: 0.45 });
await call("add_keyframes", { project: P, id: sc.id, keys: { tiltY: [{ t: 5.5, v: 0 }, { t: 7, v: -12 }, { t: 8.9, v: -10 }], tiltX: [{ t: 5.5, v: 0 }, { t: 7, v: 6 }] } });
await call("add_text", { project: P, text: "FREE", start: 1, dur: 4, y: 0.42, behind: true, style: { size: 520, weight: 900 }, anim: { in: { type: "pop", dur: 0.5 }, out: { type: "fade", dur: 0.4 } } });
console.log(JSON.stringify(await call("get_project", { project: P })).slice(0, 300));
const fr = await call("render_frame", { project: P, time: 9.2, out: dir + "/t3-9.2.png" });
console.log(fr.text || fr);
const fr2 = await call("render_frame", { project: P, time: 3, out: dir + "/t3-3.png" });
const job = await call("export", { project: P, out: dir + "/t3.mp4", opts: { fps: 60, quality: "max" } });
console.log(JSON.stringify(await call("export_status", { jobId: job.jobId, wait: true })));
await c.close();
