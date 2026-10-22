// Microsoft 365 (Entra ID) for the Cardshare v2 API. STUB: not deployed, never run against a real tenant.
//
// Data stance: for a Microsoft-connected organisation, Cardshare stores no staff details. On a phone's check-in the Worker
// reads that one user from Microsoft Graph, maps it to a card, returns it, and keeps nothing but the device row
// (tenant ID + user object ID + hashed device token). See ../README.md for the app registration and permissions.
//
// Permissions (application, granted once by a tenant admin through the admin-consent URL):
//   User.Read.All                   read the fields below for any user, with no signed-in user (the phone's check-in is
//                                   app-only, so delegated User.ReadBasic.All won't do; ReadBasic also omits jobTitle,
//                                   businessPhones, department and officeLocation). Read-only.
//   OrganizationalBranding.Read.All read the tenant's sign-in page logos, only when the admin clicks "Use our Microsoft 365
//                                   sign-in logo". Optional: the connection works without it.
// Delegated, for "Sign in with Microsoft" on the phone: openid profile email (no admin consent needed beyond the above).
// Never requested: any write permission, mobilePhone (it is not in $select), mail, calendars or files.

const LOGIN = "https://login.microsoftonline.com";
const GRAPH = "https://graph.microsoft.com/v1.0";

// The only fields Cardshare reads. mobilePhone is deliberately absent: the mobile is the employee's own, on their phone.
export const USER_SELECT = ["id", "displayName", "jobTitle", "companyName", "businessPhones", "mail", "userPrincipalName",
  "department", "officeLocation", "accountEnabled"].join(",");

// ------------------------------------------------------------ admin consent
// Step 1: the admin console sends the IT admin here. Microsoft shows the consent screen for the whole tenant.
export function adminConsentUrl(env, state) {
  const u = new URL(`${LOGIN}/organizations/v2.0/adminconsent`);
  u.searchParams.set("client_id", env.MS_CLIENT_ID);
  u.searchParams.set("scope", "https://graph.microsoft.com/.default"); // = the application permissions on the app registration
  u.searchParams.set("redirect_uri", `${env.API_ORIGIN}/v1/admin/microsoft/callback`);
  u.searchParams.set("state", state);
  return u.toString();
}

// Step 2: Microsoft redirects back with ?admin_consent=True&tenant=<tenant id>&state=... (or ?error=...).
// The caller checks state against the admin session it was issued for before trusting tenant.
export function readConsentCallback(url) {
  const q = url.searchParams;
  if (q.get("error")) return { ok: false, error: q.get("error_description") || q.get("error") };
  const tenant = q.get("tenant") || "";
  if (q.get("admin_consent") !== "True" || !/^[0-9a-f-]{36}$/i.test(tenant)) return { ok: false, error: "consent_not_granted" };
  return { ok: true, tenantId: tenant, state: q.get("state") || "" };
}

