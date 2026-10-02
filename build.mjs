// Build: posts/*.md → static HTML pages + lib/notes.gen.ts (bundled into the worker).
// `node build.mjs --keygen` creates the actor keypair once.
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";

const site = JSON.parse(readFileSync("site.config.json", "utf8"));
const BASE = site.url.replace(/\/$/, "");
const HOST = new URL(BASE).host;
const HANDLE = `@${site.username}@${HOST}`;

if (process.argv.includes("--keygen")) {
  if (existsSync("public.pem")) throw new Error("public.pem exists; delete it (and AP_PRIVATE_KEY) to rotate");
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  writeFileSync("public.pem", publicKey.export({ type: "spki", format: "pem" }));
  const der = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  appendFileSync(".env.server", `AP_PRIVATE_KEY=${der}\n`, { mode: 0o600 });
  console.log("wrote public.pem and AP_PRIVATE_KEY in .env.server");
  process.exit(0);
}

// ---------- tiny markdown ----------

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(s) {
  const links = [];
  const hold = (html) => `\u0000${links.push(html) - 1}\u0000`;
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t, u) => hold(`<a href="${esc(u)}">${esc(t)}</a>`));
  s = s.replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)]/g, (u) => hold(`<a href="${esc(u)}">${esc(u.replace(/^https?:\/\//, ""))}</a>`));
  s = s.replace(/`([^`]+)`/g, (_, c) => hold(`<code>${esc(c)}</code>`));
  s = s.replace(/(^|\s)#([\p{L}\p{N}_]+)/gu, (_, sp, t) => sp + hold(`<a href="${BASE}/tags/${esc(t.toLowerCase())}" class="mention hashtag" rel="tag">#<span>${esc(t)}</span></a>`));
  s = esc(s)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => links[i]);
}

const render = (md) =>
  md.trim().split(/\n\s*\n/).map((p) => `<p>${p.split("\n").map(inline).join("<br>")}</p>`).join("");

// ---------- read posts ----------

const TYPES = { gif: "image/gif", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };
const mediaType = (u) => TYPES[u.split(".").pop().toLowerCase()] ?? "application/octet-stream";

