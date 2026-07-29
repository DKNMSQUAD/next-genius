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
// Store is D1 (binding INDIADESK_DB). Bills/receipts are relayed to Cloudinary
// from Cloudflare's network, not the counsellor's laptop - api.cloudinary.com is
// unreachable from some Indian networks (see nm-squad-portal functions/api/upload.js).
//
// Secrets are bound at DEPLOY time on Pages: after `wrangler pages secret put`,
// redeploy or the binding does not exist.

const API_KEY = "AIzaSyAf7Pv2zEaM3eVMqM7QGQCXBPruU0tgmFg"; // public web key, next-genius-auto

// Always allowed, whatever the env says. Desk staff come from INDIADESK_EMAILS.
const ALWAYS = ["dknmsquad@gmail.com", "mandhana.neeraj@gmail.com", "helpdesk@next-genius.com"];

const CLOUD_NAME = "dclcl4mox";
const UPLOAD_PRESET = "otg_unsigned";
const MAX_BYTES = 15 * 1024 * 1024;
const OK_TYPES = /^(image\/|application\/pdf)/;

const TABLES = {
  visits:       "id_visits",
  interactions: "id_interactions",
  requests:     "id_requests",
  accounts:     "id_accounts",
  applications: "id_applications",
};

export async function onRequestPost(ctx) {
  const { request, env } = ctx;
  try {
    if (!env.INDIADESK_DB) return json({ ok: false, error: "india desk db not bound" }, 500);

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
    const db = env.INDIADESK_DB;

    switch (body.action) {
      case "list":       return list(db, uni, who);
      case "add":        return add(db, uni, who, body);
      case "status":     return setStatus(db, who, body);
      case "appstatus":  return setAppStatus(db, who, body);
      case "delete":     return remove(db, uni, who, body);
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

/* ------------------------------------------------------------------ read --- */

async function list(db, uni, who) {
  const q = (sql) => db.prepare(sql).bind(uni).all().then((r) => r.results || []);
  const [visits, interactions, requests, accounts, applications] = await Promise.all([
    q("SELECT * FROM id_visits       WHERE uni = ? ORDER BY visit_date DESC, created_at DESC LIMIT 500"),
    q("SELECT * FROM id_interactions WHERE uni = ? ORDER BY contact_date DESC, created_at DESC LIMIT 500"),
    q("SELECT * FROM id_requests     WHERE uni = ? ORDER BY created_at DESC LIMIT 300"),
    q("SELECT * FROM id_accounts     WHERE uni = ? ORDER BY spend_date DESC, created_at DESC LIMIT 300"),
    q("SELECT * FROM id_applications WHERE uni = ? ORDER BY created_at DESC LIMIT 500"),
  ]);

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

async function add(db, uni, who, body) {
  const kind = String(body.kind || "");
  const table = TABLES[kind];
  if (!table) return json({ ok: false, error: "unknown record type" }, 400);

  const row = body.row || {};
  for (const f of REQUIRED[kind]) {
    if (!String(row[f] ?? "").trim()) return json({ ok: false, error: `${f.replace(/_/g, " ")} is required` }, 400);
  }

  const cols = ["id", "uni", "created_at", "created_by", ...FIELDS[kind]];
  const vals = [crypto.randomUUID(), uni, new Date().toISOString(), who.email,
    ...FIELDS[kind].map((f) => clean(row[f]))];
  if (kind === "applications") { cols.push("updated_at"); vals.push(new Date().toISOString()); }

  await db.prepare(
    `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`
  ).bind(...vals).run();

  return json({ ok: true, id: vals[0] });
}

// Back office moves a request or a bill along. Desk staff cannot.
async function setStatus(db, who, body) {
  if (!who.admin) return json({ ok: false, error: "the back office sets this" }, 403);
  const table = body.kind === "requests" ? "id_requests" : body.kind === "accounts" ? "id_accounts" : null;
  if (!table || !body.id) return json({ ok: false, error: "bad request" }, 400);

  const ok = table === "id_requests"
    ? ["Pending", "Approved", "Booked", "Declined"]
    : ["Submitted", "Verified", "Reimbursed", "Query"];
  if (!ok.includes(body.status)) return json({ ok: false, error: "bad status" }, 400);

  await db.prepare(`UPDATE ${table} SET status = ?, status_note = ?, status_at = ?, status_by = ? WHERE id = ?`)
    .bind(body.status, clean(body.note), new Date().toISOString(), who.email, String(body.id)).run();
  return json({ ok: true });
}

async function setAppStatus(db, who, body) {
  const ok = ["Pending", "Applied", "Admitted", "Deposited", "Denied", "Withdrawn"];
  if (!body.id || !ok.includes(body.status)) return json({ ok: false, error: "bad request" }, 400);
  await db.prepare("UPDATE id_applications SET app_status = ?, updated_at = ? WHERE id = ?")
    .bind(body.status, new Date().toISOString(), String(body.id)).run();
  return json({ ok: true });
}

// Only the person who logged it, or the back office, can remove a row.
async function remove(db, uni, who, body) {
  const table = TABLES[body.kind];
  if (!table || !body.id) return json({ ok: false, error: "bad request" }, 400);
  const sql = who.admin
    ? `DELETE FROM ${table} WHERE id = ? AND uni = ?`
    : `DELETE FROM ${table} WHERE id = ? AND uni = ? AND created_by = '${who.email.replace(/'/g, "")}'`;
  await db.prepare(sql).bind(String(body.id), uni).run();
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

function clean(v) {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "number") return v;
  return String(v).slice(0, 2000);
}

function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40) || "syracuse"; }

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
