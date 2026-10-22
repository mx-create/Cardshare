// Admin console: sign-in, and "Set up Cardshare for your organisation". Runs before the console; hands it a session.
// Admins sign in with Microsoft (organisations on Microsoft 365) or with an emailed link. In the prototype no email is sent:
// "Open my link" stands in for opening it.
(function () {
  var App = window.AdminApp, Sync = App.Sync, $ = function (id) { return document.getElementById(id); };
  var KEY = "cardshare-admin-session";
  var SU = {};   // sign-up in progress: {email, signupToken, domain, sessionToken, api, microsoft}

  function views(id) {
    ["v-auth", "v-console"].forEach(function (v) { $(v).hidden = v !== id; });
    document.querySelectorAll("#v-auth > section").forEach(function (s) { s.hidden = true; });
  }
  function panel(id) { views("v-auth"); $(id).hidden = false; var f = $(id).querySelector("input:not([type=checkbox]),button"); if (f) f.focus(); scrollTo(0, 0); }
  function msg(id, t, cls) { var m = $(id); m.textContent = t || ""; m.className = "msg" + (cls ? " " + cls : ""); }
  function busy(b, on) { b.disabled = on; }
  function token() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function keep(t) { try { if (t) localStorage.setItem(KEY, t); else localStorage.removeItem(KEY); } catch (e) {} }
  function stand(id, show) { $(id).hidden = !(show && Sync.mock); }

  // ------------------------------------------------------------ sign in
  function signedIn(info) { keep(info.sessionToken || token()); App.boot(info.sessionToken || token(), info); }
  $("au-ms").addEventListener("click", function () {
    var em = $("au-email").value.trim(), b = this;
    if (!em) { msg("au-msg", "Enter your work email first, so Microsoft knows which organisation.", "err"); $("au-email").focus(); return; }
    busy(b, true); msg("au-msg", "Signing in with Microsoft…");
    Sync.adminAuth.microsoft(em).then(signedIn).catch(function (e) { msg("au-msg", e.message, "err"); }).then(function () { busy(b, false); });
  });
  $("au-link").addEventListener("click", function () {
    var em = $("au-email").value.trim().toLowerCase(), b = this;
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(em)) { msg("au-msg", "Enter your work email, like name@company.com.", "err"); return; }
    busy(b, true);
    Sync.adminAuth.requestLink(em).then(function () {
      $("as-to").textContent = em; stand("as-open", true); msg("as-msg", ""); panel("au-sent");
    }).catch(function (e) { msg("au-msg", e.message, "err"); }).then(function () { busy(b, false); });
  });
  $("au-email").addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); $("au-link").click(); } });
  $("as-open").addEventListener("click", function () {
    var tk = Sync.mockServer.peekOutbox($("as-to").textContent, "admin");
    if (!tk) { msg("as-msg", "Prototype: no link went to that address, because it isn't an admin on Cardshare. For real, the email simply never arrives.", "warn"); return; }
    Sync.adminAuth.verify(tk).then(signedIn).catch(function (e) { msg("as-msg", e.message, "err"); });
  });
  $("as-back").addEventListener("click", function () { panel("au-signin"); });
  document.querySelectorAll("[data-demo]").forEach(function (b) { b.addEventListener("click", function () { $("au-email").value = b.dataset.demo; msg("au-msg", ""); }); });
  $("au-new").addEventListener("click", function () { SU = {}; $("su-email").value = ""; msg("su1-msg", ""); step(1); });
  $("su-cancel").addEventListener("click", function () { panel("au-signin"); });

  // ------------------------------------------------------------ sign up
  var STEPS = ["Work email", "Verify", "Name", "Domain", "Cards from", "Branding"];
  function step(n) {
    panel("au-signup");
    $("su-steps").innerHTML = STEPS.map(function (s, i) { return '<li class="' + (i + 1 < n ? "done" : i + 1 === n ? "now" : "") + '"><i>' + (i + 1 < n ? "&#10003;" : i + 1) + '</i>' + s + '</li>'; }).join("");
    for (var i = 1; i <= 6; i++) $("su-" + i).hidden = i !== n;
    var f = $("su-" + n).querySelector("input,button"); if (f) f.focus();
  }
  $("su-start").addEventListener("click", function () {
    var em = $("su-email").value.trim().toLowerCase(), b = this; busy(b, true);
    Sync.signup.start(em).then(function () { SU.email = em; $("su-to").textContent = em; stand("su-open", true); msg("su2-msg", ""); step(2); })
      .catch(function (e) { msg("su1-msg", e.message, "err"); }).then(function () { busy(b, false); });
  });
  $("su-email").addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); $("su-start").click(); } });
  $("su-resend").addEventListener("click", function () { Sync.signup.start(SU.email).then(function () { msg("su2-msg", "Sent again.", "ok"); }); });
  $("su-open").addEventListener("click", function () {
    var tk = Sync.mockServer.peekOutbox(SU.email, "signup");
    if (!tk) { msg("su2-msg", "No link found. Send it again.", "err"); return; }
    Sync.signup.verify(tk).then(function (r) {
      SU.signupToken = r.signupToken; SU.domain = r.domain; SU.microsoft = r.microsoft;
      if (r.taken) { msg("su3-msg", r.domain + " already uses Cardshare (" + r.taken + "). Ask its owner to add you as an admin, then sign in.", "err"); $("su-create").disabled = true; }
      else { msg("su3-msg", ""); $("su-create").disabled = false; }
      var base = r.domain.split(".")[0]; $("su-name").value = base.charAt(0).toUpperCase() + base.slice(1);
      $("su-dom").textContent = r.domain; step(3);
    }).catch(function (e) { msg("su2-msg", e.message, "err"); });
  });
  $("su-create").addEventListener("click", function () {
    var b = this; busy(b, true);
    Sync.signup.createOrg(SU.signupToken, $("su-name").value).then(function (info) {
      SU.sessionToken = info.sessionToken; SU.info = info; SU.api = Sync.admin(info.sessionToken); keep(info.sessionToken);
      return SU.api.org();
    }).then(function (o) { SU.org = o; paintDomainStep(); step(4); })
      .catch(function (e) { msg("su3-msg", e.message, "err"); }).then(function () { busy(b, false); });
  });

  // Domain ownership: Microsoft (counts as verification), a DNS TXT record, or an email to admin@<domain>.
  function paintDomainStep() {
    var d = SU.org.domainStatus.filter(function (x) { return x.name === SU.domain; })[0] || SU.org.domainStatus[0];
    SU.dstat = d;
    $("su-d4").textContent = d.name;
    App.domainPanel($("su-dpanel"), d, SU.api, { microsoft: true, onVerified: function (o, how) {
      SU.org = o; msg("su4-msg", d.name + " verified" + (how === "microsoft" ? " by connecting Microsoft 365." : "."), "ok");
      $("su-next4").textContent = "Continue";
      if (how === "microsoft") { SU.source = "microsoft"; }
    } });
    $("su-next4").textContent = d.verified ? "Continue" : "Skip for now";
  }
  $("su-next4").addEventListener("click", function () {
    SU.api.org().then(function (o) {
      SU.org = o; var ms = o.source === "microsoft";
      $("su-ms-done").hidden = !ms; $("su-ms-go").hidden = ms;
      document.querySelectorAll("[data-susrc]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.susrc === (ms ? "microsoft" : SU.source || ""))); });
      step(5);
    });
  });
  document.querySelectorAll("[data-susrc]").forEach(function (b) { b.addEventListener("click", function () {
    if (SU.org.source === "microsoft" && b.dataset.susrc === "manual") { msg("su5-msg", "Already connected to Microsoft 365. You can disconnect later in the console.", "warn"); return; }
    SU.source = b.dataset.susrc; document.querySelectorAll("[data-susrc]").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); }); msg("su5-msg", "");
  }); });
  $("su-ms-go").addEventListener("click", function () {
    App.consent(SU.info.admin.email).then(function (ok) {
      if (!ok) return;
      return SU.api.connectMicrosoft({ consent: true }).then(function (o) { SU.org = o; SU.source = "microsoft"; $("su-ms-done").hidden = false; $("su-ms-go").hidden = true;
        document.querySelectorAll("[data-susrc]").forEach(function (x) { x.setAttribute("aria-pressed", String(x.dataset.susrc === "microsoft")); }); msg("su5-msg", "Connected: " + o.ms.tenantName + ", " + o.ms.peopleFound + " people found.", "ok"); });
    }).catch(function (e) { msg("su5-msg", e.message, "err"); });
  });
  $("su-next5").addEventListener("click", function () {
    if (!SU.source) { msg("su5-msg", "Pick where work cards come from.", "err"); return; }
    if (SU.source === "microsoft" && SU.org.source !== "microsoft") { msg("su5-msg", "Connect Microsoft 365 first, or choose By hand.", "err"); return; }
    var B = window.CardshareBrand;
    $("su-presets").innerHTML = B.PRESETS.map(function (p) {
      return '<button type="button" class="br-preset" data-supreset="' + p.id + '"><i style="background:' + p.light.card + '"><b style="background:' + p.light.primary + '"></b><b style="background:' + p.light.accent + '"></b></i>' + p.n + '</button>';
    }).join("");
    step(6);
  });
  $("su-presets").addEventListener("click", function (e) {
    var b = e.target.closest("[data-supreset]"); if (!b) return;
    var B = window.CardshareBrand, p = B.PRESETS.filter(function (x) { return x.id === b.dataset.supreset; })[0];
    SU.api.putBranding(B.clean({ light: p.light })).then(function () {
      document.querySelectorAll("[data-supreset]").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); }); msg("su6-msg", p.n + " applied. Fine-tune it in the console.", "ok");
    }).catch(function (e2) { msg("su6-msg", e2.message, "err"); });
  });
  $("su-finish").addEventListener("click", function () { App.boot(SU.sessionToken, SU.info, "branding"); });

  // ------------------------------------------------------------ start
  App.signOut = function () { var t = token(); keep(null); if (t) Sync.admin(t).signOut().catch(function () {}); $("au-email").value = ""; msg("au-msg", ""); panel("au-signin"); };
  var t = token();
  if (!t) { panel("au-signin"); return; }
  Sync.admin(t).me().then(function (info) { App.boot(t, info); }).catch(function () { keep(null); panel("au-signin"); });
})();
