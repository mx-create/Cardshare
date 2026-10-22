// Cardshare v2 (Teams) API on Cloudflare Workers + D1 + R2. SKELETON: not deployed, not load-tested.
// Every route and response shape matches the mock server in ../../sync.js, so the app switches over by setting
// window.CARDSHARE_API to this Worker's URL. Keep the two in step.
//
// Phone:  POST /v1/discover        {domain}             -> 200 {org:{name}|null}
//         POST /v1/auth/link       {email}              -> 202 {ok:true}   (the same answer for every address)
//         POST /v1/auth/verify     {token, device}      -> 200 {deviceToken, org:{name}} | 400
//         GET  /v1/card            Bearer device token  -> 200 {card, org, version} + ETag | 304 | 401 | 410
//         POST /v1/checkin         {version}            -> 200 {changed, version} | 401 | 410
//         POST /v1/auth/signout                         -> 204
// Logos:  GET  /v1/logos/<org>/<file>                   -> the image (public, immutable, versioned name)
//         GET  /v1/auth/microsoft/start?login_hint&return -> redirect to Microsoft sign-in (Microsoft-connected orgs)
//         GET  /v1/auth/microsoft/callback              -> redirect to <APP_ORIGIN>/?signin=<one-time token>
// Admin:  POST /v1/admin/auth/link {email} -> 202, POST /v1/admin/auth/verify {token} -> {sessionToken}
//         GET  /v1/admin/microsoft/connect?session      -> redirect to Microsoft admin consent
//         GET  /v1/admin/microsoft/callback             -> stores tenant ID, redirects to /admin/
//         POST /v1/admin/microsoft/disconnect | sync, GET /v1/admin/microsoft/branding
//         GET|PATCH /v1/admin/org, PUT|DELETE /v1/admin/logos/<variant>,
//         GET|POST /v1/admin/employees, PATCH|DELETE /v1/admin/employees/<id>,
//         POST /v1/admin/invite {ids}, GET /v1/admin/activity
//
// TODO before going live: rate limits (per IP and per address) on /discover and /auth/link, DNS-verified domains,
// server-side SVG sanitising, an email provider in sendMail(), admin roles, billing, data export and delete-my-data.

import * as MS from "./microsoft.js";

const LINK_TTL = 15 * 60 * 1000;          // a sign-in link the employee asked for
const INVITE_TTL = 7 * 24 * 60 * 60 * 1000; // a link sent by the admin
const SESSION_TTL = 12 * 60 * 60 * 1000;
const VARIANTS = ["horizontal", "mark", "markLight", "light", "dark"];

