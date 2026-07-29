// India Desk by Next Genius - desk API.
//
// One endpoint serves two very different callers:
//
//   1. THE DESK (Denver, /indiadesk/syracuse.html)
//      POST { idToken, action, ... }  - Firebase Google sign-in on next-genius-auto,
//      email must be on the desk whitelist. Can create rows and read its own desk.
//
//   2. THE BACK OFFICE (Neeraj's NM Squad portal, via its own /api/indiadesk proxy)
//      POST { token: <INDIADESK_MAINT_TOKEN>, action, ... } - shared maint token,
//      never leaves a server. Can read everything and move statuses.
//
// STORE = Firestore on next-genius-auto, reached with the Admin service account
// (secret FIREBASE_SA) over the REST API. D1 was the first choice and is the
// better long-term home, but creating a D1 database needs a Cloudflare token
// scope this project does not have (the stored one is Pages-only), and this path
// needs nothing but a Pages secret. Same collections map 1:1 to schema/indiadesk.sql
// if it ever moves.
//
// The service account BYPASSES firestore.rules, so the indiadesk_* collections
// are never client-readable - the catch-all deny in firestore.rules covers them.
// Nothing here opens a listener; reads are a handful per dashboard load.
//
// Bills/receipts are relayed to Cloudinary from Cloudflare's network, not the
// counsellor's laptop - api.cloudinary.com is unreachable on some Indian
// networks (see nm-squad-portal functions/api/upload.js).
//
// Secrets bind at DEPLOY time on Pages: after `wrangler pages secret put`,
// redeploy or the binding does not exist.

const API_KEY = "AIzaSyAf7Pv2zEaM3eVMqM7QGQCXBPruU0tgmFg"; // public web key, next-genius-auto
const PROJECT = "next-genius-auto";

// Always allowed, whatever the env says. Desk staff come from INDIADESK_EMAILS.
const ALWAYS = ["dknmsquad@gmail.com", "mandhana.neeraj@gmail.com", "helpdesk@next-genius.com"];

const CLOUD_NAME = "dclcl4mox";
const UPLOAD_PRESET = "otg_unsigned";
const MAX_BYTES = 15 * 1024 * 1024;
const OK_TYPES = /^(image\/|application\/pdf)/;

const COLL = {
  visits:       "indiadesk_visits",
  interactions: "indiadesk_interactions",
  requests:     "indiadesk_requests",
  accounts:     "indiadesk_accounts",
  applications: "indiadesk_applications",
};

const FIELDS = {
  visits:       ["visit_date", "counselor", "email", "whatsapp", "org_type", "org_name", "city", "notes"],
  interactions: ["mode", "contact_date", "counselor", "email", "whatsapp", "org_type", "org_name", "city", "notes"],
  requests:     ["kind", "title", "from_place", "to_place", "start_date", "end_date", "amount", "currency", "notes"],
  accounts:     ["spend_date", "category", "vendor", "amount", "currency", "file_url", "file_name", "notes"],
  applications: ["student", "email", "whatsapp", "school", "city", "program", "intake", "source", "app_status", "notes"],
};

const REQUIRED = {
  visits:       ["visit_date", "counselor"],
  interactions: ["mode", "contact_date", "counselor"],
  requests:     ["kind", "title"],
  accounts:     ["spend_date", "amount"],
  applications: ["student"],
};

const NUMERIC = new Set(["amount"]);

// Rows are ordered newest-first on the date that matters for that record type.
const SORT_KEY = {
  visits: "visit_date", interactions: "contact_date",
  requests: "created_at", accounts: "spend_date", applications: "created_at",
};

export async function onRequestPost(ctx) {
  const { request, env } = ctx;
  try {
    if (!env.FIREBASE_SA) return json({ ok: false, error: "india desk store not configured" }, 500);

    const ct = request.headers.get("content-type") || "";

    // ---- file upload (multipart) -------------------------------------------
    if (ct.includes("multipart/form-data")) {
      const form = await request.formData();
      const who = await whoami(env, { idToken: form.get("idToken"), token: form.get("token") });
      if (!who.ok) return json({ ok: false, error: who.error }, who.status);
      return upload(form);
    }

    // ---- json actions -------------------------------------------------------
    const body = await request.json().catch(() => ({}));
    const who = await whoami(env, body);
    if (!who.ok) return json({ ok: false, error: who.error }, who.status);

    const uni = slug(body.uni || "syracuse");
    const at = await accessToken(env);

    switch (body.action) {
      case "list":       return list(at, uni, who);
      case "add":        return add(at, uni, who, body);
      case "status":     return setStatus(at, who, body);
      case "appstatus":  return setAppStatus(at, who, body);
      case "delete":     return remove(at, uni, who, body);
      default:           return json({ ok: false, error: "unknown action" }, 400);
    }
  } catch (e) {
    return json({ ok: false, error: String(e).slice(0, 300) }, 500);
  }
}

