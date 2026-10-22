// Cardshare v2 API: admin accounts, organisations, sign-up, domain verification, branding and the platform console.
// STUB: not deployed, never run. Same routes and shapes as the mock in ../../sync.js.
//
// Admin accounts are people (one email), not organisations: an admin can belong to several organisations through
// `memberships`, as Owner or Admin. A session is for one admin and one current organisation (admin_sessions.org_id);
// every /v1/admin/* query is scoped to that organisation, so an admin only ever sees their own organisation's data.
// Owners: connect/disconnect Microsoft 365, verify domains, manage admins. Admins: people, branding, logo, settings.

const DAY = 24 * 60 * 60 * 1000;
const FREEMAIL = /^(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|aol|proton|protonmail)\.[a-z.]+$/;
const HEX = /^#[0-9A-Fa-f]{6}$/;

// Branding as stored (orgs.branding_json). Colours must be #RRGGBB, options from fixed lists; anything else is refused.
// Phones apply their own contrast safety net (brand.js resolve()), so a failing pair saved here never ships unreadable.
export function cleanBranding(b) {
  if (!b || typeof b !== "object") return null;
  const keys = ["primary", "accent", "card", "text", "buttonText"];
  const set = src => { if (!src) return null; const o = {}; for (const k of keys) { if (!HEX.test(src[k] || "")) return null; o[k] = src[k].toUpperCase(); } return o; };
  const light = set(b.light); if (!light) return null;
  const darkAuto = b.darkAuto !== false, dark = darkAuto ? null : set(b.dark);
  return { light, dark, darkAuto: darkAuto || !dark,
    radius: ["sharp", "soft", "round"].includes(b.radius) ? b.radius : "soft",
    cardStyle: ["brand", "light", "dark"].includes(b.cardStyle) ? b.cardStyle : "brand",
    logoPlace: b.logoPlace === "left" ? "left" : "centre",
    font: ["inter", "serif", "geometric", "system"].includes(b.font) ? b.font : "inter" };
}

export async function me(env, ses) {
  const a = await env.DB.prepare("SELECT id, name, email FROM admins WHERE id = ?").bind(ses.admin_id).first();
  const { results } = await env.DB.prepare(
    "SELECT o.id, o.name, o.status, o.source, m.role FROM memberships m JOIN orgs o ON o.id = m.org_id WHERE m.admin_id = ? ORDER BY o.name").bind(ses.admin_id).all();
  const cur = results.find(o => o.id === ses.org_id) || results[0] || null;
  return { admin: a, orgs: results, orgId: cur ? cur.id : null, role: cur ? cur.role : null };
}