export default {
  async fetch(req, env) {
    const cors = corsHeaders(req, env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    let res;
    try { res = await route(req, env); }
    catch (e) { console.error(e); res = json(500, { error: "server_error" }); }
    const h = new Headers(res.headers);
    for (const [k, v] of Object.entries(cors)) h.set(k, v);
    return new Response(res.body, { status: res.status, headers: h });
  }
};

async function route(req, env) {
  const url = new URL(req.url), p = url.pathname, m = req.method, now = Date.now();
  const body = m === "POST" || m === "PATCH" || m === "PUT" ? await req.json().catch(() => ({})) : {};
  let x;

  // ------------------------------------------------------------ phone
  if (m === "POST" && p === "/v1/discover") {
    const domain = String(body.domain || "").trim().toLowerCase();
    const row = await env.DB.prepare(
      "SELECT o.name, o.source FROM domains d JOIN orgs o ON o.id = d.org_id WHERE d.domain = ? AND d.verified = 1 AND o.discoverable = 1"
    ).bind(domain).first();
    return json(200, { org: row ? { name: row.name, microsoft: row.source === "microsoft" } : null });
  }

  if (m === "POST" && p === "/v1/auth/link") {
    const email = String(body.email || "").trim().toLowerCase();
    const msOrg = await env.DB.prepare("SELECT o.id, t.tenant_id FROM domains d JOIN orgs o ON o.id = d.org_id JOIN ms_tenants t ON t.org_id = o.id WHERE d.domain = ? AND o.source = 'microsoft'")
      .bind(email.split("@").pop()).first();
    if (msOrg) {
      // Looked up in the directory, not in Cardshare: the link remembers only the tenant and the user object ID.
      const u = await MS.findUserByEmail(env, msOrg.tenant_id, email).catch(() => null);
      if (u && !MS.isLeaver(u)) {
        const token = randomToken("lnk_");
        await env.DB.prepare("INSERT INTO links (token_hash, org_id, ms_user_id, expires_at) VALUES (?, ?, ?, ?)").bind(await sha256(token), msOrg.id, u.id, now + LINK_TTL).run();
        await sendMail(env, email, "Your Cardshare sign-in link", signInText(env, token, u.displayName || ""));
      }
      return json(202, { ok: true });
    }
    const emp = await env.DB.prepare("SELECT id, name FROM employees WHERE email = ? AND removed_at IS NULL").bind(email).first();
    if (emp) {
      const token = randomToken("lnk_");
      await env.DB.prepare("INSERT INTO links (token_hash, employee_id, expires_at) VALUES (?, ?, ?)").bind(await sha256(token), emp.id, now + LINK_TTL).run();
      await sendMail(env, email, "Your Cardshare sign-in link", signInText(env, token, emp.name));
    }
    return json(202, { ok: true }); // never reveals whether the address is known
  }

  if (m === "POST" && p === "/v1/auth/verify") {
    const link = await takeLink(env, body.token, now);
    if (!link || (!link.employee_id && !link.ms_user_id)) return json(400, { error: "invalid_or_expired" });
    const hd = await holder(env, link);
    if (!hd) return json(400, { error: "invalid_or_expired" });
    const deviceToken = randomToken("dev_");
    const label = String((body.device && body.device.label) || "").slice(0, 80);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO devices (token_hash, employee_id, org_id, ms_user_id, label, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(await sha256(deviceToken), link.employee_id || null, hd.org.id, link.ms_user_id || null, label, now, now),
      // Microsoft mode: the log names no one, so it holds no staff details.
      logStmt(env, hd.org.id, link.ms_user_id ? "A phone signed in (Microsoft 365 user)" : hd.card.name + " signed in on a phone")
    ]);
    return json(200, { deviceToken, org: { name: hd.org.name } });
  }

  if ((m === "GET" && p === "/v1/card") || (m === "POST" && p === "/v1/checkin")) {
    const th = await sha256(bearer(req));
    const dev = await env.DB.prepare("SELECT employee_id, org_id, ms_user_id FROM devices WHERE token_hash = ?").bind(th).first();
    if (!dev) return json(401, { error: "signed_out" });
    // Manual: read from D1. Microsoft: read this one user from Graph now (pass-through), map, return, keep nothing.
    // A deleted or disabled user, a removed employee, or a disconnected org all answer 410 and the phone wipes the card.
    let hd;
    try { hd = await holder(env, dev); }
    catch (e) { return json(503, { error: "directory_unavailable" }); } // the phone keeps its cached card and tries later
    if (!hd) {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM devices WHERE token_hash = ?").bind(th),
        ...(dev.ms_user_id ? [env.DB.prepare("DELETE FROM ms_overrides WHERE org_id = ? AND ms_user_id = ?").bind(dev.org_id, dev.ms_user_id)] : [])
      ]);
      return json(410, { error: "removed" });
    }
    await env.DB.prepare("UPDATE devices SET last_seen = ? WHERE token_hash = ?").bind(now, th).run();
    const tag = `"c${await sha256(JSON.stringify(hd.card)).then(h => h.slice(0, 16))}-o${hd.org.brand_version}"`;
    if (p === "/v1/checkin") return json(200, { changed: body.version !== tag, version: tag });
    if (req.headers.get("If-None-Match") === tag) return new Response(null, { status: 304, headers: { ETag: tag } });
    const logos = await logoMap(env, url, hd.org);
    return json(200, { card: hd.card, org: { id: hd.org.id, name: hd.org.name, logos }, version: tag }, { ETag: tag, "Cache-Control": "no-cache" });
  }

  if (m === "POST" && p === "/v1/auth/signout") {
    await env.DB.prepare("DELETE FROM devices WHERE token_hash = ?").bind(await sha256(bearer(req))).run();
    return new Response(null, { status: 204 });
  }

  if (m === "GET" && (x = /^\/v1\/logos\/(org_[\w]+)\/([\w.-]+)$/.exec(p))) {
    const obj = await env.LOGOS.get(`logos/${x[1]}/${x[2]}`);
    if (!obj) return json(404, { error: "not_found" });
    return new Response(obj.body, { headers: {
      "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "X-Content-Type-Options": "nosniff"
    } });
  }

  // ------------------------------------------------------------ Microsoft: phone sign-in (OIDC)
  if (m === "GET" && p === "/v1/auth/microsoft/start") {
    const state = randomToken("st_"), nonce = randomToken("n_");
    const ret = safeReturn(env, url.searchParams.get("return"));
    await env.DB.prepare("INSERT INTO oauth_state (state, kind, nonce, return_to, expires_at) VALUES (?, 'signin', ?, ?, ?)").bind(state, nonce, ret, now + 600_000).run();
    return Response.redirect(MS.signInUrl(env, state, nonce, (url.searchParams.get("login_hint") || "").slice(0, 200)), 302);
  }
  if (m === "GET" && p === "/v1/auth/microsoft/callback") {
    const st = await takeState(env, url.searchParams.get("state"), "signin", now);
    if (!st || !url.searchParams.get("code")) return Response.redirect(`${env.APP_ORIGIN}/?signin_error=microsoft`, 302);
    const who = await MS.redeemSignIn(env, url.searchParams.get("code"));
    if (who.nonce !== st.nonce) return Response.redirect(`${env.APP_ORIGIN}/?signin_error=microsoft`, 302);
    const org = await env.DB.prepare("SELECT org_id FROM ms_tenants WHERE tenant_id = ?").bind(who.tenantId).first();
    if (!org) return Response.redirect(`${st.return_to}?signin_error=not_connected`, 302);
    // Same one-time link the email path uses, so the phone finishes with the usual POST /v1/auth/verify.
    const token = randomToken("lnk_");
    await env.DB.prepare("INSERT INTO links (token_hash, org_id, ms_user_id, expires_at) VALUES (?, ?, ?, ?)").bind(await sha256(token), org.org_id, who.userId, now + 5 * 60_000).run();
    return Response.redirect(`${st.return_to}?signin=${token}`, 302);
  }

  // ------------------------------------------------------------ Microsoft: admin consent
  if (m === "GET" && p === "/v1/admin/microsoft/connect") {
    const adm = await adminSession(env, url.searchParams.get("session"), now);
    if (!adm) return json(401, { error: "admin_signed_out" });
    const state = randomToken("st_");
    await env.DB.prepare("INSERT INTO oauth_state (state, kind, admin_id, expires_at) VALUES (?, 'consent', ?, ?)").bind(state, adm.admin_id, now + 600_000).run();
    return Response.redirect(MS.adminConsentUrl(env, state), 302);
  }
  if (m === "GET" && p === "/v1/admin/microsoft/callback") {
    const cb = MS.readConsentCallback(url);
    const st = await takeState(env, cb.state || url.searchParams.get("state"), "consent", now);
    if (!st) return Response.redirect(`${env.APP_ORIGIN}/admin/?microsoft=expired`, 302);
    if (!cb.ok) return Response.redirect(`${env.APP_ORIGIN}/admin/?microsoft=declined`, 302);
    const adm = await env.DB.prepare("SELECT id, org_id, email FROM admins WHERE id = ?").bind(st.admin_id).first();
    const info = await MS.organization(env, cb.tenantId); // also proves the consent works
    const taken = await env.DB.prepare("SELECT org_id FROM ms_tenants WHERE tenant_id = ? AND org_id != ?").bind(cb.tenantId, adm.org_id).first();
    if (taken) return Response.redirect(`${env.APP_ORIGIN}/admin/?microsoft=tenant_in_use`, 302);
    // Switching to Microsoft deletes everything typed by hand. Microsoft's verified domains replace the org's domains.
    // Signed-in phones are carried over: each hand-typed person's work email is looked up in the directory. A match moves
    // the device row to that Entra user (same token, so the phone stays signed in and gets the directory card at its next
    // check-in); no match deletes the device, so that phone's next check-in answers 401 and it wipes the work card.
    const { results: phones } = await env.DB.prepare(
      "SELECT d.token_hash, e.email FROM devices d JOIN employees e ON e.id = d.employee_id WHERE e.org_id = ?").bind(adm.org_id).all();
    const found = new Map();
    for (const em of new Set(phones.map(d => d.email))) {
      const u = await MS.findUserByEmail(env, cb.tenantId, em).catch(() => null);
      if (u && !MS.isLeaver(u)) found.set(em, u.id);
    }
    const moves = phones.map(d => found.has(d.email)
      ? env.DB.prepare("UPDATE devices SET employee_id = NULL, org_id = ?, ms_user_id = ? WHERE token_hash = ?").bind(adm.org_id, found.get(d.email), d.token_hash)
      : env.DB.prepare("DELETE FROM devices WHERE token_hash = ?").bind(d.token_hash));
    const kept = phones.filter(d => found.has(d.email)).length;
    await env.DB.batch([
      env.DB.prepare("INSERT OR REPLACE INTO ms_tenants (org_id, tenant_id, tenant_name, consented_by, consented_at, last_sync) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(adm.org_id, cb.tenantId, info.displayName, adm.email, now, now),
      env.DB.prepare("UPDATE orgs SET source = 'microsoft', brand_version = brand_version + 1 WHERE id = ?").bind(adm.org_id),
      ...moves,                                                     // before the employees are deleted
      env.DB.prepare("DELETE FROM links WHERE employee_id IN (SELECT id FROM employees WHERE org_id = ?)").bind(adm.org_id),
      env.DB.prepare("DELETE FROM employees WHERE org_id = ?").bind(adm.org_id),
      env.DB.prepare("DELETE FROM domains WHERE org_id = ?").bind(adm.org_id),
      ...info.verifiedDomains.map(d => env.DB.prepare("INSERT OR IGNORE INTO domains (domain, org_id, verified) VALUES (?, ?, 1)").bind(d, adm.org_id)),
      logStmt(env, adm.org_id, `Connected Microsoft 365 (${info.displayName}). Hand-typed records deleted; ${kept} of ${phones.length} signed-in phones kept`)
    ]);
    return Response.redirect(`${env.APP_ORIGIN}/admin/?microsoft=connected`, 302);
  }

  // ------------------------------------------------------------ admin
  if (m === "POST" && p === "/v1/admin/auth/link") {
    const email = String(body.email || "").trim().toLowerCase();
    const adm = await env.DB.prepare("SELECT id FROM admins WHERE email = ?").bind(email).first();
    if (adm) {
      const token = randomToken("adm_");
      await env.DB.prepare("INSERT INTO links (token_hash, admin_id, expires_at) VALUES (?, ?, ?)").bind(await sha256(token), adm.id, now + LINK_TTL).run();
      await sendMail(env, email, "Your Cardshare admin sign-in link", `Sign in to the admin console: ${env.APP_ORIGIN}/admin/?signin=${token}\n\nThe link works once, for 15 minutes.`);
    }
    return json(202, { ok: true });
  }
  if (m === "POST" && p === "/v1/admin/auth/verify") {
    const link = await takeLink(env, body.token, now);
    if (!link || !link.admin_id) return json(400, { error: "invalid_or_expired" });
    const sessionToken = randomToken("ses_");
    await env.DB.prepare("INSERT INTO admin_sessions (token_hash, admin_id, expires_at) VALUES (?, ?, ?)").bind(await sha256(sessionToken), link.admin_id, now + SESSION_TTL).run();
    return json(200, { sessionToken });
  }

  if (p.startsWith("/v1/admin/")) {
    const ses = await adminSession(env, bearer(req), now);
    if (!ses) return json(401, { error: "admin_signed_out" });
    const orgId = ses.org_id;
    const msT = await env.DB.prepare("SELECT t.* FROM ms_tenants t JOIN orgs o ON o.id = t.org_id WHERE t.org_id = ? AND o.source = 'microsoft'").bind(orgId).first();
    const NO_MS = json(409, { error: "People come from Microsoft 365. Add or remove them there." });

    if (m === "POST" && p === "/v1/admin/microsoft/disconnect") {
      if (!msT) return json(409, { error: "Not connected" });
      // Phones drop their cards at the next check-in (holder() finds no Microsoft connection → 410).
      // The admin should also remove the enterprise app in Entra; we can't revoke consent from here.
      await env.DB.batch([
        env.DB.prepare("DELETE FROM ms_tenants WHERE org_id = ?").bind(orgId),
        env.DB.prepare("DELETE FROM ms_overrides WHERE org_id = ?").bind(orgId),
        env.DB.prepare("DELETE FROM links WHERE org_id = ? AND ms_user_id IS NOT NULL").bind(orgId),
        env.DB.prepare("UPDATE orgs SET source = 'manual', brand_version = brand_version + 1 WHERE id = ?").bind(orgId),
        logStmt(env, orgId, `Disconnected Microsoft 365 (${msT.tenant_name})`)
      ]);
      return json(200, await orgView(env, url, orgId));
    }
    if (m === "POST" && p === "/v1/admin/microsoft/sync") {
      if (!msT) return json(409, { error: "Not connected" });
      const n = (await MS.listUsers(env, msT.tenant_id)).filter(u => u.accountEnabled).length;
      await env.DB.prepare("UPDATE ms_tenants SET last_sync = ?, people_found = ? WHERE org_id = ?").bind(now, n, orgId).run();
      return json(200, await orgView(env, url, orgId));
    }
    if (m === "GET" && p === "/v1/admin/microsoft/branding") {
      if (!msT) return json(409, { error: "Not connected" });
      // Returned as data: URLs for the console to run through logo.js and PUT as logos with source "microsoft".
      const out = {};
      for (const k of ["bannerLogo", "squareLogo", "squareLogoDark"]) {
        const l = await MS.brandingLogo(env, msT.tenant_id, k).catch(() => null);
        if (l) out[k] = `data:${l.type};base64,${btoa(String.fromCharCode(...l.bytes))}`;
      }
      return json(200, out);
    }

    if (m === "GET" && p === "/v1/admin/org") return json(200, await orgView(env, url, orgId));
    if (m === "PATCH" && p === "/v1/admin/org") {
      const org = await env.DB.prepare("SELECT * FROM orgs WHERE id = ?").bind(orgId).first();
      const stmts = [];
      let brand = false;
      const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : org.name;
      const company = typeof body.company === "string" ? body.company.trim() : org.company;
      if (name !== org.name || company !== org.company) brand = true;
      const disc = typeof body.discoverable === "boolean" ? (body.discoverable ? 1 : 0) : org.discoverable;
      const md = body.map && typeof body.map.department === "boolean" ? +body.map.department : org.map_department;
      const ml = body.map && typeof body.map.officeLocation === "boolean" ? +body.map.officeLocation : org.map_location;
      stmts.push(env.DB.prepare("UPDATE orgs SET name = ?, company = ?, discoverable = ?, map_department = ?, map_location = ?, brand_version = brand_version + ? WHERE id = ?")
        .bind(name, company, disc, md, ml, brand ? 1 : 0, orgId));
      if (Array.isArray(body.domains) && !msT) { // Microsoft: the tenant's verified domains are used instead
        const want = body.domains.map(s => String(s).trim().toLowerCase().replace(/^@/, "")).filter(s => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s));
        for (const d of want) {
          const other = await env.DB.prepare("SELECT org_id FROM domains WHERE domain = ?").bind(d).first();
          if (other && other.org_id !== orgId) return json(409, { error: d + " belongs to another organisation" });
        }
        stmts.push(env.DB.prepare(`DELETE FROM domains WHERE org_id = ? AND domain NOT IN (${want.map(() => "?").join(",") || "''"})`).bind(orgId, ...want));
        // New domains start unverified; a DNS TXT check (to build) sets verified = 1 before discovery uses them.
        for (const d of want) stmts.push(env.DB.prepare("INSERT OR IGNORE INTO domains (domain, org_id, verified) VALUES (?, ?, 0)").bind(d, orgId));
      }
      if (brand) stmts.push(logStmt(env, orgId, "Organisation details changed"));
      await env.DB.batch(stmts);
      return json(200, await orgView(env, url, orgId));
    }

    if ((x = /^\/v1\/admin\/logos\/(horizontal|mark|markLight|light|dark)$/.exec(p))) {
      const variant = x[1];
      if (m === "PUT") {
        const mm = /^data:(image\/(?:svg\+xml|png|webp|jpeg));base64,(.+)$/.exec(body.url || "");
        if (!mm) return json(415, { error: "SVG or PNG please" });
        const bytes = Uint8Array.from(atob(mm[2]), c => c.charCodeAt(0));
        if (bytes.length > 2 * 1024 * 1024) return json(413, { error: "Logo over 2 MB" });
        // TODO: sanitise SVG here too (the browser already strips scripts; never trust the client).
        const ver = (await env.DB.prepare("SELECT brand_version FROM orgs WHERE id = ?").bind(orgId).first()).brand_version + 1;
        const ext = mm[1] === "image/svg+xml" ? "svg" : "png", key = `logos/${orgId}/${variant}-${ver}.${ext}`;
        await env.LOGOS.put(key, bytes, { httpMetadata: { contentType: mm[1] } });
        await env.DB.batch([
          env.DB.prepare("INSERT OR REPLACE INTO logos (org_id, variant, source, r2_key, type, w, h, ratio, lum, vector, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(orgId, variant, body.source === "microsoft" ? "microsoft" : "upload", key, mm[1], +body.w || 0, +body.h || 0, +body.ratio || 0, Number.isFinite(+body.lum) ? +body.lum : null, body.vector ? 1 : 0, now),
          env.DB.prepare("UPDATE orgs SET brand_version = ? WHERE id = ?").bind(ver, orgId),
          logStmt(env, orgId, `Logo uploaded (${variant})`)
        ]);
      } else if (m === "DELETE") {
        const row = await env.DB.prepare("SELECT r2_key FROM logos WHERE org_id = ? AND variant = ?").bind(orgId, variant).first();
        if (row) await env.LOGOS.delete(row.r2_key);
        await env.DB.batch([
          env.DB.prepare("DELETE FROM logos WHERE org_id = ? AND variant = ?").bind(orgId, variant),
          env.DB.prepare("UPDATE orgs SET brand_version = brand_version + 1 WHERE id = ?").bind(orgId),
          logStmt(env, orgId, `Logo removed (${variant})`)
        ]);
      } else return json(405, { error: "method" });
      return json(200, await orgView(env, url, orgId));
    }

    if (m === "GET" && p === "/v1/admin/employees" && msT) {
      // Read live from the directory for this page and not stored; only the count is kept.
      const org = await env.DB.prepare("SELECT * FROM orgs WHERE id = ?").bind(orgId).first();
      const users = await MS.listUsers(env, msT.tenant_id);
      const ovs = await overridesFor(env, orgId);
      const { results: devs } = await env.DB.prepare("SELECT ms_user_id, COUNT(*) AS n, MAX(last_seen) AS last FROM devices WHERE org_id = ? AND ms_user_id IS NOT NULL GROUP BY ms_user_id").bind(orgId).all();
      const dm = Object.fromEntries(devs.map(d => [d.ms_user_id, d]));
      await env.DB.prepare("UPDATE ms_tenants SET last_sync = ?, people_found = ? WHERE org_id = ?").bind(now, users.filter(u => u.accountEnabled).length, orgId).run();
      return json(200, { source: "microsoft", employees: users.map(u => msView(u, org, ovs[u.id] || {}, dm[u.id])) });
    }
    if (m === "GET" && p === "/v1/admin/employees") {
      const { results } = await env.DB.prepare(
        `SELECT e.*, COUNT(d.token_hash) AS devices, MAX(d.last_seen) AS last_seen FROM employees e
         LEFT JOIN devices d ON d.employee_id = e.id WHERE e.org_id = ? AND e.removed_at IS NULL GROUP BY e.id ORDER BY e.created_at`
      ).bind(orgId).all();
      return json(200, { source: "manual", employees: results.map(empView) });
    }
    if (m === "POST" && p === "/v1/admin/employees") {
      if (msT) return NO_MS;
      const e = cleanEmp(body);
      if (!e.name || !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(e.email || "")) return json(400, { error: "A name and a work email are needed" });
      const dup = await env.DB.prepare("SELECT id FROM employees WHERE email = ? AND removed_at IS NULL").bind(e.email).first();
      if (dup) return json(409, { error: e.email + " is already added" });
      const id = randomToken("emp_").slice(0, 20);
      await env.DB.batch([
        env.DB.prepare("INSERT INTO employees (id, org_id, email, name, title, company, office, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .bind(id, orgId, e.email, e.name, e.title || "", e.company || "", e.office || "", now),
        logStmt(env, orgId, "Added " + e.name)
      ]);
      return json(201, empView(await env.DB.prepare("SELECT *, 0 AS devices, NULL AS last_seen FROM employees WHERE id = ?").bind(id).first()));
    }
    if ((x = /^\/v1\/admin\/employees\/([\w-]+)$/.exec(p)) && msT) {
      if (m === "DELETE") return NO_MS;
      if (m !== "PATCH") return json(405, { error: "method" });
      // Overrides: one row per field the admin typed; an empty value deletes the row so the directory value shows again.
      const fields = ["name", "title", "company", "office", "email", "department", "officeLocation"].filter(k => typeof body[k] === "string");
      const stmts = fields.map(k => body[k].trim()
        ? env.DB.prepare("INSERT OR REPLACE INTO ms_overrides (org_id, ms_user_id, field, value) VALUES (?, ?, ?, ?)").bind(orgId, x[1], k, body[k].trim().slice(0, 200))
        : env.DB.prepare("DELETE FROM ms_overrides WHERE org_id = ? AND ms_user_id = ? AND field = ?").bind(orgId, x[1], k));
      if (stmts.length) await env.DB.batch([...stmts, logStmt(env, orgId, "Overrides changed for 1 person")]);
      const u = await MS.getUser(env, msT.tenant_id, x[1]);
      if (!u) return json(404, { error: "not_found" });
      const org = await env.DB.prepare("SELECT * FROM orgs WHERE id = ?").bind(orgId).first();
      return json(200, msView(u, org, (await overridesFor(env, orgId))[u.id] || {}, null));
    }
    if ((x = /^\/v1\/admin\/employees\/([\w-]+)$/.exec(p))) {
      const cur = await env.DB.prepare("SELECT * FROM employees WHERE id = ? AND org_id = ? AND removed_at IS NULL").bind(x[1], orgId).first();
      if (!cur) return json(404, { error: "not_found" });
      if (m === "PATCH") {
        const ch = cleanEmp(body), what = Object.keys(ch).filter(k => ch[k] !== cur[k]);
        if (what.length) {
          const sets = what.map(k => `${k} = ?`).join(", ");
          await env.DB.batch([
            env.DB.prepare(`UPDATE employees SET ${sets}, version = version + 1 WHERE id = ?`).bind(...what.map(k => ch[k]), cur.id),
            logStmt(env, orgId, `Changed ${cur.name}'s ${what.join(", ")}`)
          ]);
        }
        const row = await env.DB.prepare("SELECT e.*, (SELECT COUNT(*) FROM devices WHERE employee_id = e.id) AS devices, (SELECT MAX(last_seen) FROM devices WHERE employee_id = e.id) AS last_seen FROM employees e WHERE id = ?").bind(cur.id).first();
        return json(200, empView(row));
      }
      if (m === "DELETE") {
        // The record is deleted outright; devices keep a null employee_id (ON DELETE SET NULL) so the next check-in answers 410.
        await env.DB.batch([
          env.DB.prepare("DELETE FROM employees WHERE id = ?").bind(cur.id),
          logStmt(env, orgId, `Removed ${cur.name}. Their details are deleted; their phone drops the work card at its next check-in`)
        ]);
        return new Response(null, { status: 204 });
      }
    }
    if (m === "POST" && p === "/v1/admin/invite") {
      let sent = 0;
      for (const id of (body.ids || []).slice(0, 500)) {
        if (msT) {
          const u = await MS.getUser(env, msT.tenant_id, id).catch(() => null);
          if (!u || MS.isLeaver(u)) continue;
          const token = randomToken("lnk_");
          await env.DB.prepare("INSERT INTO links (token_hash, org_id, ms_user_id, expires_at) VALUES (?, ?, ?, ?)").bind(await sha256(token), orgId, u.id, now + INVITE_TTL).run();
          await sendMail(env, u.mail || u.userPrincipalName, "Your work card is ready on Cardshare", signInText(env, token, u.displayName || ""));
          sent++; continue;
        }
        const e = await env.DB.prepare("SELECT id, email, name FROM employees WHERE id = ? AND org_id = ? AND removed_at IS NULL").bind(id, orgId).first();
        if (!e) continue;
        const token = randomToken("lnk_");
        await env.DB.batch([
          env.DB.prepare("INSERT INTO links (token_hash, employee_id, expires_at) VALUES (?, ?, ?)").bind(await sha256(token), e.id, now + INVITE_TTL),
          env.DB.prepare("UPDATE employees SET invited_at = ? WHERE id = ?").bind(now, e.id)
        ]);
        await sendMail(env, e.email, "Your work card is ready on Cardshare", signInText(env, token, e.name));
        sent++;
      }
      if (sent) await logStmt(env, orgId, `Sent sign-in links to ${sent} ${sent === 1 ? "person" : "people"}`).run();
      return json(200, { sent });
    }
    if (m === "GET" && p === "/v1/admin/activity") {
      const { results } = await env.DB.prepare("SELECT at, text AS t FROM activity WHERE org_id = ? ORDER BY at DESC LIMIT 30").bind(orgId).all();
      return json(200, { activity: results });
    }
  }

  return json(404, { error: "no_route" });
}

// ------------------------------------------------------------ who a device or link belongs to, checked live
// Returns {org, card} or null (removed, disabled, deleted, or the org no longer manages cards this way).
async function holder(env, h) {
  if (h.employee_id) {
    const e = await env.DB.prepare("SELECT * FROM employees WHERE id = ? AND removed_at IS NULL").bind(h.employee_id).first();
    if (!e) return null;
    const org = await env.DB.prepare("SELECT * FROM orgs WHERE id = ? AND source = 'manual'").bind(e.org_id).first();
    if (!org) return null;
    return { org, card: { name: e.name, title: e.title, org: e.company || org.company || org.name, office: e.office, email: e.email } };
  }
  if (h.ms_user_id) {
    const org = await env.DB.prepare("SELECT o.*, t.tenant_id FROM orgs o JOIN ms_tenants t ON t.org_id = o.id WHERE o.id = ? AND o.source = 'microsoft'").bind(h.org_id).first();
    if (!org) return null;
    const u = await MS.getUser(env, org.tenant_id, h.ms_user_id); // throws on Graph errors → 503, the phone keeps its card
    if (MS.isLeaver(u)) return null;
    const ov = (await overridesFor(env, org.id, h.ms_user_id))[h.ms_user_id] || {};
    return { org, card: MS.mapUser(u, org, ov, { department: !!org.map_department, officeLocation: !!org.map_location }) };
  }
  return null;
}
async function overridesFor(env, orgId, userId) {
  const q = userId
    ? env.DB.prepare("SELECT ms_user_id, field, value FROM ms_overrides WHERE org_id = ? AND ms_user_id = ?").bind(orgId, userId)
    : env.DB.prepare("SELECT ms_user_id, field, value FROM ms_overrides WHERE org_id = ?").bind(orgId);
  const out = {};
  for (const r of (await q.all()).results) (out[r.ms_user_id] ||= {})[r.field] = r.value;
  return out;
}
function msView(u, org, ov, dev) {
  const dir = { name: u.displayName || "", title: u.jobTitle || "", company: u.companyName || "", office: (u.businessPhones || [])[0] || "",
    email: u.mail || u.userPrincipalName || "", department: u.department || "", officeLocation: u.officeLocation || "" };
  const eff = Object.fromEntries(Object.keys(dir).map(k => [k, ov[k] || dir[k]]));
  if (!eff.company) eff.company = org.company || org.name;
  return { id: u.id, source: "microsoft", accountEnabled: u.accountEnabled !== false, dir, overrides: ov, ...eff,
    blanks: ["title", "office", "company"].filter(k => !dir[k]), invitedAt: null, devices: dev ? dev.n : 0, lastSeen: dev ? dev.last : null };
}
async function adminSession(env, token, now) {
  if (!token) return null;
  return env.DB.prepare("SELECT s.admin_id, a.org_id FROM admin_sessions s JOIN admins a ON a.id = s.admin_id WHERE s.token_hash = ? AND s.expires_at > ?").bind(await sha256(token), now).first();
}
async function takeState(env, state, kind, now) {
  if (!state) return null;
  return env.DB.prepare("DELETE FROM oauth_state WHERE state = ? AND kind = ? AND expires_at > ? RETURNING *").bind(state, kind, now).first();
}
function safeReturn(env, r) {
  try { const u = new URL(r); if (u.origin === env.APP_ORIGIN || /^https:\/\/[\w-]+\.cardshare\.pages\.dev$/.test(u.origin)) return u.origin + u.pathname; } catch (e) {}
  return env.APP_ORIGIN + "/";
}

// ------------------------------------------------------------ helpers
function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}
function corsHeaders(req, env) {
  const origin = req.headers.get("Origin") || "";
  const ok = origin === env.APP_ORIGIN || /^https:\/\/[\w-]+\.cardshare\.pages\.dev$/.test(origin); // + branch previews
  return ok ? {
    "Access-Control-Allow-Origin": origin, "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, If-None-Match",
    "Access-Control-Expose-Headers": "ETag"
  } : {};
}
function bearer(req) { const a = req.headers.get("Authorization") || ""; return a.startsWith("Bearer ") ? a.slice(7) : ""; }
function randomToken(prefix) { const a = crypto.getRandomValues(new Uint8Array(24)); return prefix + [...a].map(b => b.toString(16).padStart(2, "0")).join(""); }
async function sha256(s) { const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s || ""))); return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join(""); }
async function takeLink(env, token, now) {
  if (!token) return null;
  // One statement, so a link can only be used once even if opened twice at the same moment.
  return env.DB.prepare("UPDATE links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING employee_id, org_id, ms_user_id, admin_id")
    .bind(now, await sha256(token), now).first();
}
function logStmt(env, orgId, text) { return env.DB.prepare("INSERT INTO activity (org_id, at, text) VALUES (?, ?, ?)").bind(orgId, Date.now(), text); }
function cleanEmp(b) {
  const out = {};
  for (const k of ["name", "title", "office", "email", "company"]) if (typeof b[k] === "string") out[k] = b[k].trim().slice(0, 200);
  if (out.email) out.email = out.email.toLowerCase();
  return out;
}
function empView(r) {
  return { id: r.id, orgId: r.org_id, name: r.name, title: r.title, company: r.company, office: r.office, email: r.email, version: r.version,
    invitedAt: r.invited_at, removedAt: r.removed_at, createdAt: r.created_at, devices: r.devices || 0, lastSeen: r.last_seen || null };
}
async function logoMap(env, url, org) {
  const { results } = await env.DB.prepare("SELECT * FROM logos WHERE org_id = ?").bind(org.id).all();
  const out = {};
  for (const l of results) out[l.variant] = { url: `${url.origin}/v1/${l.r2_key}`, type: l.type, w: l.w, h: l.h, ratio: l.ratio, lum: l.lum, vector: !!l.vector, source: l.source };
  return out;
}
async function orgView(env, url, orgId) {
  const o = await env.DB.prepare("SELECT * FROM orgs WHERE id = ?").bind(orgId).first();
  const { results } = await env.DB.prepare("SELECT domain FROM domains WHERE org_id = ?").bind(orgId).all();
  const t = await env.DB.prepare("SELECT * FROM ms_tenants WHERE org_id = ?").bind(orgId).first();
  return { id: o.id, name: o.name, company: o.company, discoverable: !!o.discoverable, brandVersion: o.brand_version,
    source: o.source, map: { department: !!o.map_department, officeLocation: !!o.map_location },
    ms: o.source === "microsoft" && t ? { tenantId: t.tenant_id, tenantName: t.tenant_name, consentedBy: t.consented_by, connectedAt: t.consented_at,
      lastSync: t.last_sync, peopleFound: t.people_found, permissions: ["User.Read.All (application)", "OrganizationalBranding.Read.All (application, for the logo)"] } : null,
    domains: results.map(r => r.domain), logos: await logoMap(env, url, o) };
}
function signInText(env, token, name) {
  return `Hi ${name},\n\nTap this link on your phone to put your work card on Cardshare:\n${env.APP_ORIGIN}/?signin=${token}\n\n` +
    `Your Personal card and Links stay on your phone; only your work card comes from your organisation.\n` +
    `If you didn't ask for this, ignore this email.`;
}
async function sendMail(env, to, subject, text) {
  // TODO: wire an email provider (for example via fetch to its HTTP API with env.MAIL_API_KEY). Never log the token.
  if (!env.MAIL_API_KEY) { console.log(`[mail disabled] would send "${subject}" to ${to}`); return; }
  throw new Error("sendMail not implemented");
}
