// ActivityPub for a static notes site. Static files (HTML notes) win; everything else lands here.
import { NOTES, PUBLIC_KEY_PEM, SITE, type Note } from "./lib/notes.gen";
import { all, ensureSchema, run, tryInsert, type DB } from "./lib/db";
import { loadPrivateKey, signedFetch, verifyRequest } from "./lib/httpsig";

type Env = { DB: DB; AP_PRIVATE_KEY?: string };

const BASE = SITE.url.replace(/\/$/, "");
const HOST = new URL(BASE).host;
const ACTOR = `${BASE}/ap/actor`;
const KEY_ID = `${ACTOR}#main-key`;
const FOLLOWERS = `${BASE}/ap/followers`;
const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";
const AS = "https://www.w3.org/ns/activitystreams";
const HANDLE = `@${SITE.username}@${HOST}`;

const noteId = (n: Note) => `${BASE}/ap/notes/${n.id}`;

// ---------- responses ----------

const cors = { "access-control-allow-origin": "*" };

const ap = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/activity+json; charset=utf-8", ...cors },
  });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...cors } });

const text = (body: string, status: number) => new Response(body, { status, headers: cors });

// ---------- documents ----------

function actorDoc() {
  return {
    "@context": [AS, "https://w3id.org/security/v1", { toot: "http://joinmastodon.org/ns#", discoverable: "toot:discoverable" }],
    id: ACTOR,
    type: "Person",
    preferredUsername: SITE.username,
    name: SITE.name,
    summary: SITE.summary,
    url: `${BASE}/`,
    inbox: `${BASE}/ap/inbox`,
    outbox: `${BASE}/ap/outbox`,
    followers: FOLLOWERS,
    following: `${BASE}/ap/following`,
    endpoints: { sharedInbox: `${BASE}/ap/inbox` },
    manuallyApprovesFollowers: false,
    discoverable: true,
    published: SITE.published,
    ...(SITE.icon ? { icon: { type: "Image", mediaType: "image/png", url: `${BASE}${SITE.icon}` } } : {}),
    publicKey: { id: KEY_ID, owner: ACTOR, publicKeyPem: PUBLIC_KEY_PEM },
  };
}

function noteObject(n: Note) {
  return {
    id: noteId(n),
    type: "Note",
    attributedTo: ACTOR,
    content: n.html,
    published: n.published,
    ...(n.updated ? { updated: n.updated } : {}),
    url: `${BASE}/notes/${n.id}/`,
    ...(n.images.length
      ? { attachment: n.images.map((i) => ({ type: "Image", mediaType: i.mediaType, url: `${BASE}${i.url}`, name: i.alt, width: i.width, height: i.height })) }
      : {}),
    ...(n.tags.length ? { tag: n.tags.map((t) => ({ type: "Hashtag", href: `${BASE}/tags/${t}`, name: `#${t}` })) } : {}),
    sensitive: false,
    to: [PUBLIC],
    cc: [FOLLOWERS],
  };
}

function wrap(type: "Create" | "Update", n: Note, suffix = "") {
  return {
    "@context": AS,
    id: `${noteId(n)}/${type.toLowerCase()}${suffix}`,
    type,
    actor: ACTOR,
    published: type === "Create" ? n.published : new Date().toISOString(),
    to: [PUBLIC],
    cc: [FOLLOWERS],
    object: noteObject(n),
  };
}

// ---------- remote fetches ----------

async function fetchRemote(env: Env, url: string) {
  const key = await loadPrivateKey(env.AP_PRIVATE_KEY!);
  const res = await signedFetch(url, {}, KEY_ID, key); // signed GET: authorized-fetch instances require it
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
  return res.json<any>();
}