// ------------------------------------------------------------ app-only Graph token (client credentials)
// Cached per tenant in memory for its lifetime; never written to D1. With a certificate credential in production,
// replace client_secret with client_assertion (a signed JWT).
const tokenCache = new Map();
export async function appToken(env, tenantId) {
  const hit = tokenCache.get(tenantId);
  if (hit && hit.exp > Date.now() + 60_000) return hit.token;
  const r = await fetch(`${LOGIN}/${tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.MS_CLIENT_ID, client_secret: env.MS_CLIENT_SECRET,
      scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" })
  });
  if (!r.ok) throw graphError(r.status, "token", await r.text());
  const j = await r.json();
  tokenCache.set(tenantId, { token: j.access_token, exp: Date.now() + j.expires_in * 1000 });
  return j.access_token;
}

async function graph(env, tenantId, path, init = {}) {
  const token = await appToken(env, tenantId);
  const r = await fetch(GRAPH + path, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) } });
  return r;
}
function graphError(status, what, detail) { const e = new Error(`graph ${what} ${status}`); e.status = status; e.detail = String(detail || "").slice(0, 300); return e; }

// ------------------------------------------------------------ users
// One user, only the selected fields. Returns null when the user no longer exists (404) — treated as a leaver.
export async function getUser(env, tenantId, userId) {
  const r = await graph(env, tenantId, `/users/${encodeURIComponent(userId)}?$select=${USER_SELECT}`);
  if (r.status === 404) return null;
  if (!r.ok) throw graphError(r.status, "user", await r.text());
  return r.json();
}

// For the email-link path: find the user by work email (mail or UPN). Returns null if not found.
export async function findUserByEmail(env, tenantId, email) {
  const e = String(email).replace(/'/g, "''");
  const r = await graph(env, tenantId, `/users?$select=${USER_SELECT}&$filter=${encodeURIComponent(`mail eq '${e}' or userPrincipalName eq '${e}'`)}&$top=2`);
  if (!r.ok) throw graphError(r.status, "find", await r.text());
  const j = await r.json();
  return j.value && j.value.length === 1 ? j.value[0] : null;
}

// The admin console's People page: read live, page by page, never stored.
export async function listUsers(env, tenantId, max = 999) {
  const out = []; let next = `/users?$select=${USER_SELECT}&$top=999`;
  while (next && out.length < max) {
    const r = await graph(env, tenantId, next.replace(GRAPH, ""));
    if (!r.ok) throw graphError(r.status, "list", await r.text());
    const j = await r.json(); out.push(...j.value); next = j["@odata.nextLink"] || null;
  }
  return out;
}

export async function organization(env, tenantId) {
  const r = await graph(env, tenantId, "/organization?$select=id,displayName,verifiedDomains");
  if (!r.ok) throw graphError(r.status, "organization", await r.text());
  const o = (await r.json()).value[0];
  return { id: o.id, displayName: o.displayName, verifiedDomains: o.verifiedDomains.map(d => d.name.toLowerCase()) };
}

// For later, only if we ever cache (we don't today): /users/delta returns what changed since the last deltaLink, so a cache
// could be kept fresh, and leavers detected, without reading the whole directory. Store only the deltaLink, not the users.
export async function usersDelta(env, tenantId, deltaLink) {
  const path = deltaLink ? deltaLink.replace(GRAPH, "") : `/users/delta?$select=${USER_SELECT}`;
  const r = await graph(env, tenantId, path);
  if (!r.ok) throw graphError(r.status, "delta", await r.text());
  const j = await r.json();
  return { changes: j.value, next: j["@odata.nextLink"] || null, deltaLink: j["@odata.deltaLink"] || null };
}

// ------------------------------------------------------------ the card
// The same card shape the manual mode returns. Overrides (typed by the org's admin) win field by field.
export function mapUser(u, org, overrides = {}, map = {}) {
  const dir = {
    name: u.displayName || "", title: u.jobTitle || "", company: u.companyName || "",
    office: (u.businessPhones || [])[0] || "", email: u.mail || u.userPrincipalName || "",
    department: u.department || "", officeLocation: u.officeLocation || ""
  };
  const v = k => overrides[k] || dir[k];
  return {
    name: v("name"), title: v("title"), org: v("company") || org.company || org.name, office: v("office"), email: v("email"),
    department: map.department ? v("department") : "", location: map.officeLocation ? v("officeLocation") : ""
  };
}
export function isLeaver(u) { return !u || u.accountEnabled === false; }

// ------------------------------------------------------------ branding (logo)
// Each logo is a stream: /organization/{id}/branding/localizations/default/{bannerLogo|squareLogo|squareLogoDark}.
// 204/404 = not set. Returned as bytes for the admin console to run through logo.js (trim, measure) and PUT as a logo.
export async function brandingLogo(env, tenantId, which) {
  if (!["bannerLogo", "squareLogo", "squareLogoDark"].includes(which)) throw new Error("which");
  const r = await graph(env, tenantId, `/organization/${tenantId}/branding/localizations/default/${which}`, { headers: { "Accept-Language": "0" } });
  if (r.status === 204 || r.status === 404) return null;
  if (!r.ok) throw graphError(r.status, "branding", await r.text());
  return { type: r.headers.get("Content-Type") || "image/png", bytes: new Uint8Array(await r.arrayBuffer()) };
}

// The sign-in page's default branding properties: backgroundColor is offered as a quick start for the Primary brand colour.
export async function brandingInfo(env, tenantId) {
  const r = await graph(env, tenantId, `/organization/${tenantId}/branding?$select=backgroundColor`, { headers: { "Accept-Language": "0" } });
  if (r.status === 404) return null;
  if (!r.ok) throw graphError(r.status, "branding", await r.text());
  const j = await r.json();
  return { backgroundColor: /^#[0-9a-f]{6}$/i.test(j.backgroundColor || "") ? j.backgroundColor.toUpperCase() : null };
}

// ------------------------------------------------------------ "Sign in with Microsoft" (OIDC, delegated): phones, and admins
export function signInUrl(env, state, nonce, loginHint) {
  const u = new URL(`${LOGIN}/organizations/oauth2/v2.0/authorize`);
  u.searchParams.set("client_id", env.MS_CLIENT_ID);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", `${env.API_ORIGIN}/v1/auth/microsoft/callback`);
  u.searchParams.set("response_mode", "query");
  u.searchParams.set("scope", "openid profile email");
  u.searchParams.set("state", state); u.searchParams.set("nonce", nonce);
  if (loginHint) u.searchParams.set("login_hint", loginHint);
  return u.toString();
}
// Exchanges the code; returns the ID token's tid (tenant) and oid (user object ID). TODO: verify the ID token signature
// against the tenant's JWKS and check nonce, aud and iss before trusting tid/oid.
export async function redeemSignIn(env, code) {
  const r = await fetch(`${LOGIN}/organizations/oauth2/v2.0/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.MS_CLIENT_ID, client_secret: env.MS_CLIENT_SECRET, grant_type: "authorization_code",
      code, redirect_uri: `${env.API_ORIGIN}/v1/auth/microsoft/callback`, scope: "openid profile email" })
  });
  if (!r.ok) throw graphError(r.status, "signin", await r.text());
  const j = await r.json();
  const claims = JSON.parse(atob(j.id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
  return { tenantId: claims.tid, userId: claims.oid, nonce: claims.nonce, email: claims.email || claims.preferred_username || "" };
}