// Returns a Response, or null when the route isn't one of these. h = helpers from index.js.
export async function route(req, env, ctx, h) {
  const { url, p, m, body, now } = ctx, { json, sha256, randomToken, takeLink, sendMail, logStmt, orgView, bearer } = h;
  let x;

  // ------------------------------------------------------------ sign-up: work email → verify → name → (domain, source, branding in the console)
  if (m === "POST" && p === "/v1/signup/start") {
    const email = String(body.email || "").trim().toLowerCase(), domain = email.split("@")[1] || "";
    if (!/^[^@\s]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) return json(400, { error: "Enter your work email, like name@company.com." });
    if (FREEMAIL.test(domain)) return json(400, { error: `Use your work email. Personal addresses like ${domain} can't own an organisation.` });
    const token = randomToken("sgl_");
    await env.DB.prepare("INSERT INTO links (token_hash, kind, email, expires_at) VALUES (?, 'signup', ?, ?)").bind(await sha256(token), email, now + 60 * 60_000).run();
    await sendMail(env, email, "Set up Cardshare for your organisation", `Confirm it's you: ${env.APP_ORIGIN}/admin/?signup=${token}\n\nThe link works once, for an hour.`);
    return json(202, { ok: true });
  }
  if (m === "POST" && p === "/v1/signup/verify") {
    const link = await takeLink(env, body.token, now);
    if (!link || link.kind !== "signup") return json(400, { error: "That link has expired or was already used." });
    const signupToken = randomToken("sgn_"), domain = link.email.split("@")[1];
    await env.DB.prepare("INSERT INTO signups (token_hash, email, expires_at) VALUES (?, ?, ?)").bind(await sha256(signupToken), link.email, now + 60 * 60_000).run();
    const taken = await env.DB.prepare("SELECT o.name FROM domains d JOIN orgs o ON o.id = d.org_id WHERE d.domain = ?").bind(domain).first();
    return json(200, { signupToken, email: link.email, domain, taken: taken ? taken.name : null });
  }
  if (m === "POST" && p === "/v1/signup/org") {
    const sg = await env.DB.prepare("DELETE FROM signups WHERE token_hash = ? AND expires_at > ? RETURNING email").bind(await sha256(body.signupToken), now).first();
    if (!sg) return json(400, { error: "Your sign-up has expired. Start again." });
    const name = String(body.name || "").trim().slice(0, 80); if (!name) return json(400, { error: "Name your organisation." });
    const domain = sg.email.split("@")[1];
    const taken = await env.DB.prepare("SELECT o.name FROM domains d JOIN orgs o ON o.id = d.org_id WHERE d.domain = ?").bind(domain).first();
    if (taken) return json(409, { error: `${domain} already uses Cardshare (${taken.name}). Ask its owner to add you as an admin.` });
    const orgId = "org_" + randomToken("").slice(0, 16);
    let adm = await env.DB.prepare("SELECT id FROM admins WHERE email = ?").bind(sg.email).first();
    const adminId = adm ? adm.id : "adm_" + randomToken("").slice(0, 16);
    const sessionToken = randomToken("ses_");
    await env.DB.batch([
      env.DB.prepare("INSERT INTO orgs (id, name, company, created_at) VALUES (?, ?, ?, ?)").bind(orgId, name, name, now),
      env.DB.prepare("INSERT INTO domains (domain, org_id, verified, txt_token) VALUES (?, ?, 0, ?)").bind(domain, orgId, "cardshare-verify=" + randomToken("").slice(0, 20)),
      ...(adm ? [] : [env.DB.prepare("INSERT INTO admins (id, email, name, created_at) VALUES (?, ?, ?, ?)").bind(adminId, sg.email, sg.email.split("@")[0], now)]),
      env.DB.prepare("INSERT INTO memberships (admin_id, org_id, role) VALUES (?, ?, 'owner')").bind(adminId, orgId),
      env.DB.prepare("INSERT INTO admin_sessions (token_hash, admin_id, org_id, expires_at) VALUES (?, ?, ?, ?)").bind(await sha256(sessionToken), adminId, orgId, now + 12 * 60 * 60_000),
      logStmt(env, orgId, `${name} set up by ${sg.email}`)
    ]);
    return json(201, { sessionToken, ...(await me(env, { admin_id: adminId, org_id: orgId })) });
  }
  // Sign-up for a domain that's already taken: ask the organisation's owners to add this person as an Admin.
  // Owners get an email and see it under Admins in the console. Same answer whether or not a request already exists.
  if (m === "POST" && p === "/v1/signup/request") {
    const sg = await env.DB.prepare("SELECT email FROM signups WHERE token_hash = ? AND expires_at > ?").bind(await sha256(body.signupToken), now).first();
    if (!sg) return json(400, { error: "Your sign-up has expired. Start again." });
    const org = await env.DB.prepare("SELECT o.id, o.name FROM domains d JOIN orgs o ON o.id = d.org_id WHERE d.domain = ?").bind(sg.email.split("@")[1]).first();
    if (!org) return json(404, { error: "No organisation uses that domain." });
    const ins = await env.DB.prepare("INSERT OR IGNORE INTO access_requests (id, org_id, email, created_at, status) VALUES (?, ?, ?, ?, 'pending')")
      .bind("req_" + randomToken("").slice(0, 16), org.id, sg.email, now).run();
    if (ins.meta && ins.meta.changes) {
      await logStmt(env, org.id, `${sg.email} asked to join as an admin (waiting for an owner)`).run();
      const { results: owners } = await env.DB.prepare("SELECT a.email FROM memberships m JOIN admins a ON a.id = m.admin_id WHERE m.org_id = ? AND m.role = 'owner'").bind(org.id).all();
      for (const o of owners) await sendMail(env, o.email, `${sg.email} asked to join ${org.name} on Cardshare`, `Approve or decline in the admin console: ${env.APP_ORIGIN}/admin/`);
    }
    return json(202, { org: org.name });
  }
  // The emailed fallback for domain ownership: a link sent to admin@, postmaster@ or webmaster@<domain> (the admin picks).
  if (m === "POST" && p === "/v1/domains/confirm") {
    const link = await takeLink(env, body.token, now);
    if (!link || link.kind !== "domain") return json(400, { error: "That link has expired or was already used." });
    await env.DB.batch([
      env.DB.prepare("UPDATE domains SET verified = 1, method = 'email', verified_at = ? WHERE domain = ? AND org_id = ?").bind(now, link.domain, link.org_id),
      logStmt(env, link.org_id, `${link.domain} verified by email`)
    ]);
    return json(200, { domain: link.domain, verified: true });
  }

  // ------------------------------------------------------------ platform console (Cardshare staff)
  // Sign-in: an emailed link, only for addresses in PLATFORM_OWNERS. Counts only; never staff details.
  if (m === "POST" && p === "/v1/platform/auth/link") {
    const email = String(body.email || "").trim().toLowerCase();
    if (String(env.PLATFORM_OWNERS || "").split(",").map(s => s.trim().toLowerCase()).includes(email)) {
      const token = randomToken("plt_");
      await env.DB.prepare("INSERT INTO links (token_hash, kind, email, expires_at) VALUES (?, 'platform', ?, ?)").bind(await sha256(token), email, now + 15 * 60_000).run();
      await sendMail(env, email, "Cardshare platform console", `${env.APP_ORIGIN}/admin/platform/?signin=${token}`);
    }
    return json(202, { ok: true });
  }
  if (m === "POST" && p === "/v1/platform/auth/verify") {
    const link = await takeLink(env, body.token, now);
    if (!link || link.kind !== "platform") return json(400, { error: "invalid_or_expired" });
    const token = randomToken("pls_");
    await env.DB.prepare("INSERT INTO platform_sessions (token_hash, email, expires_at) VALUES (?, ?, ?)").bind(await sha256(token), link.email, now + 4 * 60 * 60_000).run();
    return json(200, { token });
  }
  if (p.startsWith("/v1/platform/")) {
    const ok = await env.DB.prepare("SELECT email FROM platform_sessions WHERE token_hash = ? AND expires_at > ?").bind(await sha256(bearer(req)), now).first();
    if (!ok) return json(401, { error: "platform_signed_out" });
    if (m === "GET" && p === "/v1/platform/orgs") {
      const { results } = await env.DB.prepare(`
        SELECT o.id, o.name, o.source, o.status, o.plan, o.created_at AS createdAt, t.tenant_name AS tenantName,
          (SELECT COUNT(*) FROM devices d WHERE d.org_id = o.id OR d.employee_id IN (SELECT id FROM employees WHERE org_id = o.id)) AS phones,
          CASE WHEN o.source = 'microsoft' THEN NULL ELSE (SELECT COUNT(*) FROM employees e WHERE e.org_id = o.id) END AS storedPeople,
          (SELECT COUNT(*) FROM memberships mm WHERE mm.org_id = o.id) AS admins
        FROM orgs o LEFT JOIN ms_tenants t ON t.org_id = o.id ORDER BY o.created_at`).all();
      const { results: doms } = await env.DB.prepare("SELECT domain AS name, org_id, verified, method FROM domains").all();
      return json(200, { orgs: results.map(o => ({ ...o, domains: doms.filter(d => d.org_id === o.id).map(d => ({ name: d.name, verified: !!d.verified, method: d.method })) })) });
    }
    if ((x = /^\/v1\/platform\/orgs\/([\w-]+)(?:\/(suspend|restore))?$/.exec(p))) {
      if (m === "POST" && x[2]) {
        const status = x[2] === "suspend" ? "suspended" : "active";
        await env.DB.batch([env.DB.prepare("UPDATE orgs SET status = ? WHERE id = ?").bind(status, x[1]), logStmt(env, x[1], x[2] === "suspend" ? "Suspended by Cardshare" : "Restored by Cardshare")]);
        return json(200, { id: x[1], status });
      }
      if (m === "DELETE" && !x[2]) {
        // Cascades remove domains, employees, memberships, links, logos, overrides and activity. Device rows keep a
        // dangling org_id on purpose: the next check-in finds no organisation, answers 410, and the phone wipes the card.
        // TODO: delete the org's R2 logo objects (logos/<org_id>/*).
        await env.DB.prepare("DELETE FROM orgs WHERE id = ?").bind(x[1]).run();
        return new Response(null, { status: 204 });
      }
    }
    return json(404, { error: "no_route" });
  }

  // ------------------------------------------------------------ admin session, organisation switcher, admins, domains, branding
  if (!p.startsWith("/v1/admin/")) return null;
  const ses = ctx.ses; if (!ses) return null; // index.js checks the session first
  if (m === "GET" && p === "/v1/admin/me") return json(200, await me(env, ses));
  if (m === "POST" && p === "/v1/admin/auth/signout") { await env.DB.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").bind(await sha256(bearer(req))).run(); return new Response(null, { status: 204 }); }
  if (m === "POST" && p === "/v1/admin/session/org") {
    const mem = await env.DB.prepare("SELECT role FROM memberships WHERE admin_id = ? AND org_id = ?").bind(ses.admin_id, body.orgId).first();
    if (!mem) return json(403, { error: "You're not an admin of that organisation." });
    await env.DB.prepare("UPDATE admin_sessions SET org_id = ? WHERE token_hash = ?").bind(body.orgId, await sha256(bearer(req))).run();
    return json(200, await me(env, { admin_id: ses.admin_id, org_id: body.orgId }));
  }
  const orgId = ses.org_id, owner = ses.role === "owner";
  if (m === "PUT" && p === "/v1/admin/branding") {
    let b = null;
    if (!body.reset) { b = cleanBranding(body); if (!b) return json(400, { error: "Colours must be hex, like #1F3A5F." }); }
    // brand_version is part of every card's ETag, so phones download the new branding at their next check-in.
    await env.DB.batch([
      env.DB.prepare("UPDATE orgs SET branding_json = ?, brand_version = brand_version + 1 WHERE id = ?").bind(b ? JSON.stringify(b) : null, orgId),
      logStmt(env, orgId, body.reset ? "Branding reset to the Cardshare look" : "Branding changed")
    ]);
    return json(200, await orgView(env, url, orgId));
  }
  if (m === "POST" && p === "/v1/admin/domains/verify") {
    if (!owner) return json(403, { error: "Only an owner can do that." });
    const d = await env.DB.prepare("SELECT * FROM domains WHERE domain = ? AND org_id = ?").bind(String(body.domain || "").toLowerCase(), orgId).first();
    if (!d) return json(404, { error: "not_found" });
    if (d.verified) return json(200, await orgView(env, url, orgId));
    if (body.method === "dns") {
      // TXT record at _cardshare.<domain>, looked up over DNS-over-HTTPS.
      const r = await fetch(`https://cloudflare-dns.com/dns-query?name=_cardshare.${encodeURIComponent(d.domain)}&type=TXT`, { headers: { Accept: "application/dns-json" } });
      const j = await r.json().catch(() => ({}));
      const found = (j.Answer || []).some(a => String(a.data || "").replace(/"/g, "").trim() === d.txt_token);
      if (!found) return json(409, { error: `No TXT record with ${d.txt_token} at _cardshare.${d.domain} yet. DNS changes can take a while; try again later.` });
      await env.DB.batch([env.DB.prepare("UPDATE domains SET verified = 1, method = 'dns', verified_at = ? WHERE domain = ?").bind(now, d.domain), logStmt(env, orgId, `${d.domain} verified by DNS record`)]);
      return json(200, await orgView(env, url, orgId));
    }
    if (body.method === "email") {
      const box = body.to || "admin";
      if (!["admin", "postmaster", "webmaster"].includes(box)) return json(400, { error: "Choose admin@, postmaster@ or webmaster@." });
      const to = `${box}@${d.domain}`, token = randomToken("dom_");
      await env.DB.prepare("INSERT INTO links (token_hash, kind, org_id, domain, expires_at) VALUES (?, 'domain', ?, ?, ?)").bind(await sha256(token), orgId, d.domain, now + DAY).run();
      await sendMail(env, to, `Confirm ${d.domain} for Cardshare`, `Someone set up Cardshare for ${d.domain}. If that's your organisation, confirm: ${env.APP_ORIGIN}/admin/?domain=${token}`);
      return json(202, { sent: to });
    }
    return json(400, { error: "method" });
  }
  if (m === "GET" && p === "/v1/admin/admins") {
    const { results } = await env.DB.prepare("SELECT a.id, a.name, a.email, m.role FROM memberships m JOIN admins a ON a.id = m.admin_id WHERE m.org_id = ? ORDER BY a.email").bind(orgId).all();
    const { results: requests } = await env.DB.prepare("SELECT id, email, created_at AS at FROM access_requests WHERE org_id = ? AND status = 'pending' ORDER BY created_at").bind(orgId).all();
    return json(200, { admins: results.map(a => ({ ...a, you: a.id === ses.admin_id })), requests });
  }
  if ((x = /^\/v1\/admin\/requests\/([\w-]+)\/(approve|decline)$/.exec(p)) && m === "POST") {
    if (!owner) return json(403, { error: "Only an owner can do that." });
    const rq = await env.DB.prepare("SELECT * FROM access_requests WHERE id = ? AND org_id = ? AND status = 'pending'").bind(x[1], orgId).first();
    if (!rq) return json(404, { error: "not_found" });
    const approve = x[2] === "approve", stmts = [
      env.DB.prepare("UPDATE access_requests SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?").bind(approve ? "approved" : "declined", ses.admin_id, now, rq.id),
      logStmt(env, orgId, approve ? `${rq.email}'s request approved: added as Admin` : `${rq.email}'s request declined`)];
    if (approve) {
      const a = await env.DB.prepare("SELECT id FROM admins WHERE email = ?").bind(rq.email).first();
      const id = a ? a.id : "adm_" + randomToken("").slice(0, 16);
      if (!a) stmts.push(env.DB.prepare("INSERT INTO admins (id, email, name, created_at) VALUES (?, ?, ?, ?)").bind(id, rq.email, rq.email.split("@")[0], now));
      stmts.push(env.DB.prepare("INSERT OR IGNORE INTO memberships (admin_id, org_id, role) VALUES (?, ?, 'admin')").bind(id, orgId));
    }
    await env.DB.batch(stmts);
    if (approve) await sendMail(env, rq.email, "You're an admin on Cardshare", `Your request was approved. Sign in: ${env.APP_ORIGIN}/admin/`);
    return json(200, { status: approve ? "approved" : "declined" });
  }
  if (m === "POST" && p === "/v1/admin/admins") {
    if (!owner) return json(403, { error: "Only an owner can do that." });
    const email = String(body.email || "").trim().toLowerCase(), role = body.role === "owner" ? "owner" : "admin";
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(email)) return json(400, { error: "Enter their work email." });
    let a = await env.DB.prepare("SELECT id FROM admins WHERE email = ?").bind(email).first();
    const id = a ? a.id : "adm_" + randomToken("").slice(0, 16);
    if (a && await env.DB.prepare("SELECT 1 FROM memberships WHERE admin_id = ? AND org_id = ?").bind(id, orgId).first()) return json(409, { error: `${email} is already an admin here.` });
    await env.DB.batch([
      ...(a ? [] : [env.DB.prepare("INSERT INTO admins (id, email, name, created_at) VALUES (?, ?, ?, ?)").bind(id, email, email.split("@")[0], now)]),
      env.DB.prepare("INSERT INTO memberships (admin_id, org_id, role) VALUES (?, ?, ?)").bind(id, orgId, role),
      logStmt(env, orgId, `Added ${email} as ${role}`)
    ]);
    await sendMail(env, email, "You're an admin on Cardshare", `Sign in: ${env.APP_ORIGIN}/admin/`);
    return json(201, { ok: true });
  }
  if ((x = /^\/v1\/admin\/admins\/([\w-]+)$/.exec(p)) && m === "DELETE") {
    if (!owner) return json(403, { error: "Only an owner can do that." });
    const mem = await env.DB.prepare("SELECT role FROM memberships WHERE admin_id = ? AND org_id = ?").bind(x[1], orgId).first();
    if (!mem) return json(404, { error: "not_found" });
    if (mem.role === "owner" && (await env.DB.prepare("SELECT COUNT(*) AS n FROM memberships WHERE org_id = ? AND role = 'owner'").bind(orgId).first()).n < 2)
      return json(409, { error: "An organisation needs at least one owner." });
    await env.DB.batch([
      env.DB.prepare("DELETE FROM memberships WHERE admin_id = ? AND org_id = ?").bind(x[1], orgId),
      env.DB.prepare("UPDATE admin_sessions SET org_id = NULL WHERE admin_id = ? AND org_id = ?").bind(x[1], orgId),
      logStmt(env, orgId, "Removed an admin")
    ]);
    return new Response(null, { status: 204 });
  }
  return null;
}
