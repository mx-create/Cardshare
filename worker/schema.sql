-- Cardshare v2 (Teams) D1 schema. Mirrors the mock server in sync.js.
-- Apply with: wrangler d1 execute cardshare --file=worker/schema.sql   (not run yet)
-- Nothing personal from the phone is stored here: no Personal cards, no Links, no employee mobile numbers.

CREATE TABLE IF NOT EXISTS orgs (
  id             TEXT PRIMARY KEY,               -- org_<hex>
  name           TEXT NOT NULL,                  -- shown in the app: "Harbour Studio manages work cards"
  company        TEXT NOT NULL DEFAULT '',       -- company name on the card (default: name)
  discoverable   INTEGER NOT NULL DEFAULT 1,     -- suggest sign-in when staff type an email at its domains
  brand_version  INTEGER NOT NULL DEFAULT 1,     -- bumped on name/company/logo change; part of every card ETag
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS domains (
  domain     TEXT PRIMARY KEY,                   -- lower case, e.g. harbour.example
  org_id     TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  verified   INTEGER NOT NULL DEFAULT 0          -- DNS TXT check before it is used for discovery (to build)
);

CREATE TABLE IF NOT EXISTS admins (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  email      TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS employees (
  id          TEXT PRIMARY KEY,                  -- emp_<hex>
  org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,                     -- work email, lower case; also the sign-in address
  name        TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  company     TEXT NOT NULL DEFAULT '',          -- per-person override of orgs.company
  office      TEXT NOT NULL DEFAULT '',          -- office phone
  version     INTEGER NOT NULL DEFAULT 1,        -- bumped on every edit; part of the card ETag
  invited_at  INTEGER,
  removed_at  INTEGER,                           -- set on removal: the next check-in answers 410 and the phone wipes the card
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS employees_active_email ON employees(email) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS employees_org ON employees(org_id);

-- One-time sign-in links. Only a SHA-256 of the token is stored.
CREATE TABLE IF NOT EXISTS links (
  token_hash  TEXT PRIMARY KEY,
  employee_id TEXT REFERENCES employees(id) ON DELETE CASCADE,
  admin_id    TEXT REFERENCES admins(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);

-- A signed-in phone. Only a SHA-256 of the device token is stored.
CREATE TABLE IF NOT EXISTS devices (
  token_hash  TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  label       TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS devices_employee ON devices(employee_id);

-- Admin console sessions (admins sign in with a magic link too).
CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash  TEXT PRIMARY KEY,
  admin_id    TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL
);

-- Logo metadata; the files live in R2 under logos/<org_id>/<variant>-<brand_version>.<ext>.
CREATE TABLE IF NOT EXISTS logos (
  org_id    TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  variant   TEXT NOT NULL CHECK (variant IN ('horizontal','mark','light','dark')),
  r2_key    TEXT NOT NULL,
  type      TEXT NOT NULL,                       -- image/svg+xml or image/png
  w         INTEGER NOT NULL,
  h         INTEGER NOT NULL,
  ratio     REAL NOT NULL,                       -- width / height after trimming
  lum       REAL,                                -- average luminance of the visible pixels (0..1), for the light-chip rule
  vector    INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, variant)
);

CREATE TABLE IF NOT EXISTS activity (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id  TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  at      INTEGER NOT NULL,
  text    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS activity_org ON activity(org_id, at DESC);