// Pixel size from the file header, so Mastodon/Pixelfed can lay out albums before images load.
function dimensions(file) {
  const b = readFileSync(file);
  if (b.toString("ascii", 1, 4) === "PNG") return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.toString("ascii", 0, 3) === "GIF") return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b.toString("ascii", 8, 12) === "WEBP") {
    const kind = b.toString("ascii", 12, 16);
    if (kind === "VP8X") return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (kind === "VP8L") { const v = b.readUInt32LE(21); return { width: 1 + (v & 0x3fff), height: 1 + ((v >> 14) & 0x3fff) }; }
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  for (let i = 2; i < b.length; ) {
    // JPEG: walk segments to the first start-of-frame marker.
    const marker = b[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
    i += 2 + b.readUInt16BE(i + 2);
  }
  throw new Error(`${file}: can't read image size`);
}

const tagsOf = (md) => [...new Set([...md.matchAll(/(?:^|\s)#([\p{L}\p{N}_]+)/gu)].map((m) => m[1].toLowerCase()))];

const notes = readdirSync("posts")
  .filter((f) => f.endsWith(".md"))
  .map((f) => {
    const raw = readFileSync(`posts/${f}`, "utf8");
    const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!m) throw new Error(`${f}: missing front matter`);
    // `image:` and `alt:` may repeat (an album); each alt belongs to the image above it.
    const meta = {};
    const images = [];
    for (const line of m[1].split("\n")) {
      const [k, v = ""] = line.split(/:\s*(.*)/s);
      if (k === "image") images.push({ url: v.trim(), alt: "" });
      else if (k === "alt" && images.length) images[images.length - 1].alt = v.trim();
      else meta[k] = v;
    }
    if (!meta.date) throw new Error(`${f}: missing date`);
    for (const img of images) {
      if (!existsSync(`.${img.url}`)) throw new Error(`${f}: missing ${img.url}`);
      if (!img.alt) throw new Error(`${f}: ${img.url} needs alt text`);
      Object.assign(img, { mediaType: mediaType(img.url) }, dimensions(`.${img.url}`));
    }
    const tags = tagsOf(m[2]);
    const html = render(m[2]);
    const note = {
      id: f.replace(/\.md$/, ""),
      published: new Date(meta.date).toISOString(),
      ...(meta.updated ? { updated: new Date(meta.updated).toISOString() } : {}),
      html,
      text: m[2].trim(),
      tags,
      images,
    };
    note.hash = createHash("sha256").update(html + (note.updated ?? "") + (images.length ? JSON.stringify(images) : "")).digest("hex");
    return note;
  })
  .sort((a, b) => b.published.localeCompare(a.published));

if (!existsSync("public.pem")) throw new Error("no public.pem: run `node build.mjs --keygen` first");

writeFileSync(
  "lib/notes.gen.ts",
  `// Generated by build.mjs. Do not edit.
export type Image = { url: string; alt: string; mediaType: string; width: number; height: number };
export type Note = { id: string; published: string; updated?: string; html: string; text: string; tags: string[]; hash: string; images: Image[] };
export const SITE = ${JSON.stringify(site, null, 2)} as { url: string; username: string; name: string; summary: string; published: string; icon?: string };
export const PUBLIC_KEY_PEM = ${JSON.stringify(readFileSync("public.pem", "utf8"))};
export const NOTES: Note[] = ${JSON.stringify(notes, null, 2)};
`,
);

// ---------- pages ----------

const fmt = (iso) => new Date(iso).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short", timeZone: site.timeZone ?? "UTC" });

const page = ({ title, alternate, body }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="alternate" type="application/activity+json" href="${alternate}">
<link rel="alternate" type="application/rss+xml" title="${esc(site.name)}" href="${BASE}/feed.xml">
<link rel="alternate" type="application/feed+json" title="${esc(site.name)}" href="${BASE}/feed.json">
<meta name="fediverse:creator" content="${HANDLE.slice(1)}">
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header class="me">
  <a class="name" href="/">${esc(site.name)}</a>
  <button class="handle" type="button" title="Copy handle" data-copy="${HANDLE}">${HANDLE}</button>
</header>
<main>
${body}
</main>
<footer>Follow ${HANDLE} from Mastodon, Pixelfed or any Fediverse app, or subscribe by <a href="/feed.xml">RSS</a> / <a href="/feed.json">JSON Feed</a>. Static HTML on Spacefast, plus a small ActivityPub worker.</footer>
<script>
document.querySelectorAll("[data-copy]").forEach((b) => b.onclick = async () => {
  try { await navigator.clipboard.writeText(b.dataset.copy); b.classList.add("copied"); setTimeout(() => b.classList.remove("copied"), 1200); } catch {}
});
</script>
</body>
</html>
`;

const card = (n, link) => `<article class="note">
  <div class="body">${n.html}</div>
  ${n.images.length ? `<div class="album" data-count="${Math.min(n.images.length, 4)}">${n.images.map((i) => `<img class="media" src="${esc(i.url)}" alt="${esc(i.alt)}" width="${i.width}" height="${i.height}" loading="lazy">`).join("")}</div>` : ""}
  <a class="meta" href="/notes/${n.id}/"${link ? "" : ' aria-current="page"'}><time datetime="${n.published}">${fmt(n.published)}</time>${n.updated ? " · edited" : ""}</a>
</article>`;

rmSync("notes", { recursive: true, force: true });
for (const n of notes) {
  mkdirSync(`notes/${n.id}`, { recursive: true });
  const title = n.html.replace(/<[^>]+>/g, "").slice(0, 60);
  writeFileSync(
    `notes/${n.id}/index.html`,
    page({
      title: `${title} · ${site.name}`,
      alternate: `${BASE}/ap/notes/${n.id}`,
      body: `${card(n, false)}
<section class="reactions" data-note="${n.id}" hidden>
  <p class="counts"></p>
  <ol class="replies"></ol>
</section>
<script>
(async () => {
  const el = document.querySelector(".reactions");
  const r = await fetch("/ap/interactions/" + el.dataset.note).then((r) => r.ok ? r.json() : null).catch(() => null);
  if (!r || (!r.likes && !r.boosts && !r.replies.length)) return;
  const plural = (n, w) => n + " " + w + (n === 1 ? "" : "s");
  el.querySelector(".counts").textContent = [plural(r.likes, "like"), plural(r.boosts, "boost"), plural(r.replies.length, "reply").replace("replys", "replies")].join(" · ");
  const ol = el.querySelector(".replies");
  for (const x of r.replies) {
    const li = document.createElement("li");
    const a = Object.assign(document.createElement("a"), { href: x.url, textContent: x.handle });
    const p = document.createElement("p");
    p.textContent = new DOMParser().parseFromString(x.content, "text/html").body.textContent;
    li.append(a, p);
    ol.append(li);
  }
  el.hidden = false;
})();
</script>`,
    }),
  );
}

rmSync("tags", { recursive: true, force: true });
for (const t of new Set(notes.flatMap((n) => n.tags))) {
  mkdirSync(`tags/${t}`, { recursive: true });
  writeFileSync(
    `tags/${t}/index.html`,
    page({ title: `#${t} · ${site.name}`, alternate: `${BASE}/ap/actor`, body: `<p class="summary">Tagged #${esc(t)}</p>\n${notes.filter((n) => n.tags.includes(t)).map((n) => card(n, true)).join("\n")}` }),
  );
}

writeFileSync(
  "index.html",
  page({
    title: site.name,
    alternate: `${BASE}/ap/actor`,
    body: `<p class="summary">${esc(site.summary)}</p>
${notes.map((n) => card(n, true)).join("\n")}`,
  }),
);

// ---------- feeds ----------

const xml = (s) => esc(s).replace(/'/g, "&apos;");
const abs = (u) => `${BASE}${u}`;
const titleOf = (n) => n.text.split("\n")[0].replace(/[*`#]/g, "").slice(0, 80) || "Photo";
const feedHtml = (n) => n.html + n.images.map((i) => `<p><img src="${abs(i.url)}" alt="${esc(i.alt)}" width="${i.width}" height="${i.height}"></p>`).join("");

writeFileSync(
  "feed.xml",
  `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
<channel>
<title>${xml(site.name)}</title>
<link>${BASE}/</link>
<description>${xml(site.summary)}</description>
<atom:link href="${BASE}/feed.xml" rel="self" type="application/rss+xml"/>
${notes.slice(0, 50).map((n) => `<item>
<title>${xml(titleOf(n))}</title>
<link>${BASE}/notes/${n.id}/</link>
<guid isPermaLink="true">${BASE}/notes/${n.id}/</guid>
<pubDate>${new Date(n.published).toUTCString()}</pubDate>
${n.tags.map((t) => `<category>${xml(t)}</category>`).join("")}
<description>${xml(feedHtml(n))}</description>
${n.images.map((i, k) => `${k ? "" : `<enclosure url="${abs(i.url)}" length="${statSync(`.${i.url}`).size}" type="${i.mediaType}"/>\n`}<media:content url="${abs(i.url)}" type="${i.mediaType}" medium="image" width="${i.width}" height="${i.height}"><media:description type="plain">${xml(i.alt)}</media:description></media:content>`).join("\n")}
</item>`).join("\n")}
</channel>
</rss>
`,
);

writeFileSync(
  "feed.json",
  JSON.stringify(
    {
      version: "https://jsonfeed.org/version/1.1",
      title: site.name,
      home_page_url: `${BASE}/`,
      feed_url: `${BASE}/feed.json`,
      description: site.summary,
      authors: [{ name: site.name, url: `${BASE}/` }],
      items: notes.slice(0, 50).map((n) => ({
        id: `${BASE}/notes/${n.id}/`,
        url: `${BASE}/notes/${n.id}/`,
        content_html: feedHtml(n),
        date_published: n.published,
        ...(n.updated ? { date_modified: n.updated } : {}),
        ...(n.images[0] ? { image: abs(n.images[0].url) } : {}),
        ...(n.tags.length ? { tags: n.tags } : {}),
        ...(n.images.length ? { attachments: n.images.map((i) => ({ url: abs(i.url), mime_type: i.mediaType, title: i.alt, size_in_bytes: statSync(`.${i.url}`).size })) } : {}),
      })),
    },
    null,
    2,
  ),
);

console.log(`built ${notes.length} notes for ${HANDLE}`);
