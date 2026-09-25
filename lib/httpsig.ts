// HTTP Signatures (draft-cavage, rsa-sha256): the dialect Mastodon and most of the Fediverse speak.

const enc = new TextEncoder();

const b64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const pemBody = (pem: string) => pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");

const RSA = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

let privateKey: Promise<CryptoKey> | null = null;

// AP_PRIVATE_KEY is base64 PKCS#8 DER on one line, so it survives .env files.
export function loadPrivateKey(b64pkcs8: string) {
  privateKey ??= crypto.subtle.importKey("pkcs8", unb64(b64pkcs8.trim()), RSA, false, ["sign"]);
  return privateKey;
}

export async function digest(body: string) {
  return "SHA-256=" + b64(await crypto.subtle.digest("SHA-256", enc.encode(body)));
}

/** fetch() with a signature from our actor's key. */
export async function signedFetch(
  url: string,
  init: { method?: "GET" | "POST"; body?: string; accept?: string },
  keyId: string,
  key: CryptoKey,
) {
  const u = new URL(url);
  const method = init.method ?? "GET";
  const headers: Record<string, string> = {
    host: u.host,
    date: new Date().toUTCString(),
    accept: init.accept ?? 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
    "user-agent": "fedi-notes/0.1 (+https://spacefast.com)",
  };
  const signed = ["(request-target)", "host", "date"];
  if (init.body !== undefined) {
    headers["content-type"] = "application/activity+json";
    headers.digest = await digest(init.body);
    signed.push("digest", "content-type");
  }
  const target = `${method.toLowerCase()} ${u.pathname}${u.search}`;
  const str = signed.map((h) => `${h}: ${h === "(request-target)" ? target : headers[h]}`).join("\n");
  const sig = b64(await crypto.subtle.sign(RSA, key, enc.encode(str)));
  headers.signature = `keyId="${keyId}",algorithm="rsa-sha256",headers="${signed.join(" ")}",signature="${sig}"`;
  const { host, ...sendHeaders } = headers; // fetch sets Host itself
  return fetch(url, { method, headers: sendHeaders, body: init.body, signal: AbortSignal.timeout(10_000) });
}

function parseSignature(header: string) {
  const out: Record<string, string> = {};
  for (const m of header.matchAll(/(\w+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

export type Verified = { keyOwner: string; actorDoc: any };

/**
 * Verify an incoming signed request. Returns the key's owner and the fetched actor document.
 * `publicHost` is used for the `host` header because a proxy may rewrite it.
 */
export async function verifyRequest(
  request: Request,
  body: string,
  publicHost: string,
  fetchActor: (url: string) => Promise<any>,
): Promise<Verified> {
  const header = request.headers.get("signature");
  if (!header) throw new Error("unsigned");
  const p = parseSignature(header);
  if (!p.keyId || !p.signature) throw new Error("malformed signature");
  const names = (p.headers ?? "date").toLowerCase().split(/\s+/);

  const date = request.headers.get("date");
  if (!date || Math.abs(Date.now() - Date.parse(date)) > 12 * 3600_000) throw new Error("stale date");
  if (request.method === "POST") {
    if (!names.includes("digest")) throw new Error("digest not signed");
    if (request.headers.get("digest") !== (await digest(body))) throw new Error("digest mismatch");
  }

  const url = new URL(request.url);
  const str = names
    .map((h) => {
      if (h === "(request-target)") return `${h}: ${request.method.toLowerCase()} ${url.pathname}${url.search}`;
      if (h === "host") return `host: ${publicHost}`;
      const v = request.headers.get(h);
      if (v === null) throw new Error(`missing signed header ${h}`);
      return `${h}: ${v}`;
    })
    .join("\n");

  const doc = await fetchActor(p.keyId.split("#")[0]);
  // keyId may name the actor (with publicKey inside) or a standalone key object.
  const keyObj = doc?.publicKey?.publicKeyPem ? doc.publicKey : doc;
  if (!keyObj?.publicKeyPem) throw new Error("no public key");
  const owner = keyObj.owner ?? doc.id;
  const actorDoc = doc.inbox ? doc : await fetchActor(owner);

  const key = await crypto.subtle.importKey("spki", unb64(pemBody(keyObj.publicKeyPem)), RSA, false, ["verify"]);
  const ok = await crypto.subtle.verify(RSA, key, unb64(p.signature), enc.encode(str));
  if (!ok) throw new Error("bad signature");
  return { keyOwner: owner, actorDoc };
}