/* ------------------------------------------------------------------ auth --- */

async function whoami(env, body) {
  const maint = (env.INDIADESK_MAINT_TOKEN || "").trim();
  if (body?.token && maint && safeEq(String(body.token), maint)) {
    return { ok: true, email: "back-office", admin: true };
  }
  const idToken = body?.idToken;
  if (!idToken) return { ok: false, error: "sign in required", status: 401 };

  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken }),
  });
  if (!r.ok) return { ok: false, error: "session expired, sign in again", status: 401 };
  const email = ((await r.json()).users?.[0]?.email || "").toLowerCase();

  const desk = String(env.INDIADESK_EMAILS || "")
    .split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const allowed = new Set([...ALWAYS, ...desk]);
  if (!allowed.has(email)) return { ok: false, error: "this account is not on the India Desk", status: 403 };

  return { ok: true, email, admin: ALWAYS.includes(email) };
}

function safeEq(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/* -------------------------------------------------- google access token --- */
// Signed JWT assertion -> OAuth access token. Cached in module scope for the
// life of the isolate; Google issues them for an hour, we drop at 50 minutes.

let tokenCache = { at: 0, value: "" };

async function accessToken(env) {
  if (tokenCache.value && Date.now() - tokenCache.at < 50 * 60 * 1000) return tokenCache.value;

  const sa = JSON.parse(env.FIREBASE_SA);
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(claim));
  const signed = `${head}.${body}`;

  const key = await crypto.subtle.importKey(
    "pkcs8", pem(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signed));

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${signed}.${b64urlBytes(new Uint8Array(sig))}`,
    }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("could not authenticate to the store");
  tokenCache = { at: Date.now(), value: d.access_token };
  return d.access_token;
}

const b64url = (s) => b64urlBytes(new TextEncoder().encode(s));
function b64urlBytes(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function pem(key) {
  const body = key.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  const raw = atob(body);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out.buffer;
}

/* -------------------------------------------------------------- firestore -- */

const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

async function fs(at, path, init = {}) {
  const r = await fetch(BASE + path, {
    ...init,
    headers: { Authorization: `Bearer ${at}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  if (!r.ok && r.status !== 404) {
    const t = await r.text();
    throw new Error(`store ${r.status}: ${t.slice(0, 160)}`);
  }
  return r.status === 404 ? null : r.json();
}

// Firestore's typed values, both directions.
function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "number") return { doubleValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  return { stringValue: String(v).slice(0, 2000) };
}
function fromValue(v) {
  if (!v) return null;
  if ("nullValue" in v) return null;
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("integerValue" in v) return Number(v.integerValue);
  if ("booleanValue" in v) return v.booleanValue;
  return v.stringValue ?? null;
}
function toDoc(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) fields[k] = toValue(v);
  return { fields };
}
function fromDoc(d) {
  const out = { id: (d.name || "").split("/").pop() };
  for (const [k, v] of Object.entries(d.fields || {})) out[k] = fromValue(v);
  return out;
}

// Every desk is one university, so a single equality filter is the whole query.
// Sorting happens here rather than in Firestore: an orderBy alongside a where
// needs a composite index, and these are hundreds of rows, not millions.
async function fetchKind(at, kind, uni) {
  const body = {
    structuredQuery: {
      from: [{ collectionId: COLL[kind] }],
      where: { fieldFilter: { field: { fieldPath: "uni" }, op: "EQUAL", value: { stringValue: uni } } },
      limit: 1000,
    },
  };
  const res = await fs(at, ":runQuery", { method: "POST", body: JSON.stringify(body) });
  const rows = (res || []).filter((r) => r.document).map((r) => fromDoc(r.document));
  const key = SORT_KEY[kind];
  return rows.sort((a, b) => String(b[key] || "").localeCompare(String(a[key] || "")));
}

/* ------------------------------------------------------------------ read --- */

async function list(at, uni, who) {
  const [visits, interactions, requests, accounts, applications] = await Promise.all(
    ["visits", "interactions", "requests", "accounts", "applications"].map((k) => fetchKind(at, k, uni)),
  );

  const spend = accounts.reduce((n, a) => n + (Number(a.amount) || 0), 0);
  const stats = {
    visits: visits.length,
    interactions: interactions.length,
    counselors: new Set([...visits, ...interactions].map((r) => (r.email || r.counselor || "").toLowerCase()).filter(Boolean)).size,
    cities: new Set([...visits, ...interactions].map((r) => (r.city || "").trim().toLowerCase()).filter(Boolean)).size,
    requestsOpen: requests.filter((r) => r.status === "Pending").length,
    spend,
    applications: applications.length,
    applied: applications.filter((a) => a.app_status !== "Pending").length,
  };

  return json({ ok: true, uni, me: who.email, admin: who.admin, stats, visits, interactions, requests, accounts, applications });
}

/* ----------------------------------------------------------------- write --- */