async function send(env: Env, inbox: string, activity: unknown) {
  const key = await loadPrivateKey(env.AP_PRIVATE_KEY!);
  const res = await signedFetch(inbox, { method: "POST", body: JSON.stringify(activity) }, KEY_ID, key);
  if (!res.ok && res.status !== 202) throw new Error(`${inbox} → ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.status;
}

const handleOf = (doc: any) => (doc?.preferredUsername ? `@${doc.preferredUsername}@${new URL(doc.id).host}` : doc?.id ?? "");

// ---------- inbox ----------

const ours = (id: unknown) => {
  const s = typeof id === "string" ? id : (id as any)?.id;
  const m = typeof s === "string" && s.match(new RegExp(`^${BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/ap/notes/([^/#?]+)`));
  return m ? m[1] : null;
};

async function inbox(request: Request, env: Env) {
  const body = await request.text();
  if (body.length > 256_000) return text("Too large", 413);
  let activity: any;
  try {
    activity = JSON.parse(body);
  } catch {
    return text("Bad JSON", 400);
  }

  let verified;
  try {
    verified = await verifyRequest(request, body, HOST, (u) => fetchRemote(env, u));
  } catch (e) {
    // Deletes of vanished accounts can never verify (their key 410s). Drop them quietly.
    if (activity?.type === "Delete") return text("", 202);
    console.log("inbox reject", activity?.type, activity?.actor, String(e));
    return text(`Signature: ${e}`, 401);
  }
  const actorId = typeof activity.actor === "string" ? activity.actor : activity.actor?.id;
  if (verified.keyOwner !== actorId) return text("Actor/key mismatch", 401);
  const who = verified.actorDoc;
  const now = new Date().toISOString();
  console.log("inbox", activity.type, actorId);

  await ensureSchema(env.DB);
  const obj = activity.object;

  switch (activity.type) {
    case "Follow": {
      if ((typeof obj === "string" ? obj : obj?.id) !== ACTOR) return text("Not us", 400);
      const inboxUrl = who.inbox;
      const shared = who.endpoints?.sharedInbox ?? null;
      if (!(await tryInsert(env.DB, "INSERT INTO followers (actor, inbox, shared_inbox, handle, created_at) VALUES (?, ?, ?, ?, ?)", actorId, inboxUrl, shared, handleOf(who), now)))
        await run(env.DB, "UPDATE followers SET inbox = ?, shared_inbox = ?, handle = ? WHERE actor = ?", inboxUrl, shared, handleOf(who), actorId);
      await send(env, inboxUrl, {
        "@context": AS,
        id: `${ACTOR}#accept-${crypto.randomUUID()}`,
        type: "Accept",
        actor: ACTOR,
        object: activity,
      });
      return text("", 202);
    }
    case "Undo": {
      if (obj?.type === "Follow") await run(env.DB, "DELETE FROM followers WHERE actor = ?", actorId);
      else if (obj?.type === "Like" || obj?.type === "Announce")
        await run(env.DB, "DELETE FROM interactions WHERE id = ? AND actor = ?", typeof obj === "string" ? obj : obj.id, actorId);
      return text("", 202);
    }
    case "Like":
    case "Announce": {
      const nid = ours(obj);
      if (nid)
        await tryInsert(env.DB, "INSERT INTO interactions (id, note_id, kind, actor, handle, url, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          activity.id, nid, activity.type === "Like" ? "like" : "boost", actorId, handleOf(who), who.url ?? actorId, null, now);
      return text("", 202);
    }
    case "Create": {
      const nid = ours(obj?.inReplyTo);
      if (nid && obj?.id)
        await tryInsert(env.DB, "INSERT INTO interactions (id, note_id, kind, actor, handle, url, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          obj.id, nid, "reply", actorId, handleOf(who), obj.url ?? obj.id, String(obj.content ?? "").slice(0, 5000), now);
      return text("", 202);
    }
    case "Delete": {
      const id = typeof obj === "string" ? obj : obj?.id;
      if (id === actorId) await run(env.DB, "DELETE FROM followers WHERE actor = ?", actorId);
      else await run(env.DB, "DELETE FROM interactions WHERE id = ? AND actor = ?", id, actorId);
      return text("", 202);
    }
    default:
      return text("", 202);
  }
}

// ---------- delivery ----------

/**
 * Idempotent fan-out. Compares the notes baked into this version with what has been delivered:
 * new → Create, changed → Update, gone → Delete. Safe for anyone (or the cron) to trigger.
 */
async function deliver(env: Env) {
  await ensureSchema(env.DB);
  const followers = await all<{ inbox: string; shared_inbox: string | null }>(env.DB, "SELECT inbox, shared_inbox FROM followers");
  const inboxes = [...new Set(followers.map((f) => f.shared_inbox || f.inbox))];
  const done = new Map((await all<{ note_id: string; hash: string; status: string }>(env.DB, "SELECT note_id, hash, status FROM deliveries")).map((r) => [r.note_id, r]));
  const now = new Date().toISOString();
  const report: any[] = [];

  const fanout = async (label: string, id: string, activity: unknown) => {
    const results = await Promise.allSettled(inboxes.map((i) => send(env, i, activity)));
    const failed = results.flatMap((r, i) => (r.status === "rejected" ? [`${inboxes[i]}: ${r.reason}`] : []));
    report.push({ note: id, action: label, inboxes: inboxes.length, failed });
    return failed.join("\n").slice(0, 4000) || null;
  };

  for (const n of [...NOTES].sort((a, b) => a.published.localeCompare(b.published))) {
    const prev = done.get(n.id);
    if (!prev) {
      // Claim first so two concurrent runs can't both send.
      if (!(await tryInsert(env.DB, "INSERT INTO deliveries (note_id, hash, status, detail, updated_at) VALUES (?, ?, ?, ?, ?)", n.id, n.hash, "sending", null, now))) continue;
      const failed = await fanout("create", n.id, wrap("Create", n));
      await run(env.DB, "UPDATE deliveries SET status = ?, detail = ? WHERE note_id = ?", "sent", failed, n.id);
    } else if (prev.hash !== n.hash && prev.status !== "deleted") {
      await run(env.DB, "UPDATE deliveries SET hash = ?, updated_at = ? WHERE note_id = ?", n.hash, now, n.id);
      const failed = await fanout("update", n.id, wrap("Update", n, `-${n.hash.slice(0, 12)}`));
      await run(env.DB, "UPDATE deliveries SET status = ?, detail = ? WHERE note_id = ?", "sent", failed, n.id);
    }
  }

  const live = new Set(NOTES.map((n) => n.id));
  for (const [id, row] of done) {
    if (live.has(id) || row.status === "deleted") continue;
    await run(env.DB, "UPDATE deliveries SET status = ?, updated_at = ? WHERE note_id = ?", "deleted", now, id);
    const oid = `${BASE}/ap/notes/${id}`;
    await fanout("delete", id, { "@context": AS, id: `${oid}/delete`, type: "Delete", actor: ACTOR, to: [PUBLIC], cc: [FOLLOWERS], object: { id: oid, type: "Tombstone" } });
  }

  return { followers: followers.length, inboxes: inboxes.length, actions: report };
}

// ---------- router ----------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors, "access-control-allow-headers": "*" } });

    try {
      if (path === "/.well-known/webfinger") {
        const r = (url.searchParams.get("resource") ?? "").toLowerCase();
        const ok = [`acct:${SITE.username}@${HOST}`, ACTOR.toLowerCase(), `${BASE}/`.toLowerCase(), BASE.toLowerCase()];
        if (!ok.includes(r)) return text("Not found", 404);
        return new Response(
          JSON.stringify({
            subject: `acct:${SITE.username}@${HOST}`,
            aliases: [ACTOR, `${BASE}/`],
            links: [
              { rel: "self", type: "application/activity+json", href: ACTOR },
              { rel: "http://webfinger.net/rel/profile-page", type: "text/html", href: `${BASE}/` },
            ],
          }),
          { headers: { "content-type": "application/jrd+json", ...cors } },
        );
      }

      if (path === "/.well-known/nodeinfo")
        return json({ links: [{ rel: "http://nodeinfo.diaspora.software/ns/schema/2.0", href: `${BASE}/ap/nodeinfo` }] });
      if (path === "/ap/nodeinfo")
        return json({
          version: "2.0",
          software: { name: "fedi-notes", version: "0.1.0" },
          protocols: ["activitypub"],
          services: { inbound: [], outbound: [] },
          openRegistrations: false,
          usage: { users: { total: 1 }, localPosts: NOTES.length },
          metadata: {},
        });

      if (path === "/ap/actor" || path === `/@${SITE.username}`) return ap(actorDoc());

      if ((path === "/ap/inbox" || path === "/ap/actor/inbox") && request.method === "POST") return await inbox(request, env);

      if (path === "/ap/outbox") {
        const items = [...NOTES].sort((a, b) => b.published.localeCompare(a.published)).map((n) => wrap("Create", n));
        return ap({ "@context": AS, id: `${BASE}/ap/outbox`, type: "OrderedCollection", totalItems: items.length, orderedItems: items });
      }

      if (path === "/ap/followers") {
        await ensureSchema(env.DB);
        const [{ n }] = await all<{ n: number }>(env.DB, "SELECT COUNT(*) AS n FROM followers");
        return ap({ "@context": AS, id: FOLLOWERS, type: "OrderedCollection", totalItems: Number(n) });
      }
      if (path === "/ap/following") return ap({ "@context": AS, id: `${BASE}/ap/following`, type: "OrderedCollection", totalItems: 0, orderedItems: [] });

      let m = path.match(/^\/ap\/notes\/([^/]+)(?:\/(create))?$/);
      if (m) {
        const n = NOTES.find((x) => x.id === m![1]);
        if (!n) return text("Gone", 410);
        return ap(m[2] ? wrap("Create", n) : { "@context": AS, ...noteObject(n) });
      }

      if (path === "/ap/deliver") return json(await deliver(env));

      // Temporary probe: logs (privately, to `sf logs runtime`) what a request carries when the visitor
      // is signed in to Spacefast. Cookie values and credentials are never logged; nothing is echoed back.
      if (path === "/ap/whoami") {
        const headers = [...request.headers].map(([k, v]) =>
          k === "cookie" ? `${k}: [${v.split(";").map((c) => c.split("=")[0].trim()).join(", ")}]` : /authorization|signature|token|secret|key/i.test(k) ? `${k}: (redacted, ${v.length} chars)` : `${k}: ${v}`,
        );
        console.log("whoami", JSON.stringify({ headers, envKeys: Object.keys(env) }));
        return text("Logged. Thanks!", 200);
      }

      m = path.match(/^\/ap\/interactions\/([^/]+)$/);
      if (m) {
        await ensureSchema(env.DB);
        const rows = await all(env.DB, "SELECT kind, handle, url, content, created_at FROM interactions WHERE note_id = ? ORDER BY created_at", m[1]);
        return json({
          likes: rows.filter((r) => r.kind === "like").length,
          boosts: rows.filter((r) => r.kind === "boost").length,
          replies: rows.filter((r) => r.kind === "reply").map(({ handle, url, content, created_at }) => ({ handle, url, content, created_at })),
        });
      }

      if (path === "/ap/status") {
        await ensureSchema(env.DB);
        const [{ n }] = await all<{ n: number }>(env.DB, "SELECT COUNT(*) AS n FROM followers");
        const deliveries = await all(env.DB, "SELECT note_id, status, updated_at FROM deliveries ORDER BY updated_at DESC");
        return json({ handle: HANDLE, followers: Number(n), notes: NOTES.length, deliveries, keyConfigured: Boolean(env.AP_PRIVATE_KEY) });
      }

      return text("Not found", 404);
    } catch (e) {
      console.log("error", path, String(e), (e as Error)?.stack);
      return text("Server error", 500);
    }
  },
};
