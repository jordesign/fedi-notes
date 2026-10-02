# fedi-notes

Static notes site that federates via ActivityPub. Handle: `@notes@fedi-notes.view.fast`.

## Post a note

1. Add `posts/<yyyy-mm-dd-slug>.md` with front matter `date:` (optional `updated:` for edits). For photos, repeat `image: /media/x.jpg` + `alt: …` pairs (alt is required; up to 4 show as an album). `#hashtags` in the text become tags and `/tags/<tag>/` pages.
2. `node build.mjs` (writes `index.html`, `notes/*/`, `lib/notes.gen.ts`).
3. `git commit` → `sf publish . --json`.
4. `curl https://fedi-notes.view.fast/ap/deliver`, or wait for the 10-minute cron.

Delivery is idempotent. New notes send Create, changed notes send Update, and deleted post files send Delete.

## How it works

- Static HTML wins for GET. Anything else goes to `handler.ts` (a Functions worker).
- The worker handles webfinger, the actor, outbox, and note objects. The inbox takes Follow, Undo, Like, Announce, replies, and Delete, all signature-verified.
- The DB (`env.DB`, MySQL behind a D1-shaped API) holds `followers`, `deliveries`, and `interactions`.
- Key: `public.pem` is committed. The private key lives in `.env.server` as `AP_PRIVATE_KEY` (base64 PKCS#8) and syncs as a secret on publish.
- Note pages carry `<link rel="alternate" type="application/activity+json">`, so pasting a note URL into Mastodon search resolves it.
- Feeds: `/feed.xml` (RSS with `media:content`) and `/feed.json` (JSON Feed with attachments), built alongside the HTML.
- Debug: `/ap/status`, `sf logs runtime`.

## Limits / next

- Handle is tied to the domain. Move to a custom domain before real use.
- No mentions or content warnings yet. Reply threads aren't fetched. Images aren't resized at build time; keep them under ~2 MB.
