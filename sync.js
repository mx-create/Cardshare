// Cardshare v2: the one place the app and the admin consoles talk to a server.
//
// Everything goes through request(method, path, opts), which speaks plain HTTP shapes (status, headers, JSON body).
// With no server configured it is answered by MockServer below, which keeps its "database" in this browser's
// localStorage and adds a little latency, so the whole Teams flow works with no backend. Point it at the
// Cloudflare Worker in worker/ by setting, before this script loads:
//   <script>window.CARDSHARE_API="https://api.cardshare.io"</script>
// The Worker implements the same routes and responses (see worker/README.md).
//
// Free personal mode never calls this file: Personal, Links and a manual Work card stay on the phone.
(function () {
  var API = window.CARDSHARE_API || "";            // "" = mock backend in this browser
  var LOCAL = "cardshare-work-v2";                 // this phone: device token and the cached, synced work card
  var DAY = 24 * 60 * 60 * 1000;
  // A managed work card is hidden on the phone after this many days without a successful check-in, so a leaver can't keep
  // using one offline indefinitely. One constant for now; it could become a per-organisation setting later.
  var OFFLINE_LIMIT_DAYS = 14;

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
  // {deviceToken, orgName, card:{…}, org:{id,name,logos,branding}, etag, syncedAt, checkedAt, suspended, own:{tel}}
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
  function gone(r) { var old = wipe(); return { status: r.status === 410 ? "removed" : "signedout", state: null, was: old }; }
  // The organisation's Cardshare account is suspended: the card stays on the phone but is not shown until it is restored.
  function paused(s) { s.suspended = true; s.checkedAt = Date.now(); save(s); return { status: "suspended", state: s }; }

  // Download the card (honouring the ETag) and store it, branding included.
  function pull(s) {
    return request("GET", "/v1/card", { token: s.deviceToken, headers: s.etag ? { "If-None-Match": s.etag } : {} }).then(function (r) {
      var t = Date.now();
      if (r.status === 304) { s.syncedAt = s.checkedAt = t; s.suspended = false; save(s); return { status: "unchanged", state: s }; }
      if (r.status === 410 || r.status === 401) return gone(r);
      if (r.status === 423) return paused(s);
      if (r.status !== 200 || !r.body) throw new Error("bad status " + r.status);
      return cacheLogos(r.body.org).then(function (org) {
        var first = !s.etag;
        s.card = r.body.card; s.org = org; s.etag = r.headers.etag || r.body.version; s.syncedAt = s.checkedAt = t; s.suspended = false;
        save(s); return { status: first ? "signedin" : "updated", state: s };
      });
    });
  }

  function caller(token) {
    return function (m, p, b) {
      return request(m, p, { token: token, body: b }).then(function (r) {
        if (r.status >= 400) { var e = new Error((r.body && r.body.error) || ("HTTP " + r.status)); e.status = r.status; e.body = r.body; throw e; }
        return r.body;
      });
    };
  }
  function post(p, b) { return caller(null)("POST", p, b); }

  var Sync = {
    mock: !API,
    DAY: DAY,
    OFFLINE_LIMIT_DAYS: OFFLINE_LIMIT_DAYS,
    // syncedAt is set only by a successful check-in or download, never by a failed one.
    expired: function (s) { s = s || load(); return !!(s && s.card) && (!s.syncedAt || Date.now() - s.syncedAt > OFFLINE_LIMIT_DAYS * DAY); },
    state: load,

    // Does this work email's domain belong to an organisation that lets staff find it? {org:{name, microsoft}} or null.
    // Only the part after @ is sent, never the address. Only verified domains of active organisations are matched.
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
      if (!force && s.checkedAt && Date.now() - s.checkedAt < DAY && s.card && !s.suspended) return Promise.resolve({ status: "skipped", state: s });
      return request("POST", "/v1/checkin", { token: s.deviceToken, body: { version: s.etag || "" } }).then(function (r) {
        if (r.status === 410 || r.status === 401) return gone(r);
        if (r.status === 423) return paused(s);
        if (r.status !== 200) throw new Error("bad status " + r.status);
        if (r.body.changed || !s.card) return pull(s);
        s.checkedAt = s.syncedAt = Date.now(); s.suspended = false; save(s); return { status: "unchanged", state: s };
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

    // ---------------------------------------------------------------- admins: sign-in, sign-up
    // Admins sign in by emailed link or with Microsoft (Microsoft-connected organisations). A session is for one admin and
    // one current organisation; an admin who belongs to several switches between them.
    adminAuth: {
      requestLink: function (email) { return post("/v1/admin/auth/link", { email: email }); },
      microsoft: function (email) {
        if (API) { location.assign(API + "/v1/admin/auth/microsoft/start?login_hint=" + encodeURIComponent(email || "")); return new Promise(function () {}); }
        return post("/v1/admin/auth/microsoft/mock", { email: email }).then(function (r) { return Sync.adminAuth.verify(r.token); });
      },
      verify: function (token) { return post("/v1/admin/auth/verify", { token: token }); }
    },
    signup: {
      start: function (email) { return post("/v1/signup/start", { email: email }); },
      verify: function (token) { return post("/v1/signup/verify", { token: token }); },
      createOrg: function (signupToken, name) { return post("/v1/signup/org", { signupToken: signupToken, name: name }); },
      // The domain already belongs to an organisation: ask its owners to add this person as an admin.
      requestAccess: function (signupToken) { return post("/v1/signup/request", { signupToken: signupToken }); }
    },
    confirmDomain: function (token) { return post("/v1/domains/confirm", { token: token }); },

    // The admin console, for one admin session.
    admin: function (token) {
      var call = caller(token);
      return {
        me: function () { return call("GET", "/v1/admin/me"); },
        switchOrg: function (orgId) { return call("POST", "/v1/admin/session/org", { orgId: orgId }); },
        signOut: function () { return call("POST", "/v1/admin/auth/signout"); },
        org: function () { return call("GET", "/v1/admin/org"); },
        updateOrg: function (patch) { return call("PATCH", "/v1/admin/org", patch); },
        putBranding: function (b) { return call("PUT", "/v1/admin/branding", b); },
        // method "dns", or "email" with to: "admin" | "postmaster" | "webmaster" (the address at the domain to send the link to)
        verifyDomain: function (domain, method, to) { return call("POST", "/v1/admin/domains/verify", { domain: domain, method: method, to: to }); },
        decideRequest: function (id, approve) { return call("POST", "/v1/admin/requests/" + id + "/" + (approve ? "approve" : "decline")); },
        admins: function () { return call("GET", "/v1/admin/admins"); },
        addAdmin: function (email, role) { return call("POST", "/v1/admin/admins", { email: email, role: role }); },
        removeAdmin: function (id) { return call("DELETE", "/v1/admin/admins/" + id); },
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
    },

    // The platform console (Cardshare's own staff). The mock signs in with a stand-in button.
    platform: function (token) {
      var call = caller(token);
      return {
        orgs: function () { return call("GET", "/v1/platform/orgs"); },
        suspend: function (id) { return call("POST", "/v1/platform/orgs/" + id + "/suspend"); },
        restore: function (id) { return call("POST", "/v1/platform/orgs/" + id + "/restore"); },
        remove: function (id) { return call("DELETE", "/v1/platform/orgs/" + id); }
      };
    },
    platformSignIn: function () { return post("/v1/platform/auth/mock", {}); }
  };

  // ================================================================ mock backend
  // Two stores, both in this browser's localStorage so the admin console (/admin/) and the app in its phone frame share them:
  //  - "cardshare-mock-server-v3" is Cardshare's own database, mirroring worker/schema.sql.
  //  - "cardshare-mock-entra-v2" stands in for Microsoft 365 (Entra ID + Graph): organisations' own directories.
  //    Cardshare never copies staff details out of it; a phone's check-in reads the one user it needs, maps it, returns it.
  function svgURL(s) { return "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(s))); }
  var SVG = {
    harbourBanner: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="20 30 500 56" width="400" height="45"><path d="M24 70c16-13 32-13 48 0s32 13 48 0" fill="none" stroke="#c4542f" stroke-width="9" stroke-linecap="round"/><text x="140" y="74" font-family="Georgia,serif" font-size="52" font-weight="700" fill="#1f2433">Harbour Studio</text></svg>',
    harbourSquare: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect x="14" y="14" width="92" height="92" rx="20" fill="#c4542f"/><path d="M30 70c10-9 20-9 30 0s20 9 30 0" fill="none" stroke="#fff" stroke-width="8" stroke-linecap="round"/></svg>',
    harbourSquareDark: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect x="14" y="14" width="92" height="92" rx="20" fill="none" stroke="#f3ece8" stroke-width="6"/><path d="M30 70c10-9 20-9 30 0s20 9 30 0" fill="none" stroke="#f3ece8" stroke-width="8" stroke-linecap="round"/></svg>',
    nordlysMark: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80" width="400" height="400"><rect width="80" height="80" rx="22" fill="#3fa7a0"/><path d="M18 58 40 22l22 36" fill="none" stroke="#fff" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    kestrelBanner: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 90"><path d="M20 58c26-4 40-22 86-44-12 26-26 56-60 60l-9 17-4-22z" fill="#1c2a44"/><text x="120" y="62" font-family="Arial,sans-serif" font-size="44" font-weight="800" fill="#1c2a44">KESTREL LABS</text></svg>'
  };

  var MockGraph = (function () {
    var KEY = "cardshare-mock-entra-v2";
    function seed() {
      var u = function (id, n, t, c, ph, m, d, o, mob, on) {
        return { id: id, displayName: n, jobTitle: t, companyName: c, businessPhones: ph, mail: m, userPrincipalName: m, department: d, officeLocation: o, mobilePhone: mob, accountEnabled: on };
      };
      return { v: 2, tenants: {
        harbour: { id: "7f3c2a1e-58d4-4b6a-9e0f-2c81d4a6b913", displayName: "Harbour Studio Ltd", verifiedDomains: ["harbour.example"],
          branding: { bannerLogo: svgURL(SVG.harbourBanner), squareLogo: svgURL(SVG.harbourSquare), squareLogoDark: svgURL(SVG.harbourSquareDark), backgroundColor: "#1F3A5F" },
          users: [
            u("3b1d9a70-1c2e-4f61-a0d7-5e8c0b2f4a11", "Maya Patel", "Head of Design", "Harbour Studio Ltd", ["+44 161 496 0100"], "maya.patel@harbour.example", "Design", "Manchester", "+44 7700 900101", true),
            u("8e4f2c19-7a3b-4d50-9c61-0f2e7b8d5c22", "Tom Okafor", "Account Director", null, ["+44 161 496 0101"], "tom.okafor@harbour.example", "Accounts", "Manchester", "+44 7700 900102", true),
            u("c27a6e83-0d4f-4b19-8e2a-6a9d1f3c7e33", "Priya Shah", null, "Harbour Studio Ltd", [], "priya.shah@harbour.example", "Engineering", "London", "+44 7700 900103", true),
            u("51f0b3d4-9e6a-4c27-b8f3-2d7c4e1a9b44", "Liam Byrne", "Studio Manager", "Harbour Studio Ltd", ["+44 161 496 0103"], "liam.byrne@harbour.example", null, "Manchester", null, true),
            u("a9d2e5f6-3b7c-4e81-9a04-8c1f6d2b0e55", "Ava Collins", "IT Manager", "Harbour Studio Ltd", ["+44 161 496 0104"], "ava.collins@harbour.example", "Operations", "Manchester", "+44 7700 900105", true),
            u("e6c8b1a2-4f9d-4a37-8b52-1e0d3c7f6a66", "James Wright", "Finance Lead", "Harbour Studio Ltd", ["+44 161 496 0105"], "james.wright@harbour.example", "Finance", "Leeds", "+44 7700 900106", false)
          ] },
        // Not on Cardshare yet: for trying "Set up Cardshare for your organisation" with Microsoft 365.
        kestrel: { id: "2d9e4b61-0c7a-4f38-a5e2-9b1c6f0d3a77", displayName: "Kestrel Labs Ltd", verifiedDomains: ["kestrel.example"],
          branding: { bannerLogo: svgURL(SVG.kestrelBanner), backgroundColor: "#1C2A44" },
          users: [
            u("5a1b2c3d-4e5f-4061-8728-394a5b6c7d81", "Rowan Blake", "IT Lead", "Kestrel Labs Ltd", ["+44 20 7946 0110"], "rowan.blake@kestrel.example", "IT", "London", null, true),
            u("6b2c3d4e-5f60-4172-9839-4a5b6c7d8e92", "Noor Haddad", "Research Scientist", "Kestrel Labs Ltd", ["+44 20 7946 0111"], "noor.haddad@kestrel.example", "Research", "London", null, true)
          ] }
      } };
    }
    function read() { try { var d = JSON.parse(localStorage.getItem(KEY) || "null"); if (d && d.v === 2) return d; } catch (e) {} var s = seed(); write(s); return s; }
    function write(d) { try { localStorage.setItem(KEY, JSON.stringify(d)); } catch (e) {} }
    function all() { var d = read(); return Object.keys(d.tenants).map(function (k) { return d.tenants[k]; }); }
    function tenant(tid) { return all().filter(function (t) { return t.id === tid; })[0] || null; }
    // What Cardshare is allowed to read: GET /users/{id}?$select=<these>. mobilePhone is deliberately not in the list.
    var SELECT = ["id", "displayName", "jobTitle", "companyName", "businessPhones", "mail", "userPrincipalName", "department", "officeLocation", "accountEnabled"];
    function pick(u) { var o = {}; SELECT.forEach(function (k) { o[k] = u[k] === undefined ? null : u[k]; }); return o; }
    return {
      SELECT: SELECT,
      user: function (tid, id) { var t = tenant(tid); var u = t && t.users.filter(function (x) { return x.id === id; })[0]; return u ? pick(u) : null; },
      userByMail: function (tid, mail) { var t = tenant(tid); mail = String(mail || "").toLowerCase(); var u = t && t.users.filter(function (x) { return String(x.mail || x.userPrincipalName).toLowerCase() === mail; })[0]; return u ? pick(u) : null; },
      users: function (tid) { var t = tenant(tid); return t ? t.users.map(pick) : []; },
      organization: function (tid) { var t = tenant(tid); return t ? { id: t.id, displayName: t.displayName, verifiedDomains: t.verifiedDomains.map(function (n) { return { name: n }; }) } : null; },
      branding: function (tid) { var t = tenant(tid); return t ? JSON.parse(JSON.stringify(t.branding)) : null; },
      // Which tenant a domain belongs to (Microsoft's sign-in works this out from the address).
      tenantForDomain: function (d) { d = String(d || "").toLowerCase(); return all().filter(function (t) { return t.verifiedDomains.indexOf(d) >= 0; })[0] || null; },
      // Prototype only: what an IT admin would do in the Microsoft 365 admin centre
      sim: {
        users: function () { return read().tenants.harbour.users.slice(); },
        update: function (id, patch) { var d = read(); Object.keys(d.tenants).forEach(function (k) { d.tenants[k].users.forEach(function (u) { if (u.id === id) Object.assign(u, patch); }); }); write(d); },
        reset: function () { localStorage.removeItem(KEY); }
      }
    };
  })();

  var MockServer = (function () {
    var KEY = "cardshare-mock-server-v3";
    var MAPPED = ["name", "title", "company", "office", "email", "department", "officeLocation"];
    var FREEMAIL = /^(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|aol|proton|protonmail)\.[a-z.]+$/;
    var HEX = /^#[0-9A-Fa-f]{6}$/;

    function logo(svg, w, h, lum) { return { url: svgURL(svg), type: "image/svg+xml", w: w, h: h, ratio: Math.round(w / h * 1000) / 1000, lum: lum, vector: true, trimmed: true, at: Date.now() }; }
    function newOrg(id, name, company, t) {
      return { id: id, name: name, company: company || name, discoverable: true, brandVersion: 1, logos: {}, branding: null, createdAt: t,
        source: "manual", ms: null, map: { department: false, officeLocation: false }, overrides: {}, invited: {}, status: "active", plan: "Trial" };
    }
    function seed() {
      var t = Date.now();
      var db = { v: 3, seq: 100, orgs: {}, domains: {}, employees: {}, links: {}, devices: {}, outbox: [], activity: [],
        admins: {}, members: [], sessions: {}, signups: {}, platform: {}, requests: {} };
      // Harbour Studio: Microsoft 365, coral and navy, serif, wide wordmark from its Microsoft sign-in page.
      var h = db.orgs.org_harbour = newOrg("org_harbour", "Harbour Studio", "Harbour Studio Ltd", t);
      h.source = "microsoft";
      h.ms = { tenantId: "7f3c2a1e-58d4-4b6a-9e0f-2c81d4a6b913", tenantName: "Harbour Studio Ltd", consentedBy: "ava.collins@harbour.example", connectedAt: t, lastSync: t, peopleFound: 5,
        permissions: ["User.Read.All (application)", "OrganizationalBranding.Read.All (application, for the logo)"] };
      h.logos.horizontal = Object.assign(logo(SVG.harbourBanner, 400, 45, 0.06), { source: "microsoft" });
      h.branding = { light: { primary: "#B8441F", accent: "#1F3A5F", card: "#FFF8F3", text: "#1B2433", buttonText: "#FFFFFF" }, darkAuto: true, radius: "soft", cardStyle: "brand", logoPlace: "centre", font: "serif" };
      db.domains["harbour.example"] = { orgId: h.id, verified: true, method: "microsoft", txt: "", at: t };
      // Nordlys: by hand, deep fjord card, round corners, geometric type, square mark on the left.
      var n = db.orgs.org_nordlys = newOrg("org_nordlys", "Nordlys", "Nordlys AS", t);
      n.logos.mark = logo(SVG.nordlysMark, 400, 400, 0.3);
      n.branding = { light: { primary: "#1E7A70", accent: "#3FA7A0", card: "#0F2B2E", text: "#E8F6F3", buttonText: "#FFFFFF" }, darkAuto: true, radius: "round", cardStyle: "brand", logoPlace: "left", font: "geometric" };
      db.domains["nordlys.example"] = { orgId: n.id, verified: true, method: "dns", txt: "cardshare-verify=nl7d2k", at: t };
      // Pine & Post: by hand, no logo (initials badge), forest and cream, sharp corners.
      var p = db.orgs.org_pine = newOrg("org_pine", "Pine & Post", "Pine & Post", t);
      p.branding = { light: { primary: "#2E5E3A", accent: "#9BC48A", card: "#F4EFE3", text: "#23301F", buttonText: "#F4EFE3" }, darkAuto: true, radius: "sharp", cardStyle: "brand", logoPlace: "centre", font: "system" };
      db.domains["pinepost.example"] = { orgId: p.id, verified: true, method: "email", txt: "cardshare-verify=pp4q9x", at: t };
      [["org_nordlys", "Ingrid Solberg", "Founder", "+47 21 00 00 10", "ingrid.solberg@nordlys.example"],
       ["org_nordlys", "Erik Dahl", "Lead Designer", "+47 21 00 00 11", "erik.dahl@nordlys.example"],
       ["org_nordlys", "Mia Berg", "Producer", "+47 21 00 00 12", "mia.berg@nordlys.example"],
       ["org_pine", "Jo Fairley", "Owner", "+44 1632 960 010", "jo.fairley@pinepost.example"],
       ["org_pine", "Hannah Price", "Shop Manager", "+44 1632 960 011", "hannah.price@pinepost.example"],
       ["org_pine", "Owen Hughes", "Buyer", "", "owen.hughes@pinepost.example"]].forEach(function (r, i) {
        var id = "emp_" + (i + 1);
        db.employees[id] = { id: id, orgId: r[0], name: r[1], title: r[2], office: r[3], email: r[4], company: "", version: 1, invitedAt: null, removedAt: null, createdAt: t };
      });
      // Admins. Ingrid owns Nordlys and also helps run Pine & Post, so she sees an organisation switcher.
      [["adm_ava", "Ava Collins", "ava.collins@harbour.example", [["org_harbour", "owner"]]],
       ["adm_ingrid", "Ingrid Solberg", "ingrid.solberg@nordlys.example", [["org_nordlys", "owner"], ["org_pine", "admin"]]],
       ["adm_jo", "Jo Fairley", "jo.fairley@pinepost.example", [["org_pine", "owner"]]]].forEach(function (a) {
        db.admins[a[0]] = { id: a[0], name: a[1], email: a[2], createdAt: t };
        a[3].forEach(function (m) { db.members.push({ adminId: a[0], orgId: m[0], role: m[1] }); });
      });
      ["org_harbour", "org_nordlys", "org_pine"].forEach(function (o) { db.activity.push({ at: t, orgId: o, t: db.orgs[o].name + " set up (sample data)" }); });
      return db;
    }
    function read() { try { var d = JSON.parse(localStorage.getItem(KEY) || "null"); if (d && d.v === 3) { d.requests = d.requests || {}; return d; } } catch (e) {} var s = seed(); write(s); return s; }
    function write(db) { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) {} }
    function rid(p) { var a = new Uint8Array(16); (crypto.getRandomValues ? crypto.getRandomValues(a) : a.forEach(function (_, i) { a[i] = Math.random() * 256; })); return p + Array.prototype.map.call(a, function (b) { return ("0" + b.toString(16)).slice(-2); }).join(""); }
    function res(status, body, headers) { return { status: status, headers: headers || {}, body: body === undefined ? null : body }; }
    function domainOf(email) { email = String(email || "").trim().toLowerCase(); var i = email.lastIndexOf("@"); return i > 0 ? email.slice(i + 1) : ""; }
    function bearer(h) { var a = h.Authorization || ""; return a.indexOf("Bearer ") === 0 ? a.slice(7) : ""; }
    function hash(s) { var h = 5381; for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
    function log(db, orgId, t) { db.activity.unshift({ at: Date.now(), orgId: orgId, t: t }); db.activity = db.activity.slice(0, 120); }
    function isMs(o) { return o && o.source === "microsoft" && o.ms; }
    function live(o) { return o && o.status === "active"; }
    function orgDomains(db, id) { return Object.keys(db.domains).filter(function (d) { return db.domains[d].orgId === id; }); }
    function orgOfDomain(db, d) { var x = db.domains[String(d || "").toLowerCase()]; return x ? db.orgs[x.orgId] : null; }
    function txtCode() { return "cardshare-verify=" + rid("").slice(0, 10); }
    function setDomains(db, orgId, list, verifiedBy) {
      Object.keys(db.domains).forEach(function (k) { if (db.domains[k].orgId === orgId && list.indexOf(k) < 0) delete db.domains[k]; });
      list.forEach(function (k) {
        if (!db.domains[k]) db.domains[k] = { orgId: orgId, verified: false, method: "", txt: txtCode(), at: null };
        if (verifiedBy) { db.domains[k].verified = true; db.domains[k].method = verifiedBy; db.domains[k].at = Date.now(); }
      });
    }

    // Branding as stored: colours must be #RRGGBB, options from fixed lists. Anything else is dropped.
    function cleanBranding(b) {
      if (!b || typeof b !== "object") return null;
      var keys = ["primary", "accent", "card", "text", "buttonText"], set = function (src) {
        if (!src) return null; var o = {}; for (var i = 0; i < keys.length; i++) { if (!HEX.test(src[keys[i]] || "")) return null; o[keys[i]] = src[keys[i]].toUpperCase(); } return o;
      };
      var light = set(b.light); if (!light) return null;
      var darkAuto = b.darkAuto !== false, dark = darkAuto ? null : set(b.dark);
      return { light: light, dark: dark, darkAuto: darkAuto || !dark,
        radius: ["sharp", "soft", "round"].indexOf(b.radius) >= 0 ? b.radius : "soft",
        cardStyle: ["brand", "light", "dark"].indexOf(b.cardStyle) >= 0 ? b.cardStyle : "brand",
        logoPlace: b.logoPlace === "left" ? "left" : "centre",
        font: ["inter", "serif", "geometric", "system"].indexOf(b.font) >= 0 ? b.font : "inter" };
    }

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
    // Who a device or a link belongs to, checked live. null = removed: deleted or disabled in Microsoft 365, removed by the
    // admin, the organisation deleted, or the organisation changed how it manages cards. A suspended org is returned; the
    // caller answers 423.
    function holder(db, h) {
      if (!h) return null;
      if (h.empId) { var e = db.employees[h.empId], o1 = e && db.orgs[e.orgId]; return e && !e.removedAt && o1 && !isMs(o1) ? { org: o1, card: manualCard(o1, e), name: e.name } : null; }
      var o = db.orgs[h.orgId]; if (!isMs(o)) return null;
      var u = MockGraph.user(o.ms.tenantId, h.msUid);
      return u && u.accountEnabled ? { org: o, card: msCard(o, u), u: u } : null;
    }
    function etagOf(hd) { return '"c' + hash(JSON.stringify(hd.card)) + "-o" + hd.org.brandVersion + '"'; }
    function cardBody(hd) {
      var o = hd.org;
      return { card: hd.card, org: { id: o.id, name: o.name, logos: JSON.parse(JSON.stringify(o.logos || {})), branding: o.branding ? JSON.parse(JSON.stringify(o.branding)) : null }, version: etagOf(hd) };
    }
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
      var o = db.orgs[id], doms = orgDomains(db, id);
      return Object.assign({}, o, { domains: doms, overrides: undefined, invited: undefined,
        domainStatus: doms.map(function (d) { var x = db.domains[d]; return { name: d, verified: x.verified, method: x.method, txt: x.txt, record: "_cardshare." + d }; }) });
    }
    function cleanEmp(b, keys) {
      var out = {};
      (keys || ["name", "title", "office", "email", "company"]).forEach(function (k) { if (typeof b[k] === "string") out[k] = b[k].trim(); });
      if (out.email) out.email = out.email.toLowerCase();
      return out;
    }
    function issueLink(db, h, to, ttl, kind) {
      var tok = rid("lnk_"), t = Date.now();
      db.links[tok] = Object.assign({ exp: t + ttl, used: false }, h);
      db.outbox.unshift({ to: to, token: tok, at: t, kind: kind || "phone", orgId: h.orgId || (h.empId && db.employees[h.empId] && db.employees[h.empId].orgId) || null });
      db.outbox = db.outbox.slice(0, 60);
      return tok;
    }
    function memberships(db, adminId) {
      return db.members.filter(function (m) { return m.adminId === adminId && db.orgs[m.orgId]; }).map(function (m) {
        var o = db.orgs[m.orgId]; return { id: o.id, name: o.name, role: m.role, status: o.status, source: o.source };
      });
    }
    function me(db, token) {
      var s = db.sessions[token], a = s && db.admins[s.adminId]; if (!a) return null;
      var orgs = memberships(db, a.id), cur = orgs.filter(function (o) { return o.id === s.orgId; })[0] || orgs[0] || null;
      if (cur) s.orgId = cur.id;
      return { admin: { id: a.id, name: a.name, email: a.email }, orgs: orgs, orgId: cur ? cur.id : null, role: cur ? cur.role : null };
    }
    function newSession(db, adminId, orgId) { var tok = rid("ses_"); db.sessions[tok] = { adminId: adminId, orgId: orgId || null, at: Date.now() }; return tok; }
    function adminByEmail(db, email) { email = String(email || "").trim().toLowerCase(); return Object.keys(db.admins).map(function (k) { return db.admins[k]; }).filter(function (a) { return a.email === email; })[0] || null; }
    function deleteOrg(db, id) {
      orgDomains(db, id).forEach(function (d) { delete db.domains[d]; });
      Object.keys(db.employees).forEach(function (k) { if (db.employees[k].orgId === id) delete db.employees[k]; });
      Object.keys(db.links).forEach(function (k) { if (db.links[k].orgId === id) delete db.links[k]; });
      db.members = db.members.filter(function (m) { return m.orgId !== id; });
      Object.keys(db.requests || {}).forEach(function (k) { if (db.requests[k].orgId === id) delete db.requests[k]; });
      db.activity = db.activity.filter(function (a) { return a.orgId !== id; });
      delete db.orgs[id];
      // Phones keep their device rows; their next check-in finds no organisation and answers 410, so they wipe the card.
    }

    function route(req) {
      var db = read(), m = req.method, p = req.path.split("?")[0], b = req.body || {}, t = Date.now(), x, o, u, hd, tok, L;
      // ---- phone
      if (m === "POST" && p === "/v1/discover") {
        var dd = db.domains[String(b.domain || "").toLowerCase()];
        o = dd && dd.verified ? db.orgs[dd.orgId] : null;
        return res(200, { org: live(o) && o.discoverable ? { name: o.name, microsoft: !!isMs(o) } : null });
      }
      if (m === "POST" && p === "/v1/auth/link") {
        var em = String(b.email || "").trim().toLowerCase();
        o = orgOfDomain(db, domainOf(em));
        if (isMs(o)) { if (live(o)) { u = MockGraph.userByMail(o.ms.tenantId, em); if (u && u.accountEnabled) issueLink(db, { orgId: o.id, msUid: u.id }, em, 15 * 60 * 1000); } }
        else {
          var emp = Object.keys(db.employees).map(function (k) { return db.employees[k]; }).filter(function (e) { return e.email === em && !e.removedAt && live(db.orgs[e.orgId]); })[0];
          if (emp) issueLink(db, { empId: emp.id }, em, 15 * 60 * 1000);
        }
        write(db);
        return res(202, { ok: true }); // the same answer for every address
      }
      // Stands in for Microsoft's sign-in page + the Worker's OIDC callback (worker/src/microsoft.js).
      if (m === "POST" && p === "/v1/auth/microsoft/mock") {
        o = orgOfDomain(db, domainOf(b.email));
        if (!isMs(o) || !live(o)) return res(403, { error: "not_connected" });
        u = MockGraph.userByMail(o.ms.tenantId, b.email);
        if (!u) return res(404, { error: "not_in_directory" });
        if (!u.accountEnabled) return res(403, { error: "disabled" });
        tok = rid("lnk_"); db.links[tok] = { orgId: o.id, msUid: u.id, exp: t + 5 * 60 * 1000, used: false, via: "microsoft" };
        write(db); return res(200, { token: tok });
      }
      if (m === "POST" && p === "/v1/auth/verify") {
        L = db.links[b.token];
        if (!L || L.used || L.exp < t || L.kind) return res(400, { error: "invalid_or_expired" });
        hd = holder(db, L);
        if (!hd || !live(hd.org)) return res(400, { error: "invalid_or_expired" });
        L.used = true;
        var dt = rid("dev_");
        db.devices[dt] = { empId: L.empId || null, orgId: hd.org.id, msUid: L.msUid || null, createdAt: t, lastSeen: t, label: (b.device && b.device.label) || "" };
        log(db, hd.org.id, L.msUid ? "A phone signed in (Microsoft 365 user" + (L.via === "microsoft" ? ", Sign in with Microsoft)" : ", email link)") : hd.name + " signed in on a phone");
        write(db);
        return res(200, { deviceToken: dt, org: { name: hd.org.name } });
      }
      if ((m === "GET" && p === "/v1/card") || (m === "POST" && p === "/v1/checkin")) {
        var bt = bearer(req.headers), d = db.devices[bt];
        if (!d) return res(401, { error: "signed_out" });
        hd = holder(db, d);
        if (!hd) { delete db.devices[bt]; write(db); return res(410, { error: "removed" }); }
        if (!live(hd.org)) return res(423, { error: "suspended" });
        d.lastSeen = t; if (isMs(hd.org)) hd.org.ms.lastSync = t; write(db);
        var tag = etagOf(hd);
        if (p === "/v1/checkin") return res(200, { changed: b.version !== tag, version: tag });
        if (req.headers["If-None-Match"] === tag) return res(304, null, { etag: tag });
        return res(200, cardBody(hd), { etag: tag });
      }
      if (m === "POST" && p === "/v1/auth/signout") { delete db.devices[bearer(req.headers)]; write(db); return res(204); }

      // ---- admin sign-in
      if (m === "POST" && p === "/v1/admin/auth/link") {
        var ad = adminByEmail(db, b.email);
        if (ad) { issueLink(db, { kind: "admin", adminId: ad.id }, ad.email, 15 * 60 * 1000, "admin"); write(db); }
        return res(202, { ok: true });
      }
      // Stands in for Microsoft's sign-in page: the address must be a user in a Microsoft 365 directory and a Cardshare admin.
      if (m === "POST" && p === "/v1/admin/auth/microsoft/mock") {
        var ten = MockGraph.tenantForDomain(domainOf(b.email));
        if (!ten) return res(404, { error: "Microsoft didn't recognise that work account. Use the email link instead." });
        u = MockGraph.userByMail(ten.id, b.email);
        if (!u || !u.accountEnabled) return res(403, { error: "Microsoft says that account doesn't exist or is turned off." });
        var ad2 = adminByEmail(db, b.email);
        if (!ad2) return res(403, { error: "Signed in with Microsoft, but " + b.email + " isn't an admin on Cardshare. Ask your organisation's owner to add you, or set up your organisation." });
        tok = rid("lnk_"); db.links[tok] = { kind: "admin", adminId: ad2.id, exp: t + 5 * 60 * 1000, used: false };
        write(db); return res(200, { token: tok });
      }
      if (m === "POST" && p === "/v1/admin/auth/verify") {
        L = db.links[b.token];
        if (!L || L.used || L.exp < t || L.kind !== "admin" || !db.admins[L.adminId]) return res(400, { error: "That sign-in link has expired or was already used." });
        L.used = true;
        var st = newSession(db, L.adminId, null), info = me(db, st);
        write(db); return res(200, Object.assign({ sessionToken: st }, info));
      }
      // ---- sign-up
      if (m === "POST" && p === "/v1/signup/start") {
        var se = String(b.email || "").trim().toLowerCase(), sd = domainOf(se);
        if (!/^[^@\s]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(se)) return res(400, { error: "Enter your work email, like name@company.com." });
        if (FREEMAIL.test(sd)) return res(400, { error: "Use your work email. Personal addresses like " + sd + " can't own an organisation." });
        issueLink(db, { kind: "signup", email: se }, se, 60 * 60 * 1000, "signup"); write(db);
        return res(202, { ok: true });
      }
      if (m === "POST" && p === "/v1/signup/verify") {
        L = db.links[b.token];
        if (!L || L.used || L.exp < t || L.kind !== "signup") return res(400, { error: "That link has expired or was already used." });
        L.used = true; tok = rid("sgn_"); db.signups[tok] = { email: L.email, exp: t + 60 * 60 * 1000 };
        var taken = orgOfDomain(db, domainOf(L.email));
        write(db); return res(200, { signupToken: tok, email: L.email, domain: domainOf(L.email), taken: taken ? taken.name : null,
          microsoft: !!MockGraph.tenantForDomain(domainOf(L.email)) });
      }
      if (m === "POST" && p === "/v1/signup/org") {
        var sg = db.signups[b.signupToken];
        if (!sg || sg.exp < t) return res(400, { error: "Your sign-up has expired. Start again." });
        var nm = String(b.name || "").trim().slice(0, 80); if (!nm) return res(400, { error: "Name your organisation." });
        var dom = domainOf(sg.email), tk2 = orgOfDomain(db, dom);
        if (tk2) return res(409, { error: dom + " already uses Cardshare (" + tk2.name + "). Ask its owner to add you as an admin." });
        var oid = "org_" + rid("").slice(0, 10);
        db.orgs[oid] = newOrg(oid, nm, nm, t);
        setDomains(db, oid, [dom]);
        var adm = adminByEmail(db, sg.email);
        if (!adm) { adm = { id: "adm_" + rid("").slice(0, 10), name: sg.email.split("@")[0], email: sg.email, createdAt: t }; db.admins[adm.id] = adm; }
        db.members.push({ adminId: adm.id, orgId: oid, role: "owner" });
        delete db.signups[b.signupToken];
        log(db, oid, nm + " set up by " + sg.email);
        var s2 = newSession(db, adm.id, oid);
        write(db); return res(201, Object.assign({ sessionToken: s2 }, me(db, s2)));
      }
      // Someone whose domain is already taken asks to join. The organisation's owners see it in the console (and, for real,
      // get an email); approving adds them as an Admin. The answer doesn't change with whether a request already exists.
      if (m === "POST" && p === "/v1/signup/request") {
        var sq = db.signups[b.signupToken];
        if (!sq || sq.exp < t) return res(400, { error: "Your sign-up has expired. Start again." });
        var ro = orgOfDomain(db, domainOf(sq.email));
        if (!ro) return res(404, { error: "No organisation uses that domain." });
        var dup = Object.keys(db.requests).some(function (k) { var r = db.requests[k]; return r.orgId === ro.id && r.email === sq.email && r.status === "pending"; });
        var already = db.members.some(function (mm) { var a = db.admins[mm.adminId]; return mm.orgId === ro.id && a && a.email === sq.email; });
        if (!dup && !already) {
          var rq = "req_" + rid("").slice(0, 10);
          db.requests[rq] = { id: rq, orgId: ro.id, email: sq.email, at: t, status: "pending" };
          log(db, ro.id, sq.email + " asked to join as an admin (waiting for an owner)");
        }
        write(db); return res(202, { org: ro.name });
      }
      // Confirms a domain from the email sent to admin@<domain> (the fallback to a DNS record).
      if (m === "POST" && p === "/v1/domains/confirm") {
        L = db.links[b.token];
        if (!L || L.used || L.exp < t || L.kind !== "domain" || !db.domains[L.domain] || db.domains[L.domain].orgId !== L.orgId) return res(400, { error: "That link has expired or was already used." });
        L.used = true; Object.assign(db.domains[L.domain], { verified: true, method: "email", at: t });
        log(db, L.orgId, L.domain + " verified by email"); write(db); return res(200, { domain: L.domain, verified: true });
      }

      // ---- platform (Cardshare staff). No staff details: counts only.
      if (m === "POST" && p === "/v1/platform/auth/mock") { db.platform["mock-platform"] = { at: t }; write(db); return res(200, { token: "mock-platform" }); }
      if (p.indexOf("/v1/platform/") === 0) {
        if (!db.platform[bearer(req.headers)]) return res(401, { error: "platform_signed_out" });
        if (m === "GET" && p === "/v1/platform/orgs") {
          return res(200, { orgs: Object.keys(db.orgs).map(function (k) {
            var og = db.orgs[k], ms = isMs(og);
            return { id: og.id, name: og.name, source: og.source, status: og.status, plan: og.plan, createdAt: og.createdAt,
              tenantName: ms ? og.ms.tenantName : null,
              domains: orgDomains(db, og.id).map(function (dn) { var dx = db.domains[dn]; return { name: dn, verified: dx.verified, method: dx.method }; }),
              phones: devicesFor(db, function (dv) { return dv.orgId === og.id || (dv.empId && db.employees[dv.empId] && db.employees[dv.empId].orgId === og.id); }).n,
              // Hand-typed orgs: how many records Cardshare holds. Microsoft orgs: none are held, so none are counted.
              storedPeople: ms ? null : Object.keys(db.employees).filter(function (e) { return db.employees[e].orgId === og.id; }).length,
              admins: db.members.filter(function (mm) { return mm.orgId === og.id; }).length };
          }) });
        }
        if ((x = /^\/v1\/platform\/orgs\/([\w-]+)(?:\/(suspend|restore))?$/.exec(p))) {
          o = db.orgs[x[1]]; if (!o) return res(404, { error: "not_found" });
          if (m === "POST" && x[2]) { o.status = x[2] === "suspend" ? "suspended" : "active"; log(db, o.id, x[2] === "suspend" ? "Suspended by Cardshare" : "Restored by Cardshare"); write(db); return res(200, { id: o.id, status: o.status }); }
          if (m === "DELETE" && !x[2]) { deleteOrg(db, o.id); write(db); return res(204); }
        }
        return res(404, { error: "no_route" });
      }

      // ---- admin (one admin session, one current organisation)
      if (p.indexOf("/v1/admin/") === 0) {
        var stok = bearer(req.headers), info2 = me(db, stok);
        if (!info2) return res(401, { error: "admin_signed_out" });
        if (m === "GET" && p === "/v1/admin/me") { write(db); return res(200, info2); }
        if (m === "POST" && p === "/v1/admin/auth/signout") { delete db.sessions[stok]; write(db); return res(204); }
        if (m === "POST" && p === "/v1/admin/session/org") {
          if (!info2.orgs.some(function (og) { return og.id === b.orgId; })) return res(403, { error: "You're not an admin of that organisation." });
          db.sessions[stok].orgId = b.orgId; write(db); return res(200, me(db, stok));
        }
        if (!info2.orgId) return res(404, { error: "no_org" });
        var orgId = info2.orgId, org = db.orgs[orgId], ms = isMs(org), owner = info2.role === "owner";
        if (!live(org)) return res(423, { error: "This organisation is suspended by Cardshare. Phones keep their cards hidden until it is restored. Contact support." });
        var OWNER = res(403, { error: "Only an owner can do that." });
        var mine = function (id) { var e2 = db.employees[id]; return e2 && e2.orgId === orgId && !e2.removedAt ? e2 : null; };
        var NO_MS = res(409, { error: "People come from Microsoft 365. Add or remove them there." });
        if (m === "GET" && p === "/v1/admin/org") return res(200, orgView(db, orgId));
        if (m === "PATCH" && p === "/v1/admin/org") {
          var brand = false;
          if (typeof b.name === "string" && b.name.trim() && b.name.trim() !== org.name) { org.name = b.name.trim(); brand = true; }
          if (typeof b.company === "string" && b.company.trim() !== org.company) { org.company = b.company.trim(); brand = true; }
          if (typeof b.discoverable === "boolean") org.discoverable = b.discoverable;
          if (b.map && typeof b.map === "object") ["department", "officeLocation"].forEach(function (k) { if (typeof b.map[k] === "boolean") org.map[k] = b.map[k]; });
          if (Array.isArray(b.domains) && !ms) { // Microsoft-connected: the tenant's verified domains are used instead
            if (!owner) return OWNER;
            var want = b.domains.map(function (s) { return String(s).trim().toLowerCase().replace(/^@/, ""); }).filter(function (s) { return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s); });
            for (var i = 0; i < want.length; i++) if (db.domains[want[i]] && db.domains[want[i]].orgId !== orgId) return res(409, { error: want[i] + " belongs to another organisation" });
            setDomains(db, orgId, want);
          }
          if (brand) { org.brandVersion++; log(db, orgId, "Organisation details changed"); }
          write(db); return res(200, orgView(db, orgId));
        }
        if (m === "PUT" && p === "/v1/admin/branding") {
          if (b && b.reset) org.branding = null;
          else { var cb = cleanBranding(b); if (!cb) return res(400, { error: "Colours must be hex, like #1F3A5F." }); org.branding = cb; }
          org.brandVersion++; log(db, orgId, b && b.reset ? "Branding reset to the Cardshare look" : "Branding changed");
          write(db); return res(200, orgView(db, orgId));
        }
        if (m === "POST" && p === "/v1/admin/domains/verify") {
          if (!owner) return OWNER;
          var vd = db.domains[String(b.domain || "").toLowerCase()];
          if (!vd || vd.orgId !== orgId) return res(404, { error: "not_found" });
          if (vd.verified) return res(200, orgView(db, orgId));
          if (b.method === "dns") { // the Worker looks the TXT record up over DNS-over-HTTPS; the mock finds it at once
            Object.assign(vd, { verified: true, method: "dns", at: t }); log(db, orgId, b.domain + " verified by DNS record");
            write(db); return res(200, orgView(db, orgId));
          }
          if (b.method === "email") {
            if (["admin", "postmaster", "webmaster"].indexOf(b.to || "admin") < 0) return res(400, { error: "Choose admin@, postmaster@ or webmaster@." });
            var to = (b.to || "admin") + "@" + b.domain;
            issueLink(db, { kind: "domain", orgId: orgId, domain: b.domain }, to, DAY, "domain"); write(db);
            return res(202, { sent: to });
          }
          return res(400, { error: "method" });
        }
        // -- admins of this organisation
        if (m === "GET" && p === "/v1/admin/admins") {
          return res(200, { admins: db.members.filter(function (mm) { return mm.orgId === orgId; }).map(function (mm) {
            var a = db.admins[mm.adminId]; return { id: a.id, name: a.name, email: a.email, role: mm.role, you: a.id === info2.admin.id };
          }), requests: Object.keys(db.requests).map(function (k) { return db.requests[k]; }).filter(function (r) { return r.orgId === orgId && r.status === "pending"; }) });
        }
        if ((x = /^\/v1\/admin\/requests\/([\w-]+)\/(approve|decline)$/.exec(p)) && m === "POST") {
          if (!owner) return OWNER;
          var rr = db.requests[x[1]];
          if (!rr || rr.orgId !== orgId || rr.status !== "pending") return res(404, { error: "not_found" });
          rr.status = x[2] === "approve" ? "approved" : "declined"; rr.decidedBy = info2.admin.email; rr.decidedAt = t;
          if (x[2] === "approve") {
            var ra = adminByEmail(db, rr.email);
            if (!ra) { ra = { id: "adm_" + rid("").slice(0, 10), name: rr.email.split("@")[0], email: rr.email, createdAt: t }; db.admins[ra.id] = ra; }
            if (!db.members.some(function (mm) { return mm.adminId === ra.id && mm.orgId === orgId; })) db.members.push({ adminId: ra.id, orgId: orgId, role: "admin" });
            issueLink(db, { kind: "admin", adminId: ra.id }, ra.email, 7 * DAY, "admin");
            log(db, orgId, rr.email + "'s request approved by " + info2.admin.email + ": added as Admin");
          } else log(db, orgId, rr.email + "'s request declined by " + info2.admin.email);
          write(db); return res(200, { status: rr.status });
        }
        if (m === "POST" && p === "/v1/admin/admins") {
          if (!owner) return OWNER;
          var ae = String(b.email || "").trim().toLowerCase(), role = b.role === "owner" ? "owner" : "admin";
          if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(ae)) return res(400, { error: "Enter their work email." });
          var aa = adminByEmail(db, ae);
          if (!aa) { aa = { id: "adm_" + rid("").slice(0, 10), name: ae.split("@")[0], email: ae, createdAt: t }; db.admins[aa.id] = aa; }
          if (db.members.some(function (mm) { return mm.adminId === aa.id && mm.orgId === orgId; })) return res(409, { error: ae + " is already an admin here." });
          db.members.push({ adminId: aa.id, orgId: orgId, role: role });
          issueLink(db, { kind: "admin", adminId: aa.id }, ae, 7 * DAY, "admin");
          log(db, orgId, "Added " + ae + " as " + role); write(db); return res(201, { ok: true });
        }
        if ((x = /^\/v1\/admin\/admins\/([\w-]+)$/.exec(p)) && m === "DELETE") {
          if (!owner) return OWNER;
          var mem = db.members.filter(function (mm) { return mm.orgId === orgId && mm.adminId === x[1]; })[0];
          if (!mem) return res(404, { error: "not_found" });
          if (mem.role === "owner" && db.members.filter(function (mm) { return mm.orgId === orgId && mm.role === "owner"; }).length < 2) return res(409, { error: "An organisation needs at least one owner." });
          db.members.splice(db.members.indexOf(mem), 1);
          log(db, orgId, "Removed admin " + db.admins[x[1]].email); write(db); return res(204);
        }
        // -- Microsoft 365
        if (m === "POST" && p === "/v1/admin/microsoft/connect") {
          if (!owner) return OWNER;
          if (!b.consent) return res(400, { error: "Admin consent was not granted" });
          // Microsoft works out the tenant from who signs in; the mock uses the organisation's domains or the admin's address.
          var tn = null; orgDomains(db, orgId).concat([domainOf(info2.admin.email)]).forEach(function (dn) { tn = tn || MockGraph.tenantForDomain(dn); });
          if (!tn) return res(404, { error: "No Microsoft 365 tenant found for " + (orgDomains(db, orgId)[0] || domainOf(info2.admin.email)) + ". (Prototype: try an organisation at kestrel.example, or Harbour Studio.)" });
          if (Object.keys(db.orgs).some(function (k) { return k !== orgId && isMs(db.orgs[k]) && db.orgs[k].ms.tenantId === tn.id; })) return res(409, { error: tn.displayName + " is already connected to another organisation on Cardshare." });
          var orgInfo = MockGraph.organization(tn.id), doms = orgInfo.verifiedDomains.map(function (v) { return v.name; });
          for (var j = 0; j < doms.length; j++) if (db.domains[doms[j]] && db.domains[doms[j]].orgId !== orgId) return res(409, { error: doms[j] + " belongs to another organisation" });
          // Phones already signed in keep working if their person is in the directory; everything typed by hand is deleted.
          var moved = 0, dropped = 0;
          Object.keys(db.devices).forEach(function (k) {
            var dv = db.devices[k], e = dv.empId && db.employees[dv.empId]; if (!e || e.orgId !== orgId) return;
            var du = MockGraph.userByMail(tn.id, e.email);
            if (du && du.accountEnabled) { db.devices[k] = { empId: null, orgId: orgId, msUid: du.id, createdAt: dv.createdAt, lastSeen: dv.lastSeen, label: dv.label }; moved++; }
            else { delete db.devices[k]; dropped++; }
          });
          var gone2 = 0;
          Object.keys(db.employees).forEach(function (k) { if (db.employees[k].orgId === orgId) { delete db.employees[k]; gone2++; } });
          Object.keys(db.links).forEach(function (k) { if (db.links[k].empId && !db.employees[db.links[k].empId]) delete db.links[k]; });
          setDomains(db, orgId, doms, "microsoft"); // connecting proves the domains: Microsoft has verified them
          var people = MockGraph.users(tn.id).filter(function (q) { return q.accountEnabled; }).length;
          org.source = "microsoft"; org.overrides = {}; org.invited = {};
          org.ms = { tenantId: tn.id, tenantName: orgInfo.displayName, consentedBy: info2.admin.email, connectedAt: t, lastSync: t, peopleFound: people,
            permissions: ["User.Read.All (application)", "OrganizationalBranding.Read.All (application, for the logo)"] };
          org.brandVersion++;
          log(db, orgId, "Connected Microsoft 365 (" + orgInfo.displayName + "): " + people + " people found." + (gone2 ? " " + gone2 + " hand-typed records deleted." : "") +
            (moved || dropped ? " Signed-in phones: " + moved + " kept, " + dropped + " signed out." : ""));
          write(db); return res(200, orgView(db, orgId));
        }
        if (m === "POST" && p === "/v1/admin/microsoft/disconnect") {
          if (!owner) return OWNER;
          if (!ms) return res(409, { error: "Not connected" });
          var tname = org.ms.tenantName;
          org.source = "manual"; org.ms = null; org.overrides = {}; org.invited = {}; org.brandVersion++;
          Object.keys(db.links).forEach(function (k) { if (db.links[k].orgId === orgId && db.links[k].msUid) delete db.links[k]; });
          orgDomains(db, orgId).forEach(function (dn) { if (db.domains[dn].method === "microsoft") Object.assign(db.domains[dn], { verified: false, method: "", txt: txtCode() }); });
          log(db, orgId, "Disconnected Microsoft 365 (" + tname + "). Signed-in phones drop their work cards at their next check-in");
          write(db); return res(200, orgView(db, orgId));
        }
        if (m === "POST" && p === "/v1/admin/microsoft/sync") {
          if (!ms) return res(409, { error: "Not connected" });
          org.ms.peopleFound = MockGraph.users(org.ms.tenantId).filter(function (q) { return q.accountEnabled; }).length; org.ms.lastSync = t;
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
            // The console's "Offline" switch simulates the phone losing signal, so it leaves the consoles' own calls alone.
            var phoneOff = localStorage.getItem("cardshare-mock-offline") === "1" && /^\/v1\/(discover|auth\/|card|checkin)/.test(req.path);
            if (navigator.onLine === false || phoneOff) { fail(new TypeError("Failed to fetch")); return; }
            try { ok(route(req)); } catch (e) { fail(e); }
          }, 160 + Math.random() * 300);
        });
      },
      // Prototype only, not API routes: the stand-ins for opening an email.
      peekOutbox: function (email, kind) {
        var db = read(), em = String(email || "").trim().toLowerCase();
        var hit = db.outbox.filter(function (o) { return o.to === em && (o.kind || "phone") === (kind || "phone") && db.links[o.token] && !db.links[o.token].used && db.links[o.token].exp > Date.now(); })[0];
        return hit ? hit.token : null;
      },
      outbox: function (orgId) {
        var db = read();
        return db.outbox.filter(function (o) { var L = db.links[o.token]; return (o.kind || "phone") === "phone" && (!orgId || o.orgId === orgId) && L && !L.used && L.exp > Date.now(); });
      },
      KEY: KEY,
      graph: MockGraph,
      reset: function () { localStorage.removeItem(KEY); MockGraph.sim.reset(); }
    };
  })();

  Sync.request = request;
  if (!API) Sync.mockServer = MockServer;
  window.CardshareSync = Sync;
})();
