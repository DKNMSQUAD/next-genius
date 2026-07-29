-- India Desk by Next Genius - D1 schema.
-- One database serves every partner university desk; `uni` is the slug
-- ('syracuse' today) so a second desk is a new row value, not a new table.
--
-- Apply:  wrangler d1 execute next-genius-indiadesk --remote --file=schema/indiadesk.sql

CREATE TABLE IF NOT EXISTS id_visits (
  id            TEXT PRIMARY KEY,
  uni           TEXT NOT NULL DEFAULT 'syracuse',
  created_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  visit_date    TEXT NOT NULL,
  counselor     TEXT NOT NULL,
  email         TEXT,
  whatsapp      TEXT,
  org_type      TEXT,            -- School / IEC / Other
  org_name      TEXT,
  city          TEXT,
  notes         TEXT
);

CREATE TABLE IF NOT EXISTS id_interactions (
  id            TEXT PRIMARY KEY,
  uni           TEXT NOT NULL DEFAULT 'syracuse',
  created_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  mode          TEXT NOT NULL,   -- Call / Meeting / Email / WhatsApp / Video / Other
  contact_date  TEXT NOT NULL,
  counselor     TEXT NOT NULL,
  email         TEXT,
  whatsapp      TEXT,
  org_type      TEXT,
  org_name      TEXT,
  city          TEXT,
  notes         TEXT
);

CREATE TABLE IF NOT EXISTS id_requests (
  id            TEXT PRIMARY KEY,
  uni           TEXT NOT NULL DEFAULT 'syracuse',
  created_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  kind          TEXT NOT NULL,   -- Flight / Hotel / Budget
  title         TEXT NOT NULL,
  from_place    TEXT,
  to_place      TEXT,
  start_date    TEXT,
  end_date      TEXT,
  amount        REAL,
  currency      TEXT DEFAULT 'INR',
  notes         TEXT,
  status        TEXT NOT NULL DEFAULT 'Pending',   -- Pending / Approved / Booked / Declined
  status_note   TEXT,
  status_at     TEXT,
  status_by     TEXT
);

CREATE TABLE IF NOT EXISTS id_accounts (
  id            TEXT PRIMARY KEY,
  uni           TEXT NOT NULL DEFAULT 'syracuse',
  created_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  spend_date    TEXT NOT NULL,
  category      TEXT,            -- Travel / Stay / Food / Event / Printing / Other
  vendor        TEXT,
  amount        REAL,
  currency      TEXT DEFAULT 'INR',
  file_url      TEXT,
  file_name     TEXT,
  notes         TEXT,
  status        TEXT NOT NULL DEFAULT 'Submitted', -- Submitted / Verified / Reimbursed / Query
  status_note   TEXT,
  status_at     TEXT,
  status_by     TEXT
);

CREATE TABLE IF NOT EXISTS id_applications (
  id            TEXT PRIMARY KEY,
  uni           TEXT NOT NULL DEFAULT 'syracuse',
  created_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  student       TEXT NOT NULL,
  email         TEXT,
  whatsapp      TEXT,
  school        TEXT,
  city          TEXT,
  program       TEXT,
  intake        TEXT,
  source        TEXT,            -- which counselor / visit sent them
  app_status    TEXT NOT NULL DEFAULT 'Pending',   -- Pending / Applied / Admitted / Deposited / Denied / Withdrawn
  notes         TEXT,
  updated_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_visits_uni    ON id_visits(uni, visit_date);
CREATE INDEX IF NOT EXISTS idx_inter_uni     ON id_interactions(uni, contact_date);
CREATE INDEX IF NOT EXISTS idx_req_uni       ON id_requests(uni, status);
CREATE INDEX IF NOT EXISTS idx_acct_uni      ON id_accounts(uni, spend_date);
CREATE INDEX IF NOT EXISTS idx_app_uni       ON id_applications(uni, app_status);
