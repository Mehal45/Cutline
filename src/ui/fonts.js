// Title fonts. System fonts work offline; the rest are Google Fonts (SIL Open Font License), loaded on demand.
export const FONTS = [
  { name: "Inter", css: "Inter, Arial, sans-serif", web: "Inter:wght@300..900" },
  { name: "Arial / system", css: "Arial, Helvetica, sans-serif" },
  { name: "Georgia", css: "Georgia, serif" },
  { name: "Impact", css: "Impact, sans-serif" },
  { name: "Comic Sans", css: "'Comic Sans MS', cursive" },
  { name: "Courier New", css: "'Courier New', monospace" },
  { name: "Montserrat", css: "'Montserrat', sans-serif", web: "Montserrat:ital,wght@0,300..900;1,300..900" },
  { name: "Poppins", css: "'Poppins', sans-serif", web: "Poppins:ital,wght@0,300;0,400;0,600;0,700;0,900;1,700" },
  { name: "Oswald", css: "'Oswald', sans-serif", web: "Oswald:wght@300..700" },
  { name: "Bebas Neue", css: "'Bebas Neue', sans-serif", web: "Bebas+Neue" },
  { name: "Anton", css: "'Anton', sans-serif", web: "Anton" },
  { name: "Archivo Black", css: "'Archivo Black', sans-serif", web: "Archivo+Black" },
  { name: "Space Grotesk", css: "'Space Grotesk', sans-serif", web: "Space+Grotesk:wght@300..700" },
  { name: "Rubik", css: "'Rubik', sans-serif", web: "Rubik:ital,wght@0,300..900;1,300..900" },
  { name: "Playfair Display", css: "'Playfair Display', serif", web: "Playfair+Display:ital,wght@0,400..900;1,400..900" },
  { name: "DM Serif Display", css: "'DM Serif Display', serif", web: "DM+Serif+Display:ital@0;1" },
  { name: "Abril Fatface", css: "'Abril Fatface', serif", web: "Abril+Fatface" },
  { name: "Roboto Slab", css: "'Roboto Slab', serif", web: "Roboto+Slab:wght@300..900" },
  { name: "Staatliches", css: "'Staatliches', sans-serif", web: "Staatliches" },
  { name: "Righteous", css: "'Righteous', sans-serif", web: "Righteous" },
  { name: "Bangers", css: "'Bangers', cursive", web: "Bangers" },
  { name: "Black Ops One", css: "'Black Ops One', cursive", web: "Black+Ops+One" },
  { name: "Permanent Marker", css: "'Permanent Marker', cursive", web: "Permanent+Marker" },
  { name: "Pacifico", css: "'Pacifico', cursive", web: "Pacifico" },
  { name: "Lobster", css: "'Lobster', cursive", web: "Lobster" },
  { name: "Dancing Script", css: "'Dancing Script', cursive", web: "Dancing+Script:wght@400..700" },
  { name: "Caveat Brush", css: "'Caveat Brush', cursive", web: "Caveat+Brush" },
  { name: "Shadows Into Light", css: "'Shadows Into Light Two', cursive", web: "Shadows+Into+Light+Two" },
  { name: "Pixelify Sans", css: "'Pixelify Sans', sans-serif", web: "Pixelify+Sans:wght@400..700" },
  { name: "Press Start 2P", css: "'Press Start 2P', monospace", web: "Press+Start+2P" },
  { name: "Noto Sans (Hindi & more)", css: "'Noto Sans', 'Noto Sans Devanagari', sans-serif", web: "Noto+Sans:ital,wght@0,300..900;1,300..900&family=Noto+Sans+Devanagari:wght@300..900" },
  { name: "Tiro Devanagari Hindi", css: "'Tiro Devanagari Hindi', serif", web: "Tiro+Devanagari+Hindi" },
];

let linked = false;
/** Adds the Google Fonts stylesheet (once). Fonts then download only when used. */
export function linkWebFonts() {
  if (linked) return;
  linked = true;
  const families = FONTS.filter((f) => f.web).map((f) => "family=" + f.web).join("&");
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `https://fonts.googleapis.com/css2?${families}&display=swap`;
  document.head.appendChild(link);
}

/** Makes sure a font face is downloaded before canvas text uses it. */
export function loadFont(css, weight = 400, italic = false) {
  linkWebFonts();
  const first = css.split(",")[0].trim();
  return document.fonts.load(`${italic ? "italic " : ""}${weight} 48px ${first}`, "Aa").catch(() => {});
}

/** Loads every font a project's texts use (call before export). */
export function loadProjectFonts(project) {
  return Promise.all(project.texts.map((t) => loadFont(t.style.font, t.style.weight, t.style.italic)));
}
