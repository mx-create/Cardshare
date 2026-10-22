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
        activity: function () { return call("GET", "/v1/admin/activity"); }
      };
    }
  };

  // ================================================================ mock backend
  // Mirrors the D1 tables in worker/schema.sql. Lives in localStorage so the admin console (/admin/) and the app
  // in another tab, or in the console's phone frame, see the same "server".
  var MockServer = (function () {
    var KEY = "cardshare-mock-server-v1";
    function seed() {
      var t = Date.now(), org = "org_harbour";
      var db = { v: 1, seq: 100, orgs: {}, domains: {}, employees: {}, links: {}, devices: {}, outbox: [], activity: [], admins: { "mock-admin": org } };
      db.orgs[org] = { id: org, name: "Harbour Studio", company: "Harbour Studio Ltd", discoverable: true, brandVersion: 1, logos: {}, createdAt: t };
      db.domains["harbour.example"] = org;
      [["Maya Patel", "Head of Design", "+44 161 496 0100", "maya.patel@harbour.example"],
       ["Tom Okafor", "Account Director", "+44 161 496 0101", "tom.okafor@harbour.example"],
       ["Priya Shah", "Senior Engineer", "+44 161 496 0102", "priya.shah@harbour.example"],
       ["Liam Byrne", "Studio Manager", "+44 161 496 0103", "liam.byrne@harbour.example"]].forEach(function (p, i) {
        var id = "emp_" + (i + 1);
        db.employees[id] = { id: id, orgId: org, name: p[0], title: p[1], office: p[2], email: p[3], company: "", version: 1, invitedAt: null, removedAt: null, createdAt: t };
      });
      db.activity.push({ at: t, orgId: org, t: "Harbour Studio set up with 4 people (sample data)" });
      return db;
    }
    function read() { try { var d = JSON.parse(localStorage.getItem(KEY) || "null"); if (d && d.v === 1) return d; } catch (e) {} var s = seed(); write(s); return s; }
    function write(db) { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) {} }
    function rid(p) { var a = new Uint8Array(16); (crypto.getRandomValues ? crypto.getRandomValues(a) : a.forEach(function (_, i) { a[i] = Math.random() * 256; })); return p + Array.prototype.map.call(a, function (b) { return ("0" + b.toString(16)).slice(-2); }).join(""); }
    function res(status, body, headers) { return { status: status, headers: headers || {}, body: body === undefined ? null : body }; }
    function domainOf(email) { email = String(email || "").trim().toLowerCase(); var i = email.lastIndexOf("@"); return i > 0 ? email.slice(i + 1) : ""; }
    function bearer(h) { var a = h.Authorization || ""; return a.indexOf("Bearer ") === 0 ? a.slice(7) : ""; }
    function etag(db, e) { return '"e' + e.version + "-o" + db.orgs[e.orgId].brandVersion + '"'; }
    function log(db, orgId, t) { db.activity.unshift({ at: Date.now(), orgId: orgId, t: t }); db.activity = db.activity.slice(0, 60); }
    function cardOf(db, e) {
      var o = db.orgs[e.orgId];
      return { card: { name: e.name, title: e.title, org: e.company || o.company || o.name, office: e.office, email: e.email },
        org: { id: o.id, name: o.name, logos: JSON.parse(JSON.stringify(o.logos || {})) }, version: etag(db, e) };
    }
    function empView(db, e) {
      var devs = Object.keys(db.devices).map(function (k) { return db.devices[k]; }).filter(function (d) { return d.empId === e.id; });
      var last = devs.reduce(function (m, d) { return Math.max(m, d.lastSeen || 0); }, 0);
      return Object.assign({}, e, { devices: devs.length, lastSeen: last || null });
    }
    function orgView(db, id) {
      var o = db.orgs[id];
      return Object.assign({}, o, { domains: Object.keys(db.domains).filter(function (d) { return db.domains[d] === id; }) });
    }
    function cleanEmp(b) {
      var out = {};
      ["name", "title", "office", "email", "company"].forEach(function (k) { if (typeof b[k] === "string") out[k] = b[k].trim(); });
      if (out.email) out.email = out.email.toLowerCase();
      return out;
    }

    function route(req) {
      var db = read(), m = req.method, p = req.path.split("?")[0], b = req.body || {}, t = Date.now(), x;
      // ---- phone
      if (m === "POST" && p === "/v1/discover") {
        var oid = db.domains[String(b.domain || "").toLowerCase()], o = oid && db.orgs[oid];
        return res(200, { org: o && o.discoverable ? { name: o.name } : null });
      }
      if (m === "POST" && p === "/v1/auth/link") {
        var em = String(b.email || "").trim().toLowerCase();
        var emp = Object.keys(db.employees).map(function (k) { return db.employees[k]; }).filter(function (e) { return e.email === em && !e.removedAt; })[0];
        if (emp) {
          var tok = rid("lnk_");
          db.links[tok] = { empId: emp.id, exp: t + 15 * 60 * 1000, used: false };
          db.outbox.unshift({ to: em, token: tok, at: t }); db.outbox = db.outbox.slice(0, 20);
          write(db);
        }
        return res(202, { ok: true }); // the same answer for every address
      }
      if (m === "POST" && p === "/v1/auth/verify") {
        var L = db.links[b.token];
        if (!L || L.used || L.exp < t) return res(400, { error: "invalid_or_expired" });
        var e = db.employees[L.empId];
        if (!e || e.removedAt) return res(400, { error: "invalid_or_expired" });
        L.used = true;
        var dt = rid("dev_");
        db.devices[dt] = { empId: e.id, createdAt: t, lastSeen: t, label: (b.device && b.device.label) || "" };
        log(db, e.orgId, e.name + " signed in on a phone"); write(db);
        return res(200, { deviceToken: dt, org: { name: db.orgs[e.orgId].name } });
      }
      if ((m === "GET" && p === "/v1/card") || (m === "POST" && p === "/v1/checkin")) {
        var d = db.devices[bearer(req.headers)];
        if (!d) return res(401, { error: "signed_out" });
        var ce = db.employees[d.empId];
        if (!ce || ce.removedAt) { delete db.devices[bearer(req.headers)]; write(db); return res(410, { error: "removed" }); }
        d.lastSeen = t; write(db);
        var tag = etag(db, ce);
        if (p === "/v1/checkin") return res(200, { changed: b.version !== tag, version: tag });
        if (req.headers["If-None-Match"] === tag) return res(304, null, { etag: tag });
        return res(200, cardOf(db, ce), { etag: tag });
      }
      if (m === "POST" && p === "/v1/auth/signout") { delete db.devices[bearer(req.headers)]; write(db); return res(204); }

      // ---- admin
      if (p.indexOf("/v1/admin/") === 0) {
        var orgId = db.admins[bearer(req.headers)];
        if (!orgId) return res(401, { error: "admin_signed_out" });
        var org = db.orgs[orgId], mine = function (id) { var e2 = db.employees[id]; return e2 && e2.orgId === orgId && !e2.removedAt ? e2 : null; };
        if (m === "GET" && p === "/v1/admin/org") return res(200, orgView(db, orgId));
        if (m === "PATCH" && p === "/v1/admin/org") {
          var brand = false;
          if (typeof b.name === "string" && b.name.trim() && b.name.trim() !== org.name) { org.name = b.name.trim(); brand = true; }
          if (typeof b.company === "string" && b.company.trim() !== org.company) { org.company = b.company.trim(); brand = true; }
          if (typeof b.discoverable === "boolean") org.discoverable = b.discoverable;
          if (Array.isArray(b.domains)) {
            var want = b.domains.map(function (s) { return String(s).trim().toLowerCase().replace(/^@/, ""); }).filter(function (s) { return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s); });
            for (var i = 0; i < want.length; i++) if (db.domains[want[i]] && db.domains[want[i]] !== orgId) return res(409, { error: want[i] + " belongs to another organisation" });
            Object.keys(db.domains).forEach(function (k) { if (db.domains[k] === orgId && want.indexOf(k) < 0) delete db.domains[k]; });
            want.forEach(function (k) { db.domains[k] = orgId; });
          }
          if (brand) { org.brandVersion++; log(db, orgId, "Organisation details changed"); }
          write(db); return res(200, orgView(db, orgId));
        }
        if ((x = /^\/v1\/admin\/logos\/(horizontal|mark|light|dark)$/.exec(p))) {
          if (m === "PUT") {
            if (!/^data:image\/(svg\+xml|png|webp|jpeg);/.test(b.url || "")) return res(415, { error: "SVG or PNG please" });
            org.logos[x[1]] = { url: b.url, type: b.type, w: +b.w || 0, h: +b.h || 0, ratio: +b.ratio || 0, lum: +b.lum, trimmed: !!b.trimmed, vector: !!b.vector, at: t };
          } else if (m === "DELETE") delete org.logos[x[1]];
          else return res(405, { error: "method" });
          org.brandVersion++; log(db, orgId, m === "PUT" ? "Logo uploaded (" + x[1] + ")" : "Logo removed (" + x[1] + ")");
          write(db); return res(200, orgView(db, orgId));
        }
        if (m === "GET" && p === "/v1/admin/employees") {
          return res(200, { employees: Object.keys(db.employees).map(function (k) { return db.employees[k]; }).filter(function (e) { return e.orgId === orgId && !e.removedAt; }).map(function (e) { return empView(db, e); }) });
        }
        if (m === "POST" && p === "/v1/admin/employees") {
          var ne = cleanEmp(b);
          if (!ne.name || !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(ne.email || "")) return res(400, { error: "A name and a work email are needed" });
          if (Object.keys(db.employees).some(function (k) { var e3 = db.employees[k]; return e3.email === ne.email && !e3.removedAt; })) return res(409, { error: ne.email + " is already added" });
          var id = "emp_" + (++db.seq);
          db.employees[id] = Object.assign({ id: id, orgId: orgId, title: "", office: "", company: "", version: 1, invitedAt: null, removedAt: null, createdAt: t }, ne);
          log(db, orgId, "Added " + ne.name); write(db); return res(201, empView(db, db.employees[id]));
        }
        if ((x = /^\/v1\/admin\/employees\/([\w-]+)$/.exec(p))) {
          var ee = mine(x[1]); if (!ee) return res(404, { error: "not_found" });
          if (m === "PATCH") {
            var ch = cleanEmp(b), what = Object.keys(ch).filter(function (k) { return ch[k] !== ee[k]; });
            if (!what.length) return res(200, empView(db, ee));
            what.forEach(function (k) { ee[k] = ch[k]; }); ee.version++;
            log(db, orgId, "Changed " + ee.name + "'s " + what.join(", ")); write(db); return res(200, empView(db, ee));
          }
          if (m === "DELETE") {
            ee.removedAt = t; ee.version++;
            log(db, orgId, "Removed " + ee.name + ". Their phone drops the work card at its next check-in"); write(db); return res(204);
          }
        }
        if (m === "POST" && p === "/v1/admin/invite") {
          var n = 0;
          (b.ids || []).forEach(function (id) {
            var e4 = mine(id); if (!e4) return;
            var tk = rid("lnk_"); db.links[tk] = { empId: e4.id, exp: t + 7 * DAY, used: false };
            db.outbox.unshift({ to: e4.email, token: tk, at: t }); e4.invitedAt = t; n++;
          });
          db.outbox = db.outbox.slice(0, 40);
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
      // Prototype only, not an API route: the newest sign-in link "emailed" to an address, for the "Open my link" stand-in.
      peekOutbox: function (email) {
        var db = read(), em = String(email || "").trim().toLowerCase();
        var hit = db.outbox.filter(function (o) { return o.to === em && db.links[o.token] && !db.links[o.token].used; })[0];
        return hit ? hit.token : null;
      },
      reset: function () { localStorage.removeItem(KEY); }
    };
  })();

  Sync.request = request;
  if (!API) Sync.mockServer = MockServer;
  window.CardshareSync = Sync;
})();
