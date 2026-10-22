-- Cardshare v2 (Teams) D1 schema. Mirrors the mock server in sync.js.
-- Apply with: wrangler d1 execute cardshare --file=worker/schema.sql   (not run yet)
-- Nothing personal from the phone is stored here: no Personal cards, no Links, no employee mobile numbers.

CREATE TABLE IF NOT EXISTS orgs (
  id             TEXT PRIMARY KEY,               -- org_<hex>
  name           TEXT NOT NULL,                  -- shown in the app: "Harbour Studio manages work cards"
  company        TEXT NOT NULL DEFAULT '',       -- company name on the card (default: name)
  discoverable   INTEGER NOT NULL DEFAULT 1,     -- suggest sign-in when staff type an email at its domains
  brand_version  INTEGER NOT NULL DEFAULT 1,     -- bumped on name/company/logo change; part of every card ETag
  source         TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','microsoft')),
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')), -- set by the platform console
  plan           TEXT NOT NULL DEFAULT 'trial',  -- placeholder until billing
  branding_json  TEXT,                           -- see accounts.js cleanBranding(); NULL = the Cardshare look
  map_department INTEGER NOT NULL DEFAULT 0,     -- Microsoft: put department on the card
  map_location   INTEGER NOT NULL DEFAULT 0,     -- Microsoft: put officeLocation on the card
  created_at     INTEGER NOT NULL
);

-- Microsoft 365 connection: the minimum needed to call Graph for this tenant. No tokens are stored: app-only tokens are
-- fetched with the client credential when needed and kept in memory. No users are stored.
CREATE TABLE IF NOT EXISTS ms_tenants (
  org_id        TEXT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  tenant_id     TEXT NOT NULL UNIQUE,            -- Entra tenant GUID, from the admin-consent callback
  tenant_name   TEXT NOT NULL,
  consented_by  TEXT NOT NULL DEFAULT '',        -- the Cardshare admin who started the consent
  consented_at  INTEGER NOT NULL,
  last_sync     INTEGER,                         -- last successful Graph read
  people_found  INTEGER,                         -- a count only, from the admin console's last People read
  delta_link    TEXT                             -- reserved for /users/delta if we ever cache; unused today
);

-- Admin-typed corrections for Microsoft users (fill a blank, fix one field). The only staff details stored in Microsoft mode.
-- Deleted with the user's leave (next 410), on disconnect, or when the admin clears them.
CREATE TABLE IF NOT EXISTS ms_overrides (
  org_id     TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  ms_user_id TEXT NOT NULL,                      -- Entra user object ID
  field      TEXT NOT NULL CHECK (field IN ('name','title','company','office','email','department','officeLocation')),
  value      TEXT NOT NULL,
  PRIMARY KEY (org_id, ms_user_id, field)
);

-- Short-lived state for the Microsoft redirects (admin consent, phone sign-in). Deleted when used or after 10 minutes.
CREATE TABLE IF NOT EXISTS oauth_state (
  state      TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('consent','signin','admin')),
  admin_id   TEXT,
  org_id     TEXT,
  nonce      TEXT,
  return_to  TEXT,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS domains (
  domain      TEXT PRIMARY KEY,                  -- lower case, e.g. harbour.example
  org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  verified    INTEGER NOT NULL DEFAULT 0,        -- only verified domains are used for discovery
  method      TEXT,                              -- 'microsoft' (connecting proves it), 'dns' (TXT record) or 'email'
  txt_token   TEXT,                              -- value expected in the TXT record at _cardshare.<domain>
  verified_at INTEGER
);

-- Admin accounts are people; memberships say which organisations they run and as what.
CREATE TABLE IF NOT EXISTS admins (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memberships (
  admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  org_id   TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  role     TEXT NOT NULL CHECK (role IN ('owner','admin')),
  PRIMARY KEY (admin_id, org_id)
);

-- Sign-up in progress, after the email is confirmed and before the organisation is named.
CREATE TABLE IF NOT EXISTS signups (
  token_hash TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Platform console (Cardshare staff, addresses in PLATFORM_OWNERS).
CREATE TABLE IF NOT EXISTS platform_sessions (
  token_hash TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  expires_at INTEGER NOT NULL
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
  removed_at  INTEGER,                           -- unused: removal deletes the row; kept for a possible grace period
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS employees_active_email ON employees(email) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS employees_org ON employees(org_id);

-- One-time sign-in links. Only a SHA-256 of the token is stored. A link is for a hand-typed employee (employee_id),
-- a Microsoft user (org_id + ms_user_id) or an admin.
CREATE TABLE IF NOT EXISTS links (
  token_hash  TEXT PRIMARY KEY,
  kind        TEXT NOT NULL DEFAULT 'phone' CHECK (kind IN ('phone','admin','signup','domain','platform')),
  email       TEXT,                              -- signup, platform
  domain      TEXT,                              -- domain confirmation
  employee_id TEXT REFERENCES employees(id) ON DELETE CASCADE,
  org_id      TEXT REFERENCES orgs(id) ON DELETE CASCADE,
  ms_user_id  TEXT,
  admin_id    TEXT REFERENCES admins(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);

-- A signed-in phone. Only a SHA-256 of the device token is stored. Manual mode: employee_id. Microsoft mode: org_id +
-- ms_user_id (the Entra object ID), and nothing else about the person.
CREATE TABLE IF NOT EXISTS devices (
  token_hash  TEXT PRIMARY KEY,
  employee_id TEXT REFERENCES employees(id) ON DELETE SET NULL, -- so a removed person's phone gets 410, not 401
  org_id      TEXT REFERENCES orgs(id) ON DELETE CASCADE,
  ms_user_id  TEXT,
  label       TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS devices_employee ON devices(employee_id);
CREATE INDEX IF NOT EXISTS devices_ms ON devices(org_id, ms_user_id);

-- Admin console sessions (admins sign in with a magic link too).
CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash  TEXT PRIMARY KEY,
  admin_id    TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  org_id      TEXT REFERENCES orgs(id) ON DELETE SET NULL, -- the organisation this session is looking at (switcher)
  expires_at  INTEGER NOT NULL
);

-- Logo metadata; the files live in R2 under logos/<org_id>/<variant>-<brand_version>.<ext>.
CREATE TABLE IF NOT EXISTS logos (
  org_id    TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  variant   TEXT NOT NULL CHECK (variant IN ('horizontal','mark','markLight','light','dark')),
  source    TEXT NOT NULL DEFAULT 'upload' CHECK (source IN ('upload','microsoft')),
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
