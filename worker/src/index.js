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
// Admin:  POST /v1/admin/auth/link {email} -> 202, POST /v1/admin/auth/verify {token} -> {sessionToken}
//         GET|PATCH /v1/admin/org, PUT|DELETE /v1/admin/logos/<variant>,
//         GET|POST /v1/admin/employees, PATCH|DELETE /v1/admin/employees/<id>,
//         POST /v1/admin/invite {ids}, GET /v1/admin/activity
//
// TODO before going live: rate limits (per IP and per address) on /discover and /auth/link, DNS-verified domains,
// server-side SVG sanitising, an email provider in sendMail(), admin roles, billing, data export and delete-my-data.

const LINK_TTL = 15 * 60 * 1000;          // a sign-in link the employee asked for
const INVITE_TTL = 7 * 24 * 60 * 60 * 1000; // a link sent by the admin
const SESSION_TTL = 12 * 60 * 60 * 1000;
const VARIANTS = ["horizontal", "mark", "light", "dark"];

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
      "SELECT o.name FROM domains d JOIN orgs o ON o.id = d.org_id WHERE d.domain = ? AND d.verified = 1 AND o.discoverable = 1"
    ).bind(domain).first();
    return json(200, { org: row ? { name: row.name } : null });
  }

  if (m === "POST" && p === "/v1/auth/link") {
    const email = String(body.email || "").trim().toLowerCase();
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
    if (!link || !link.employee_id) return json(400, { error: "invalid_or_expired" });
    const emp = await env.DB.prepare("SELECT e.id, e.org_id, e.name, o.name AS org_name FROM employees e JOIN orgs o ON o.id = e.org_id WHERE e.id = ? AND e.removed_at IS NULL").bind(link.employee_id).first();
    if (!emp) return json(400, { error: "invalid_or_expired" });
    const deviceToken = randomToken("dev_");
    const label = String((body.device && body.device.label) || "").slice(0, 80);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO devices (token_hash, employee_id, label, created_at, last_seen) VALUES (?, ?, ?, ?, ?)").bind(await sha256(deviceToken), emp.id, label, now, now),
      logStmt(env, emp.org_id, emp.name + " signed in on a phone")
    ]);
    return json(200, { deviceToken, org: { name: emp.org_name } });
  }

  if ((m === "GET" && p === "/v1/card") || (m === "POST" && p === "/v1/checkin")) {
    const th = await sha256(bearer(req));
    const dev = await env.DB.prepare("SELECT employee_id FROM devices WHERE token_hash = ?").bind(th).first();
    if (!dev) return json(401, { error: "signed_out" });
    const emp = await env.DB.prepare("SELECT * FROM employees WHERE id = ?").bind(dev.employee_id).first();
    if (!emp || emp.removed_at) {
      await env.DB.prepare("DELETE FROM devices WHERE token_hash = ?").bind(th).run();
      return json(410, { error: "removed" });
    }
    await env.DB.prepare("UPDATE devices SET last_seen = ? WHERE token_hash = ?").bind(now, th).run();
    const org = await env.DB.prepare("SELECT * FROM orgs WHERE id = ?").bind(emp.org_id).first();
    const tag = `"e${emp.version}-o${org.brand_version}"`;
    if (p === "/v1/checkin") return json(200, { changed: body.version !== tag, version: tag });
    if (req.headers.get("If-None-Match") === tag) return new Response(null, { status: 304, headers: { ETag: tag } });
    const logos = await logoMap(env, url, org);
    return json(200, {
      card: { name: emp.name, title: emp.title, org: emp.company || org.company || org.name, office: emp.office, email: emp.email },
      org: { id: org.id, name: org.name, logos },
      version: tag
    }, { ETag: tag, "Cache-Control": "no-cache" });
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
    const ses = await env.DB.prepare("SELECT a.org_id FROM admin_sessions s JOIN admins a ON a.id = s.admin_id WHERE s.token_hash = ? AND s.expires_at > ?").bind(await sha256(bearer(req)), now).first();
    if (!ses) return json(401, { error: "admin_signed_out" });
    const orgId = ses.org_id;

    if (m === "GET" && p === "/v1/admin/org") return json(200, await orgView(env, url, orgId));
    if (m === "PATCH" && p === "/v1/admin/org") {
      const org = await env.DB.prepare("SELECT * FROM orgs WHERE id = ?").bind(orgId).first();
      const stmts = [];
      let brand = false;
      const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : org.name;
      const company = typeof body.company === "string" ? body.company.trim() : org.company;
      if (name !== org.name || company !== org.company) brand = true;
      const disc = typeof body.discoverable === "boolean" ? (body.discoverable ? 1 : 0) : org.discoverable;
      stmts.push(env.DB.prepare("UPDATE orgs SET name = ?, company = ?, discoverable = ?, brand_version = brand_version + ? WHERE id = ?").bind(name, company, disc, brand ? 1 : 0, orgId));
      if (Array.isArray(body.domains)) {
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

    if ((x = /^\/v1\/admin\/logos\/(horizontal|mark|light|dark)$/.exec(p))) {
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
          env.DB.prepare("INSERT OR REPLACE INTO logos (org_id, variant, r2_key, type, w, h, ratio, lum, vector, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(orgId, variant, key, mm[1], +body.w || 0, +body.h || 0, +body.ratio || 0, Number.isFinite(+body.lum) ? +body.lum : null, body.vector ? 1 : 0, now),
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

    if (m === "GET" && p === "/v1/admin/employees") {
      const { results } = await env.DB.prepare(
        `SELECT e.*, COUNT(d.token_hash) AS devices, MAX(d.last_seen) AS last_seen FROM employees e
         LEFT JOIN devices d ON d.employee_id = e.id WHERE e.org_id = ? AND e.removed_at IS NULL GROUP BY e.id ORDER BY e.created_at`
      ).bind(orgId).all();
      return json(200, { employees: results.map(empView) });
    }
    if (m === "POST" && p === "/v1/admin/employees") {
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
        // Devices are kept until their next check-in, which answers 410 so the phone wipes the work card.
        await env.DB.batch([
          env.DB.prepare("UPDATE employees SET removed_at = ?, version = version + 1 WHERE id = ?").bind(now, cur.id),
          logStmt(env, orgId, `Removed ${cur.name}. Their phone drops the work card at its next check-in`)
        ]);
        return new Response(null, { status: 204 });
      }
    }
    if (m === "POST" && p === "/v1/admin/invite") {
      let sent = 0;
      for (const id of (body.ids || []).slice(0, 500)) {
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
  return env.DB.prepare("UPDATE links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING employee_id, admin_id")
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
  for (const l of results) out[l.variant] = { url: `${url.origin}/v1/${l.r2_key}`, type: l.type, w: l.w, h: l.h, ratio: l.ratio, lum: l.lum, vector: !!l.vector };
  return out;
}
async function orgView(env, url, orgId) {
  const o = await env.DB.prepare("SELECT * FROM orgs WHERE id = ?").bind(orgId).first();
  const { results } = await env.DB.prepare("SELECT domain FROM domains WHERE org_id = ?").bind(orgId).all();
  return { id: o.id, name: o.name, company: o.company, discoverable: !!o.discoverable, brandVersion: o.brand_version,
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
