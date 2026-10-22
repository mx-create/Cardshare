// Cardshare v2: the one place the app and the admin console talk to a server.
//
// Everything goes through request(method, path, opts), which speaks plain HTTP shapes (status, headers, JSON body).
// With no server configured it is answered by MockServer below, which keeps its "database" in this browser's
// localStorage and adds a little latency, so the whole Teams flow works with no backend. Point it at the
// Cloudflare Worker in worker/ by setting, before this script loads:
//   <script>window.CARDSHARE_API="https://api.cardshare.io"</script>
// The Worker implements exactly the same routes and responses (see worker/README.md).
//
// Free personal mode never calls this file: Personal, Links and a manual Work card stay on the phone.
(function () {
  var API = window.CARDSHARE_API || "";            // "" = mock backend in this browser
  var LOCAL = "cardshare-work-v2";                 // this phone: device token and the cached, synced work card
  var DAY = 24 * 60 * 60 * 1000;

  // ---------------------------------------------------------------- transport
  function request(method, path, opts) {
    opts = opts || {};
    var headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    if (opts.token) headers.Authorization = "Bearer " + opts.token;
    if (!API) return MockServer.handle({ method: method, path: path, headers: headers, body: opts.body || null });
    return fetch(API + path, { method: method, headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined })
      .then(function (res) {
        var h = { etag: res.headers.get("ETag") || "" };
        if (res.status === 204 || res.status === 304) return { status: res.status, headers: h, body: null };
        return res.json().catch(function () { return null; }).then(function (b) { return { status: res.status, headers: h, body: b }; });
      });
  }

  // ---------------------------------------------------------------- this phone's work-card state
  // {deviceToken, orgName, card:{name,title,org,office,email}, org:{id,name,logos}, etag, syncedAt, checkedAt, own:{tel}}
  // own.* are the employee's own fields: kept here, never sent anywhere.
  function load() { try { return JSON.parse(localStorage.getItem(LOCAL) || "null"); } catch (e) { return null; } }
  function save(s) { try { if (s) localStorage.setItem(LOCAL, JSON.stringify(s)); else localStorage.removeItem(LOCAL); } catch (e) {} }

  // Logos come as URLs (R2 behind the Worker). For offline use they are turned into data: URLs and kept with the card.
  function cacheLogos(org) {
    var logos = (org && org.logos) || {}, keys = Object.keys(logos);
    return Promise.all(keys.map(function (k) {
      var L = logos[k];
      if (!L || !L.url || /^data:/.test(L.url)) return null;
      return fetch(L.url).then(function (r) { return r.blob(); }).then(function (b) {
        return new Promise(function (ok) { var fr = new FileReader(); fr.onload = function () { L.url = fr.result; ok(); }; fr.onerror = function () { ok(); }; fr.readAsDataURL(b); });
      }).catch(function () { delete logos[k]; });
    })).then(function () { return org; });
  }

  function wipe() { var s = load(); save(null); return s; }

  // Download the card (honouring the ETag) and store it. Resolves {status: unchanged|updated|removed|signedout|offline|none}.
  function pull(s) {
    return request("GET", "/v1/card", { token: s.deviceToken, headers: s.etag ? { "If-None-Match": s.etag } : {} }).then(function (r) {
      var t = Date.now();
      if (r.status === 304) { s.syncedAt = s.checkedAt = t; save(s); return { status: "unchanged", state: s }; }
      if (r.status === 410 || r.status === 401) { var old = wipe(); return { status: r.status === 410 ? "removed" : "signedout", state: null, was: old }; }
      if (r.status !== 200 || !r.body) throw new Error("bad status " + r.status);
      return cacheLogos(r.body.org).then(function (org) {
        var first = !s.etag;
        s.card = r.body.card; s.org = org; s.etag = r.headers.etag || r.body.version; s.syncedAt = s.checkedAt = t;
        save(s); return { status: first ? "signedin" : "updated", state: s };
      });
    });
  }

  var Sync = {
    mock: !API,
    DAY: DAY,
    state: load,

    // Does this work email's domain belong to an organisation that lets staff find it? {org:{name}} or {org:null}.
    // Only the part after @ is sent, never the address. Only organisations that opted in to being found are matched.
    discover: function (email) {
      var at = String(email || "").lastIndexOf("@"), domain = at > 0 ? String(email).slice(at + 1).trim().toLowerCase() : "";
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return Promise.resolve(null);
      return request("POST", "/v1/discover", { body: { domain: domain } }).then(function (r) { return (r.body && r.body.org) || null; }).catch(function () { return null; });
    },
    // Always answers the same way, whether or not the address is known, so nobody can probe who works where.
    requestLink: function (email) {
      return request("POST", "/v1/auth/link", { body: { email: email } }).then(function (r) { return r.status === 202; });
    },
    // The token from the emailed link (?signin=...) becomes this phone's device token, then the card is downloaded.
    verify: function (token) {
      return request("POST", "/v1/auth/verify", { body: { token: token, device: { label: navigator.userAgent.slice(0, 80) } } }).then(function (r) {
        if (r.status !== 200 || !r.body || !r.body.deviceToken) return { status: "invalid" };
        var prev = load(), s = { deviceToken: r.body.deviceToken, orgName: r.body.org.name, own: (prev && prev.own) || {} };
        save(s); return pull(s);
      });
    },
    // "Anything changed?" On app open and once a day; force for the "check now" tap. Cheap when nothing has.
    checkIn: function (force) {
      var s = load();
      if (!s || !s.deviceToken) return Promise.resolve({ status: "none", state: null });
      if (!force && s.checkedAt && Date.now() - s.checkedAt < DAY && s.card) return Promise.resolve({ status: "skipped", state: s });
      return request("POST", "/v1/checkin", { token: s.deviceToken, body: { version: s.etag || "" } }).then(function (r) {
        if (r.status === 410 || r.status === 401) { var old = wipe(); return { status: r.status === 410 ? "removed" : "signedout", state: null, was: old }; }
        if (r.status !== 200) throw new Error("bad status " + r.status);
        if (r.body.changed || !s.card) return pull(s);
        s.checkedAt = s.syncedAt = Date.now(); save(s); return { status: "unchanged", state: s };
      }).catch(function () { return { status: "offline", state: load() }; });
    },
    // Microsoft 365 organisations: "Sign in with Microsoft". For real it is a redirect through Microsoft's own sign-in page to the
    // Worker, which comes back to the app as ?signin=<one-time token>, the same as an emailed link. The mock answers directly.
    signInMicrosoft: function (email) {
      if (API) {
        location.assign(API + "/v1/auth/microsoft/start?login_hint=" + encodeURIComponent(email || "") + "&return=" + encodeURIComponent(location.origin + location.pathname));
        return new Promise(function () {});
      }
      return request("POST", "/v1/auth/microsoft/mock", { body: { email: email } }).then(function (r) {
        if (r.status !== 200) return { status: (r.body && r.body.error) || "failed" };
        return Sync.verify(r.body.token);
      });
    },
    // Sign out here: the device token is revoked if there is signal, and the work card is wiped either way.
    signOut: function () {
      var s = wipe();
      if (s && s.deviceToken) request("POST", "/v1/auth/signout", { token: s.deviceToken }).catch(function () {});
      return Promise.resolve(s);
    },
    // The employee's own fields (mobile): stored on this phone only.
    setOwn: function (k, v) { var s = load(); if (!s) return; s.own = s.own || {}; s.own[k] = v; save(s); },

    // The admin console. In the mock a fixed admin session token stands in for the admin's magic-link sign-in.
    admin: function (token) {
      token = token || "mock-admin";
      function call(m, p, b) {
        return request(m, p, { token: token, body: b }).then(function (r) {
          if (r.status >= 400) { var e = new Error((r.body && r.body.error) || ("HTTP " + r.status)); e.status = r.status; throw e; }
          return r.body;
        });
      }
      return {
        org: function () { return call("GET", "/v1/admin/org"); },
        updateOrg: function (patch) { return call("PATCH", "/v1/admin/org", patch); },
        putLogo: function (variant, logo) { return call("PUT", "/v1/admin/logos/" + variant, logo); },
        deleteLogo: function (variant) { return call("DELETE", "/v1/admin/logos/" + variant); },
        employees: function () { return call("GET", "/v1/admin/employees"); },
        addEmployee: function (e) { return call("POST", "/v1/admin/employees", e); },
        updateEmployee: function (id, patch) { return call("PATCH", "/v1/admin/employees/" + id, patch); },
        removeEmployee: function (id) { return call("DELETE", "/v1/admin/employees/" + id); },
        invite: function (ids) { return call("POST", "/v1/admin/invite", { ids: ids }); },
        // Microsoft 365. connectMicrosoft: for real, a redirect to Microsoft's admin-consent page and back; the mock takes the
        // result of the simulated consent screen directly.
        connectMicrosoft: function (mock) {
          if (API) { location.assign(API + "/v1/admin/microsoft/connect?session=" + encodeURIComponent(token)); return new Promise(function () {}); }
          return call("POST", "/v1/admin/microsoft/connect", mock || {});
        },
        disconnectMicrosoft: function () { return call("POST", "/v1/admin/microsoft/disconnect"); },
        syncMicrosoft: function () { return call("POST", "/v1/admin/microsoft/sync"); },
        microsoftBranding: function () { return call("GET", "/v1/admin/microsoft/branding"); },
        activity: function () { return call("GET", "/v1/admin/activity"); }
      };
    }
  };

  // ================================================================ mock backend
  // Two stores, both in this browser's localStorage so the admin console (/admin/) and the app in its phone frame share them:
  //  - "cardshare-mock-server-v2" is Cardshare's own database, mirroring worker/schema.sql.
  //  - "cardshare-mock-entra-v1" stands in for Microsoft 365 (Entra ID + Graph): the organisation's own directory.
  //    Cardshare never copies staff details out of it; a phone's check-in reads the one user it needs, maps it, returns it.
  var MockGraph = (function () {
    var KEY = "cardshare-mock-entra-v1";
    var BANNER = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 560 110"><path d="M24 70c16-13 32-13 48 0s32 13 48 0" fill="none" stroke="#c4542f" stroke-width="9" stroke-linecap="round"/><text x="140" y="74" font-family="Georgia,serif" font-size="52" font-weight="700" fill="#1f2433">Harbour Studio</text></svg>';
    var SQUARE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect x="14" y="14" width="92" height="92" rx="20" fill="#c4542f"/><path d="M30 70c10-9 20-9 30 0s20 9 30 0" fill="none" stroke="#fff" stroke-width="8" stroke-linecap="round"/></svg>';
    var SQUARE_DARK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect x="14" y="14" width="92" height="92" rx="20" fill="none" stroke="#f3ece8" stroke-width="6"/><path d="M30 70c10-9 20-9 30 0s20 9 30 0" fill="none" stroke="#f3ece8" stroke-width="8" stroke-linecap="round"/></svg>';
    function svgURL(s) { return "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(s))); }
    function seed() {
      var u = function (id, n, t, c, ph, m, d, o, mob, on) {
        return { id: id, displayName: n, jobTitle: t, companyName: c, businessPhones: ph, mail: m, userPrincipalName: m, department: d, officeLocation: o, mobilePhone: mob, accountEnabled: on };
      };
      return { v: 1, tenants: { harbour: {
        id: "7f3c2a1e-58d4-4b6a-9e0f-2c81d4a6b913", displayName: "Harbour Studio Ltd", verifiedDomains: ["harbour.example"],
        branding: { bannerLogo: svgURL(BANNER), squareLogo: svgURL(SQUARE), squareLogoDark: svgURL(SQUARE_DARK) },
        users: [
          u("3b1d9a70-1c2e-4f61-a0d7-5e8c0b2f4a11", "Maya Patel", "Head of Design", "Harbour Studio Ltd", ["+44 161 496 0100"], "maya.patel@harbour.example", "Design", "Manchester", "+44 7700 900101", true),
          u("8e4f2c19-7a3b-4d50-9c61-0f2e7b8d5c22", "Tom Okafor", "Account Director", null, ["+44 161 496 0101"], "tom.okafor@harbour.example", "Accounts", "Manchester", "+44 7700 900102", true),
          u("c27a6e83-0d4f-4b19-8e2a-6a9d1f3c7e33", "Priya Shah", null, "Harbour Studio Ltd", [], "priya.shah@harbour.example", "Engineering", "London", "+44 7700 900103", true),
          u("51f0b3d4-9e6a-4c27-b8f3-2d7c4e1a9b44", "Liam Byrne", "Studio Manager", "Harbour Studio Ltd", ["+44 161 496 0103"], "liam.byrne@harbour.example", null, "Manchester", null, true),
          u("a9d2e5f6-3b7c-4e81-9a04-8c1f6d2b0e55", "Sofia Rossi", "Office Manager", "Harbour Studio Ltd", ["+44 161 496 0104"], "sofia.rossi@harbour.example", "Operations", "London", "+44 7700 900105", true),
          u("e6c8b1a2-4f9d-4a37-8b52-1e0d3c7f6a66", "James Wright", "Finance Lead", "Harbour Studio Ltd", ["+44 161 496 0105"], "james.wright@harbour.example", "Finance", "Leeds", "+44 7700 900106", false)
        ] } } };
    }
    function read() { try { var d = JSON.parse(localStorage.getItem(KEY) || "null"); if (d && d.v === 1) return d; } catch (e) {} var s = seed(); write(s); return s; }
    function write(d) { try { localStorage.setItem(KEY, JSON.stringify(d)); } catch (e) {} }
    function tenant(tid) { var d = read(); return Object.keys(d.tenants).map(function (k) { return d.tenants[k]; }).filter(function (t) { return t.id === tid; })[0] || null; }
    // What Cardshare is allowed to read: GET /users/{id}?$select=<these>. mobilePhone is deliberately not in the list.
    var SELECT = ["id", "displayName", "jobTitle", "companyName", "businessPhones", "mail", "userPrincipalName", "department", "officeLocation", "accountEnabled"];
    function pick(u) { var o = {}; SELECT.forEach(function (k) { o[k] = u[k] === undefined ? null : u[k]; }); return o; }
    return {
      SELECT: SELECT,
      // Graph, as the Worker would call it with an app-only token for this tenant
      user: function (tid, id) { var t = tenant(tid); var u = t && t.users.filter(function (x) { return x.id === id; })[0]; return u ? pick(u) : null; },
      userByMail: function (tid, mail) { var t = tenant(tid); mail = String(mail || "").toLowerCase(); var u = t && t.users.filter(function (x) { return String(x.mail || x.userPrincipalName).toLowerCase() === mail; })[0]; return u ? pick(u) : null; },
      users: function (tid) { var t = tenant(tid); return t ? t.users.map(pick) : []; },
      organization: function (tid) { var t = tenant(tid); return t ? { id: t.id, displayName: t.displayName, verifiedDomains: t.verifiedDomains.map(function (n) { return { name: n }; }) } : null; },
      branding: function (tid) { var t = tenant(tid); return t ? JSON.parse(JSON.stringify(t.branding)) : null; },
      tenantByKey: function (k) { return read().tenants[k] || null; },
      // Prototype only: what an IT admin would do in the Microsoft 365 admin centre
      sim: {
        users: function () { return read().tenants.harbour.users.slice(); },
        update: function (id, patch) { var d = read(); d.tenants.harbour.users.forEach(function (u) { if (u.id === id) Object.assign(u, patch); }); write(d); },
        reset: function () { localStorage.removeItem(KEY); }
      }
    };
  })();

  var MockServer = (function () {
    var KEY = "cardshare-mock-server-v2";
    var MAPPED = ["name", "title", "company", "office", "email", "department", "officeLocation"];
    function seed() {
      var t = Date.now(), org = "org_harbour";
      var db = { v: 2, seq: 100, orgs: {}, domains: {}, employees: {}, links: {}, devices: {}, outbox: [], activity: [], admins: { "mock-admin": org } };
      db.orgs[org] = { id: org, name: "Harbour Studio", company: "Harbour Studio Ltd", discoverable: true, brandVersion: 1, logos: {}, createdAt: t,
        source: "manual", ms: null, map: { department: false, officeLocation: false }, overrides: {}, invited: {} };
      db.domains["harbour.example"] = org;
      [["Maya Patel", "Head of Design", "+44 161 496 0100", "maya.patel@harbour.example"],
       ["Tom Okafor", "Account Director", "+44 161 496 0101", "tom.okafor@harbour.example"],
       ["Priya Shah", "Senior Engineer", "+44 161 496 0102", "priya.shah@harbour.example"],
       ["Liam Byrne", "Studio Manager", "+44 161 496 0103", "liam.byrne@harbour.example"]].forEach(function (p, i) {
        var id = "emp_" + (i + 1);
        db.employees[id] = { id: id, orgId: org, name: p[0], title: p[1], office: p[2], email: p[3], company: "", version: 1, invitedAt: null, removedAt: null, createdAt: t };
      });
      db.activity.push({ at: t, orgId: org, t: "Harbour Studio set up with 4 people typed in by hand (sample data)" });
      return db;
    }
    function read() { try { var d = JSON.parse(localStorage.getItem(KEY) || "null"); if (d && d.v === 2) return d; } catch (e) {} var s = seed(); write(s); return s; }
    function write(db) { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) {} }
    function rid(p) { var a = new Uint8Array(16); (crypto.getRandomValues ? crypto.getRandomValues(a) : a.forEach(function (_, i) { a[i] = Math.random() * 256; })); return p + Array.prototype.map.call(a, function (b) { return ("0" + b.toString(16)).slice(-2); }).join(""); }
    function res(status, body, headers) { return { status: status, headers: headers || {}, body: body === undefined ? null : body }; }
    function domainOf(email) { email = String(email || "").trim().toLowerCase(); var i = email.lastIndexOf("@"); return i > 0 ? email.slice(i + 1) : ""; }
    function bearer(h) { var a = h.Authorization || ""; return a.indexOf("Bearer ") === 0 ? a.slice(7) : ""; }
    function hash(s) { var h = 5381; for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
    function log(db, orgId, t) { db.activity.unshift({ at: Date.now(), orgId: orgId, t: t }); db.activity = db.activity.slice(0, 60); }
    function isMs(o) { return o && o.source === "microsoft" && o.ms; }

    // The directory user → the card, with the admin's overrides on top. Nothing here is written to Cardshare's database.
    function msMapped(o, u) {
      var ov = (o.overrides && o.overrides[u.id]) || {};
      var dir = { name: u.displayName || "", title: u.jobTitle || "", company: u.companyName || "", office: (u.businessPhones || [])[0] || "",
        email: u.mail || u.userPrincipalName || "", department: u.department || "", officeLocation: u.officeLocation || "" };
      var eff = {}; MAPPED.forEach(function (k) { eff[k] = ov[k] || dir[k]; });
      if (!eff.company) eff.company = o.company || o.name;
      return { dir: dir, ov: ov, eff: eff };
    }
    function msCard(o, u) {
      var e = msMapped(o, u).eff;
      return { name: e.name, title: e.title, org: e.company, office: e.office, email: e.email,
        department: o.map.department ? e.department : "", location: o.map.officeLocation ? e.officeLocation : "" };
    }
    function manualCard(o, e) { return { name: e.name, title: e.title, org: e.company || o.company || o.name, office: e.office, email: e.email }; }
    // Who a device or a link belongs to, checked live. null = removed: deleted or disabled in Microsoft 365, removed by the admin,
    // or the organisation changed how it manages cards.
    function holder(db, h) {
      if (!h) return null;
      if (h.empId) { var e = db.employees[h.empId], o1 = e && db.orgs[e.orgId]; return e && !e.removedAt && o1 && !isMs(o1) ? { org: o1, card: manualCard(o1, e), name: e.name } : null; }
      var o = db.orgs[h.orgId]; if (!isMs(o)) return null;
      var u = MockGraph.user(o.ms.tenantId, h.msUid);
      return u && u.accountEnabled ? { org: o, card: msCard(o, u), u: u } : null;
    }
    function etagOf(hd) { return '"c' + hash(JSON.stringify(hd.card)) + "-o" + hd.org.brandVersion + '"'; }
    function cardBody(hd) { var o = hd.org; return { card: hd.card, org: { id: o.id, name: o.name, logos: JSON.parse(JSON.stringify(o.logos || {})) }, version: etagOf(hd) }; }
    function devicesFor(db, match) {
      var devs = Object.keys(db.devices).map(function (k) { return db.devices[k]; }).filter(match);
      return { n: devs.length, last: devs.reduce(function (m, d) { return Math.max(m, d.lastSeen || 0); }, 0) || null };
    }
    function empView(db, e) { var d = devicesFor(db, function (x) { return x.empId === e.id; }); return Object.assign({ source: "manual" }, e, { devices: d.n, lastSeen: d.last }); }
    function msView(db, o, u) {
      var m = msMapped(o, u), d = devicesFor(db, function (x) { return x.orgId === o.id && x.msUid === u.id; });
      return Object.assign({ id: u.id, source: "microsoft", accountEnabled: u.accountEnabled, dir: m.dir, overrides: m.ov,
        blanks: ["title", "office"].filter(function (k) { return !m.dir[k]; }).concat(m.dir.company ? [] : ["company"]),
        invitedAt: (o.invited || {})[u.id] || null, devices: d.n, lastSeen: d.last }, m.eff);
    }
    function orgView(db, id) {
      var o = db.orgs[id];
      return Object.assign({}, o, { domains: Object.keys(db.domains).filter(function (d) { return db.domains[d] === id; }), overrides: undefined, invited: undefined });
    }
    function cleanEmp(b, keys) {
      var out = {};
      (keys || ["name", "title", "office", "email", "company"]).forEach(function (k) { if (typeof b[k] === "string") out[k] = b[k].trim(); });
      if (out.email) out.email = out.email.toLowerCase();
      return out;
    }
    function issueLink(db, h, to, ttl) {
      var tok = rid("lnk_"), t = Date.now();
      db.links[tok] = Object.assign({ exp: t + ttl, used: false }, h);
      db.outbox.unshift({ to: to, token: tok, at: t }); db.outbox = db.outbox.slice(0, 40);
      return tok;
    }
    function orgForEmail(db, email) { var oid = db.domains[domainOf(email)]; return oid ? db.orgs[oid] : null; }

    function route(req) {
      var db = read(), m = req.method, p = req.path.split("?")[0], b = req.body || {}, t = Date.now(), x, o, u, hd, tok;
      // ---- phone
      if (m === "POST" && p === "/v1/discover") {
        o = db.orgs[db.domains[String(b.domain || "").toLowerCase()]];
        return res(200, { org: o && o.discoverable ? { name: o.name, microsoft: !!isMs(o) } : null });
      }
      if (m === "POST" && p === "/v1/auth/link") {
        var em = String(b.email || "").trim().toLowerCase();
        o = orgForEmail(db, em);
        if (isMs(o)) { u = MockGraph.userByMail(o.ms.tenantId, em); if (u && u.accountEnabled) issueLink(db, { orgId: o.id, msUid: u.id }, em, 15 * 60 * 1000); }
        else {
          var emp = Object.keys(db.employees).map(function (k) { return db.employees[k]; }).filter(function (e) { return e.email === em && !e.removedAt; })[0];
          if (emp) issueLink(db, { empId: emp.id }, em, 15 * 60 * 1000);
        }
        write(db);
        return res(202, { ok: true }); // the same answer for every address
      }
      // Stands in for Microsoft's sign-in page + the Worker's OIDC callback (worker/src/microsoft.js). For real, the person
      // proves who they are to Microsoft; the Worker only learns the tenant ID and user object ID from the ID token.
      if (m === "POST" && p === "/v1/auth/microsoft/mock") {
        o = orgForEmail(db, b.email);
        if (!isMs(o)) return res(403, { error: "not_connected" });
        u = MockGraph.userByMail(o.ms.tenantId, b.email);
        if (!u) return res(404, { error: "not_in_directory" });
        if (!u.accountEnabled) return res(403, { error: "disabled" });
        tok = rid("lnk_"); db.links[tok] = { orgId: o.id, msUid: u.id, exp: t + 5 * 60 * 1000, used: false, via: "microsoft" };
        write(db); return res(200, { token: tok });
      }
      if (m === "POST" && p === "/v1/auth/verify") {
        var L = db.links[b.token];
        if (!L || L.used || L.exp < t) return res(400, { error: "invalid_or_expired" });
        hd = holder(db, L);
        if (!hd) return res(400, { error: "invalid_or_expired" });
        L.used = true;
        var dt = rid("dev_");
        db.devices[dt] = { empId: L.empId || null, orgId: hd.org.id, msUid: L.msUid || null, createdAt: t, lastSeen: t, label: (b.device && b.device.label) || "" };
        // Microsoft-connected: the log names no one, so no staff details are kept.
        log(db, hd.org.id, L.msUid ? "A phone signed in (Microsoft 365 user" + (L.via === "microsoft" ? ", Sign in with Microsoft)" : ", email link)") : hd.name + " signed in on a phone");
        write(db);
        return res(200, { deviceToken: dt, org: { name: hd.org.name } });
      }
      if ((m === "GET" && p === "/v1/card") || (m === "POST" && p === "/v1/checkin")) {
        var bt = bearer(req.headers), d = db.devices[bt];
        if (!d) return res(401, { error: "signed_out" });
        hd = holder(db, d);
        if (!hd) { delete db.devices[bt]; write(db); return res(410, { error: "removed" }); }
        d.lastSeen = t; if (isMs(hd.org)) hd.org.ms.lastSync = t; write(db);
        var tag = etagOf(hd);
        if (p === "/v1/checkin") return res(200, { changed: b.version !== tag, version: tag });
        if (req.headers["If-None-Match"] === tag) return res(304, null, { etag: tag });
        return res(200, cardBody(hd), { etag: tag });
      }
      if (m === "POST" && p === "/v1/auth/signout") { delete db.devices[bearer(req.headers)]; write(db); return res(204); }

      // ---- admin
      if (p.indexOf("/v1/admin/") === 0) {
        var orgId = db.admins[bearer(req.headers)];
        if (!orgId) return res(401, { error: "admin_signed_out" });
        var org = db.orgs[orgId], ms = isMs(org), mine = function (id) { var e2 = db.employees[id]; return e2 && e2.orgId === orgId && !e2.removedAt ? e2 : null; };
        var NO_MS = res(409, { error: "People come from Microsoft 365. Add or remove them there." });
        if (m === "GET" && p === "/v1/admin/org") return res(200, orgView(db, orgId));
        if (m === "PATCH" && p === "/v1/admin/org") {
          var brand = false;
          if (typeof b.name === "string" && b.name.trim() && b.name.trim() !== org.name) { org.name = b.name.trim(); brand = true; }
          if (typeof b.company === "string" && b.company.trim() !== org.company) { org.company = b.company.trim(); brand = true; }
          if (typeof b.discoverable === "boolean") org.discoverable = b.discoverable;
          if (b.map && typeof b.map === "object") ["department", "officeLocation"].forEach(function (k) { if (typeof b.map[k] === "boolean") org.map[k] = b.map[k]; });
          if (Array.isArray(b.domains) && !ms) { // Microsoft-connected: the tenant's verified domains are used instead
            var want = b.domains.map(function (s) { return String(s).trim().toLowerCase().replace(/^@/, ""); }).filter(function (s) { return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s); });
            for (var i = 0; i < want.length; i++) if (db.domains[want[i]] && db.domains[want[i]] !== orgId) return res(409, { error: want[i] + " belongs to another organisation" });
            Object.keys(db.domains).forEach(function (k) { if (db.domains[k] === orgId && want.indexOf(k) < 0) delete db.domains[k]; });
            want.forEach(function (k) { db.domains[k] = orgId; });
          }
          if (brand) { org.brandVersion++; log(db, orgId, "Organisation details changed"); }
          write(db); return res(200, orgView(db, orgId));
        }
        // -- Microsoft 365
        if (m === "POST" && p === "/v1/admin/microsoft/connect") {
          var ten = MockGraph.tenantByKey(b.tenant || "harbour");
          if (!ten || !b.consent) return res(400, { error: "Admin consent was not granted" });
          var orgInfo = MockGraph.organization(ten.id), doms = orgInfo.verifiedDomains.map(function (v) { return v.name; });
          for (var j = 0; j < doms.length; j++) if (db.domains[doms[j]] && db.domains[doms[j]] !== orgId) return res(409, { error: doms[j] + " belongs to another organisation" });
          // Phones already signed in keep working if their person is in the directory; everything typed by hand is deleted.
          var moved = 0;
          Object.keys(db.devices).forEach(function (k) {
            var dv = db.devices[k], e = dv.empId && db.employees[dv.empId]; if (!e || e.orgId !== orgId) return;
            var du = MockGraph.userByMail(ten.id, e.email);
            if (du) { db.devices[k] = { empId: null, orgId: orgId, msUid: du.id, createdAt: dv.createdAt, lastSeen: dv.lastSeen, label: dv.label }; moved++; }
          });
          var gone = 0;
          Object.keys(db.employees).forEach(function (k) { if (db.employees[k].orgId === orgId) { delete db.employees[k]; gone++; } });
          Object.keys(db.links).forEach(function (k) { if (db.links[k].empId) delete db.links[k]; });
          Object.keys(db.domains).forEach(function (k) { if (db.domains[k] === orgId) delete db.domains[k]; });
          doms.forEach(function (dn) { db.domains[dn] = orgId; });
          var people = MockGraph.users(ten.id).filter(function (x) { return x.accountEnabled; }).length;
          org.source = "microsoft"; org.overrides = {}; org.invited = {};
          org.ms = { tenantId: ten.id, tenantName: orgInfo.displayName, consentedBy: b.consentedBy || "", connectedAt: t, lastSync: t, peopleFound: people,
            permissions: ["User.Read.All (application)", "OrganizationalBranding.Read.All (application, for the logo)"] };
          org.brandVersion++;
          log(db, orgId, "Connected Microsoft 365 (" + orgInfo.displayName + "): " + people + " people found. " + gone + " hand-typed records deleted" + (moved ? ", " + moved + " signed-in phone" + (moved === 1 ? "" : "s") + " kept" : ""));
          write(db); return res(200, orgView(db, orgId));
        }
        if (m === "POST" && p === "/v1/admin/microsoft/disconnect") {
          if (!ms) return res(409, { error: "Not connected" });
          var tn = org.ms.tenantName;
          org.source = "manual"; org.ms = null; org.overrides = {}; org.invited = {}; org.brandVersion++;
          Object.keys(db.links).forEach(function (k) { if (db.links[k].orgId === orgId && db.links[k].msUid) delete db.links[k]; });
          log(db, orgId, "Disconnected Microsoft 365 (" + tn + "). Signed-in phones drop their work cards at their next check-in");
          write(db); return res(200, orgView(db, orgId));
        }
        if (m === "POST" && p === "/v1/admin/microsoft/sync") {
          if (!ms) return res(409, { error: "Not connected" });
          org.ms.peopleFound = MockGraph.users(org.ms.tenantId).filter(function (x) { return x.accountEnabled; }).length; org.ms.lastSync = t;
          write(db); return res(200, orgView(db, orgId));
        }
        if (m === "GET" && p === "/v1/admin/microsoft/branding") {
          if (!ms) return res(409, { error: "Not connected" });
          return res(200, MockGraph.branding(org.ms.tenantId) || {});
        }
        if ((x = /^\/v1\/admin\/logos\/(horizontal|mark|light|dark|markLight)$/.exec(p))) {
          if (m === "PUT") {
            if (!/^data:image\/(svg\+xml|png|webp|jpeg);/.test(b.url || "")) return res(415, { error: "SVG or PNG please" });
            org.logos[x[1]] = { url: b.url, type: b.type, w: +b.w || 0, h: +b.h || 0, ratio: +b.ratio || 0, lum: +b.lum, trimmed: !!b.trimmed, vector: !!b.vector,
              source: b.source === "microsoft" ? "microsoft" : "upload", at: t };
          } else if (m === "DELETE") delete org.logos[x[1]];
          else return res(405, { error: "method" });
          org.brandVersion++; log(db, orgId, m === "PUT" ? "Logo " + (b.source === "microsoft" ? "taken from Microsoft 365" : "uploaded") + " (" + x[1] + ")" : "Logo removed (" + x[1] + ")");
          write(db); return res(200, orgView(db, orgId));
        }
        if (m === "GET" && p === "/v1/admin/employees") {
          if (ms) { org.ms.lastSync = t; write(db); return res(200, { source: "microsoft", employees: MockGraph.users(org.ms.tenantId).map(function (gu) { return msView(db, org, gu); }) }); }
          return res(200, { source: "manual", employees: Object.keys(db.employees).map(function (k) { return db.employees[k]; }).filter(function (e) { return e.orgId === orgId && !e.removedAt; }).map(function (e) { return empView(db, e); }) });
        }
        if (m === "POST" && p === "/v1/admin/employees") {
          if (ms) return NO_MS;
          var ne = cleanEmp(b);
          if (!ne.name || !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(ne.email || "")) return res(400, { error: "A name and a work email are needed" });
          if (Object.keys(db.employees).some(function (k) { var e3 = db.employees[k]; return e3.email === ne.email && !e3.removedAt; })) return res(409, { error: ne.email + " is already added" });
          var id = "emp_" + (++db.seq);
          db.employees[id] = Object.assign({ id: id, orgId: orgId, title: "", office: "", company: "", version: 1, invitedAt: null, removedAt: null, createdAt: t }, ne);
          log(db, orgId, "Added " + ne.name); write(db); return res(201, empView(db, db.employees[id]));
        }
        if ((x = /^\/v1\/admin\/employees\/([\w-]+)$/.exec(p))) {
          if (ms) {
            u = MockGraph.user(org.ms.tenantId, x[1]); if (!u) return res(404, { error: "not_found" });
            if (m === "DELETE") return NO_MS;
            if (m === "PATCH") { // overrides: only the values the admin types are stored; empty = use the directory again
              var ov = Object.assign({}, org.overrides[u.id] || {}), chg = cleanEmp(b, MAPPED), what = [];
              Object.keys(chg).forEach(function (k) { var v = chg[k]; if ((ov[k] || "") === v) return; what.push(k); if (v) ov[k] = v; else delete ov[k]; });
              if (Object.keys(ov).length) org.overrides[u.id] = ov; else delete org.overrides[u.id];
              if (what.length) log(db, orgId, "Overrides changed for 1 person: " + what.join(", "));
              write(db); return res(200, msView(db, org, u));
            }
          }
          var ee = mine(x[1]); if (!ee) return res(404, { error: "not_found" });
          if (m === "PATCH") {
            var ch = cleanEmp(b), wh = Object.keys(ch).filter(function (k) { return ch[k] !== ee[k]; });
            if (!wh.length) return res(200, empView(db, ee));
            wh.forEach(function (k) { ee[k] = ch[k]; }); ee.version++;
            log(db, orgId, "Changed " + ee.name + "'s " + wh.join(", ")); write(db); return res(200, empView(db, ee));
          }
          if (m === "DELETE") {
            // The record is deleted outright; the phone finds out at its next check-in (no device or record → 410).
            delete db.employees[ee.id];
            log(db, orgId, "Removed " + ee.name + ". Their details are deleted; their phone drops the work card at its next check-in"); write(db); return res(204);
          }
        }
        if (m === "POST" && p === "/v1/admin/invite") {
          var n = 0;
          (b.ids || []).forEach(function (id) {
            if (ms) { var gu = MockGraph.user(org.ms.tenantId, id); if (!gu || !gu.accountEnabled) return; issueLink(db, { orgId: orgId, msUid: gu.id }, gu.mail, 7 * DAY); org.invited[gu.id] = t; n++; return; }
            var e4 = mine(id); if (!e4) return;
            issueLink(db, { empId: e4.id }, e4.email, 7 * DAY); e4.invitedAt = t; n++;
          });
          if (n) log(db, orgId, "Sent sign-in links to " + n + (n === 1 ? " person" : " people"));
          write(db); return res(200, { sent: n });
        }
        if (m === "GET" && p === "/v1/admin/activity") return res(200, { activity: db.activity.filter(function (a) { return a.orgId === orgId; }).slice(0, 30) });
      }
      return res(404, { error: "no_route" });
    }

    return {
      handle: function (req) {
        return new Promise(function (ok, fail) {
          setTimeout(function () {
            if (navigator.onLine === false || localStorage.getItem("cardshare-mock-offline") === "1") { fail(new TypeError("Failed to fetch")); return; }
            try { ok(route(req)); } catch (e) { fail(e); }
          }, 220 + Math.random() * 380);
        });
      },
      // Prototype only, not API routes.
      peekOutbox: function (email) {
        var db = read(), em = String(email || "").trim().toLowerCase();
        var hit = db.outbox.filter(function (o) { return o.to === em && db.links[o.token] && !db.links[o.token].used; })[0];
        return hit ? hit.token : null;
      },
      outbox: function () { var db = read(); return db.outbox.filter(function (o) { var L = db.links[o.token]; return L && !L.used && L.exp > Date.now(); }); },
      KEY: KEY,
      graph: MockGraph,
      reset: function () { localStorage.removeItem(KEY); MockGraph.sim.reset(); }
    };
  })();

  Sync.request = request;
  if (!API) Sync.mockServer = MockServer;
  window.CardshareSync = Sync;
})();