async function add(at, uni, who, body) {
  const kind = String(body.kind || "");
  if (!COLL[kind]) return json({ ok: false, error: "unknown record type" }, 400);

  const row = body.row || {};
  for (const f of REQUIRED[kind]) {
    if (!String(row[f] ?? "").trim()) return json({ ok: false, error: `${f.replace(/_/g, " ")} is required` }, 400);
  }

  const doc = { uni, created_at: new Date().toISOString(), created_by: who.email };
  for (const f of FIELDS[kind]) doc[f] = clean(row[f], NUMERIC.has(f));
  if (kind === "requests")     { doc.status = "Pending";   doc.status_note = null; doc.status_at = null; doc.status_by = null; }
  if (kind === "accounts")     { doc.status = "Submitted"; doc.status_note = null; doc.status_at = null; doc.status_by = null; }
  if (kind === "applications") { doc.app_status = doc.app_status || "Pending"; doc.updated_at = doc.created_at; }

  const id = crypto.randomUUID();
  await fs(at, `/${COLL[kind]}?documentId=${id}`, { method: "POST", body: JSON.stringify(toDoc(doc)) });
  return json({ ok: true, id });
}

// Back office moves a request or a bill along. Desk staff cannot.
async function setStatus(at, who, body) {
  if (!who.admin) return json({ ok: false, error: "the back office sets this" }, 403);
  const kind = body.kind === "requests" ? "requests" : body.kind === "accounts" ? "accounts" : null;
  if (!kind || !body.id) return json({ ok: false, error: "bad request" }, 400);

  const ok = kind === "requests"
    ? ["Pending", "Approved", "Booked", "Declined"]
    : ["Submitted", "Verified", "Reimbursed", "Query"];
  if (!ok.includes(body.status)) return json({ ok: false, error: "bad status" }, 400);

  await patch(at, COLL[kind], String(body.id), {
    status: body.status,
    status_note: clean(body.note),
    status_at: new Date().toISOString(),
    status_by: who.email,
  });
  return json({ ok: true });
}

async function setAppStatus(at, who, body) {
  const ok = ["Pending", "Applied", "Admitted", "Deposited", "Denied", "Withdrawn"];
  if (!body.id || !ok.includes(body.status)) return json({ ok: false, error: "bad request" }, 400);
  await patch(at, COLL.applications, String(body.id), {
    app_status: body.status,
    updated_at: new Date().toISOString(),
  });
  return json({ ok: true });
}

// updateMask keeps the patch to the named fields; without it Firestore would
// blank everything else on the document.
async function patch(at, coll, id, fields) {
  const mask = Object.keys(fields).map((f) => `updateMask.fieldPaths=${f}`).join("&");
  await fs(at, `/${coll}/${encodeURIComponent(id)}?${mask}`, {
    method: "PATCH", body: JSON.stringify(toDoc(fields)),
  });
}

// Only the person who logged it, or the back office, can remove a row.
async function remove(at, uni, who, body) {
  const kind = String(body.kind || "");
  if (!COLL[kind] || !body.id) return json({ ok: false, error: "bad request" }, 400);

  const cur = await fs(at, `/${COLL[kind]}/${encodeURIComponent(String(body.id))}`);
  if (!cur) return json({ ok: true });
  const row = fromDoc(cur);
  if (row.uni !== uni) return json({ ok: false, error: "not this desk" }, 403);
  if (!who.admin && row.created_by !== who.email) {
    return json({ ok: false, error: "only the person who logged it can remove it" }, 403);
  }

  await fs(at, `/${COLL[kind]}/${encodeURIComponent(String(body.id))}`, { method: "DELETE" });
  return json({ ok: true });
}

/* ---------------------------------------------------------------- upload --- */

async function upload(form) {
  const file = form.get("file");
  if (!file || typeof file === "string") return json({ ok: false, error: "no file" }, 400);
  const type = file.type || "";
  if (!OK_TYPES.test(type)) return json({ ok: false, error: "attach an image or a PDF" }, 415);
  if (file.size > MAX_BYTES) return json({ ok: false, error: "file too large (15 MB max)" }, 413);

  const out = new FormData();
  out.append("file", file);
  out.append("upload_preset", UPLOAD_PRESET);
  out.append("folder", "india-desk");

  const r = await fetch(`https://api.cloudinary.com/v1_1/${CLOUD_NAME}/auto/upload`, { method: "POST", body: out });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.secure_url) {
    return json({ ok: false, error: data?.error?.message || "upload failed" }, 502);
  }
  return json({ ok: true, url: data.secure_url, name: file.name || "bill" });
}

/* ----------------------------------------------------------------- utils --- */

function clean(v, numeric = false) {
  if (v === undefined || v === null || v === "") return null;
  if (numeric) { const n = Number(v); return isNaN(n) ? null : n; }
  return String(v).slice(0, 2000);
}

function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40) || "syracuse"; }

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
