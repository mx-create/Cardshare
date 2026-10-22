// Admin console: the Branding card. Edits an organisation's branding (see ../brand.js) with a live preview: the real app,
// in two small phone frames (My card → Work, and Share → Work), running in ?preview mode with the draft posted to it.
// Nothing reaches phones until "Save branding"; phones then get it with the card at their next check-in.
(function () {
  var B = window.CardshareBrand, App, $ = function (id) { return document.getElementById(id); };
  var LABELS = { primary: ["Primary", "Work pill and main button"], accent: ["Accent", "Banner and highlights"], card: ["Card background", "Header band and card panel"],
    text: ["Text", "Text on the card"], buttonText: ["Button text", "Text on the primary colour"] };
  var D = { draft: null, saved: "", mode: "light", theme: "daylight", slot: "primary", swatches: [], ready: {} };

  function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function copy(o) { return JSON.parse(JSON.stringify(o)); }
  function set(mode) { return mode === "light" ? D.draft.light : (D.draft.darkAuto ? B.darkFrom(D.draft.light) : D.draft.dark); }
  function rgbText(h) { return B.rgb(h).join(", "); }
  function hslText(h) { var x = B.hsl(h); return x[0] + ", " + x[1] + "%, " + x[2] + "%"; }
  function dirty() { return JSON.stringify(B.clean(D.draft)) !== D.saved; }

  // Editing the dark set by hand stops it being generated (the generated values become the starting point).
  function put(mode, k, v) {
    if (mode === "dark" && D.draft.darkAuto) { D.draft.dark = B.darkFrom(D.draft.light); D.draft.darkAuto = false; }
    (mode === "light" ? D.draft.light : D.draft.dark)[k] = v;
  }

  function markup() {
    return '<h3>Branding <span class="grow"></span><span class="msg" id="br-dirty"></span></h3>' +
      '<p class="muted small" style="margin:-6px 0 12px">Make the Work card your company card: the header band, card panel, Work pill, buttons and "Managed by" banner. Personal and Links keep the Cardshare look, the QR always stays black on white, and "work card · via cardshare" stays.</p>' +
      '<div class="br-grid"><div class="br-ctl">' +
        '<div class="br-quick"><span class="muted small">Quick start:</span>' +
          '<button class="btn" type="button" id="br-fromlogo">Pick colours from logo</button>' +
          '<button class="btn ms" type="button" id="br-ms" hidden><svg viewBox="0 0 21 21" aria-hidden="true"><path fill="#f25022" d="M1 1h9v9H1z"/><path fill="#7fba00" d="M11 1h9v9h-9z"/><path fill="#00a4ef" d="M1 11h9v9H1z"/><path fill="#ffb900" d="M11 11h9v9h-9z"/></svg>Use Microsoft 365 branding</button></div>' +
        '<div class="br-presets" id="br-presets"></div>' +
        '<div class="br-sw" id="br-sw" hidden></div>' +
        '<div class="br-modes"><div class="seg2" role="tablist" aria-label="Colours for">' +
          '<button type="button" role="tab" data-brmode="light">Light theme</button><button type="button" role="tab" data-brmode="dark">Dark theme</button></div>' +
          '<label class="check small"><input type="checkbox" id="br-auto"> Generate dark from light</label></div>' +
        '<div class="br-rows" id="br-rows"></div>' +
        '<div class="br-checks" id="br-checks" aria-live="polite"></div>' +
        '<div class="br-opts">' +
          opt("radius", "Corners", [["sharp", "Sharp"], ["soft", "Soft"], ["round", "Round"]]) +
          opt("cardStyle", "Card background", [["brand", "Brand colour"], ["light", "Light"], ["dark", "Dark"]]) +
          opt("logoPlace", "Header logo", [["centre", "Centre"], ["left", "Left"]]) +
          '<div class="br-opt"><label for="br-font">Font</label><select class="inp" id="br-font">' +
            Object.keys(B.FONTS).map(function (k) { return '<option value="' + k + '">' + esc(B.FONTS[k].n) + '</option>'; }).join("") + '</select></div>' +
        '</div>' +
        '<div class="row" style="margin-top:14px"><button class="btn primary" type="button" id="br-save">Save branding</button>' +
          '<button class="ghost" type="button" id="br-reset">Reset to the Cardshare look</button><span class="msg" id="br-msg"></span></div>' +
      '</div><div class="br-pv">' +
        '<div class="seg2" role="tablist" aria-label="Preview on"><button type="button" data-brtheme="daylight">Light theme</button><button type="button" data-brtheme="midnight">Dark theme</button></div>' +
        '<div class="br-frames"><figure><div class="pvf"><iframe id="br-f-edit" title="Preview: My card, Work" tabindex="-1" src="../?preview=edit"></iframe></div><figcaption>My card</figcaption></figure>' +
        '<figure><div class="pvf"><iframe id="br-f-share" title="Preview: Share, Work" tabindex="-1" src="../?preview=share"></iframe></div><figcaption>Share</figcaption></figure></div>' +
        '<p class="muted small">Live preview with a sample person. Phones get the saved branding with the card at their next check-in, and keep it for offline use.</p>' +
      '</div></div>';
  }
  function opt(k, label, list) {
    return '<div class="br-opt"><span>' + label + '</span><div class="seg2 small" role="group" aria-label="' + label + '">' +
      list.map(function (x) { return '<button type="button" data-bropt="' + k + '" data-v="' + x[0] + '">' + x[1] + '</button>'; }).join("") + '</div></div>';
  }

  function paintRows() {
    var s = set(D.mode);
    $("br-rows").innerHTML = B.KEYS.map(function (k) {
      var v = s[k];
      return '<div class="br-row' + (D.slot === k ? " on" : "") + '" data-slot="' + k + '"><div class="br-l"><b>' + LABELS[k][0] + '</b><small>' + LABELS[k][1] + '</small></div>' +
        '<input type="color" value="' + v.toLowerCase() + '" data-k="' + k + '" data-f="pick" aria-label="' + LABELS[k][0] + ' colour">' +
        '<input class="inp mono" value="' + v + '" data-k="' + k + '" data-f="hex" aria-label="' + LABELS[k][0] + ' hex" spellcheck="false" maxlength="7">' +
        '<input class="inp mono sm" value="' + rgbText(v) + '" data-k="' + k + '" data-f="rgb" aria-label="' + LABELS[k][0] + ' RGB" title="RGB, like 31, 58, 95">' +
        '<input class="inp mono sm" value="' + hslText(v) + '" data-k="' + k + '" data-f="hsl" aria-label="' + LABELS[k][0] + ' HSL" title="HSL, like 212, 50%, 25%"></div>';
    }).join("");
  }
  function syncRow(k, except) {
    var v = set(D.mode)[k], row = document.querySelector('.br-row[data-slot="' + k + '"]'); if (!row) return;
    row.querySelectorAll("input").forEach(function (i) {
      if (i === except) return;
      i.classList.remove("bad");
      i.value = i.dataset.f === "pick" ? v.toLowerCase() : i.dataset.f === "hex" ? v : i.dataset.f === "rgb" ? rgbText(v) : hslText(v);
    });
  }
  function paintChecks() {
    var html = "";
    ["light", "dark"].forEach(function (mode) {
      B.checks(D.draft, mode === "dark").forEach(function (c) {
        html += '<div class="br-chk ' + (c.ok ? "ok" : "bad") + '"><span class="dot" style="background:' + c.bg + ';color:' + c.fg + '">Aa</span>' +
          '<span><b>' + (mode === "light" ? "Light" : "Dark") + ': ' + c.label + '</b> ' + c.ratio.toFixed(1) + ':1 ' + (c.ok ? "passes" : "is below 4.5:1") +
          (c.auto ? ' <small>(text picked for the ' + D.draft.cardStyle + ' card)</small>' : "") + '</span>' +
          (c.ok ? "" : '<button type="button" class="btn sm" data-fix="' + mode + ':' + c.k + ':' + c.fix + '">Use nearest passing shade <i style="background:' + c.fix + '"></i>' + c.fix + '</button>') + '</div>';
      });
    });
    var bad = ["light", "dark"].some(function (m) { return B.checks(D.draft, m === "dark").some(function (c) { return !c.ok; }); });
    $("br-checks").innerHTML = html + (bad ? '<p class="muted small" style="margin:6px 0 0">You can save anyway: phones will use the nearest passing shade so the card stays readable.</p>' : "");
  }
  function paintOpts() {
    document.querySelectorAll("[data-bropt]").forEach(function (b) { b.setAttribute("aria-pressed", String(D.draft[b.dataset.bropt] === b.dataset.v)); });
    $("br-font").value = D.draft.font;
    document.querySelectorAll("[data-brmode]").forEach(function (b) { b.setAttribute("aria-selected", String(b.dataset.brmode === D.mode)); });
    document.querySelectorAll("[data-brtheme]").forEach(function (b) { b.setAttribute("aria-selected", String(b.dataset.brtheme === D.theme)); });
    $("br-auto").checked = !!D.draft.darkAuto;
    $("br-presets").innerHTML = B.PRESETS.map(function (p) {
      return '<button type="button" class="br-preset" data-preset="' + p.id + '" title="' + esc(p.n) + '"><i style="background:' + p.light.card + '"><b style="background:' + p.light.primary + '"></b><b style="background:' + p.light.accent + '"></b></i>' + esc(p.n) + '</button>';
    }).join("");
    var org = App.state.org;
    $("br-ms").hidden = !(org && org.source === "microsoft" && org.ms);
    $("br-fromlogo").disabled = !logoURL();
  }
  function paintSwatches() {
    $("br-sw").hidden = !D.swatches.length;
    $("br-sw").innerHTML = '<span class="muted small">Click a colour to use it as <b>' + LABELS[D.slot][0] + '</b>:</span>' +
      D.swatches.map(function (h) { return '<button type="button" class="sw" data-sw="' + h + '" style="background:' + h + '" title="' + h + '" aria-label="' + h + '"></button>'; }).join("") +
      '<button type="button" class="btn sm" id="br-usesw">Make a palette from these</button>';
  }
  function paintDirty() { var d = dirty(); $("br-dirty").textContent = d ? "Unsaved changes" : "Saved"; $("br-dirty").className = "msg " + (d ? "warn" : "ok"); }
  function paintAll() { paintRows(); paintChecks(); paintOpts(); paintSwatches(); paintDirty(); preview(); }

  // ------------------------------------------------------------ preview
  var pvT;
  function preview() {
    clearTimeout(pvT);
    pvT = setTimeout(function () {
      var org = App.state.org; if (!org) return;
      var msg = { type: "cardshare-preview", theme: D.theme, tel: "+447700900123", card: App.sampleCard(),
        org: { id: org.id, name: org.name, logos: org.logos || {}, branding: B.clean(D.draft) } };
      ["edit", "share"].forEach(function (v) { var f = $("br-f-" + v); if (f && f.contentWindow && D.ready[v]) f.contentWindow.postMessage(msg, location.origin); });
    }, 40);
  }
  addEventListener("message", function (e) {
    if (e.origin !== location.origin || !e.data || e.data.type !== "cardshare-preview-ready") return;
    D.ready[e.data.view] = true; preview();
  });

  function logoURL() { var L = (App.state.org && App.state.org.logos) || {}; var l = L.horizontal || L.mark || L.light || L.dark || L.markLight; return l && l.url; }

  function wire() {
    var card = $("branding");
    card.addEventListener("focusin", function (e) { var r = e.target.closest(".br-row"); if (r && D.slot !== r.dataset.slot) { D.slot = r.dataset.slot; document.querySelectorAll(".br-row").forEach(function (x) { x.classList.toggle("on", x === r); }); paintSwatches(); } });
    card.addEventListener("click", function (e) {
      var t = e.target.closest("button,.br-row"); if (!t) return;
      if (t.classList.contains("br-row")) { D.slot = t.dataset.slot; document.querySelectorAll(".br-row").forEach(function (x) { x.classList.toggle("on", x === t); }); paintSwatches(); return; }
      if (t.dataset.brmode) { D.mode = t.dataset.brmode; D.theme = D.mode === "light" ? "daylight" : "midnight"; paintAll(); return; }
      if (t.dataset.brtheme) { D.theme = t.dataset.brtheme; paintOpts(); preview(); return; }
      if (t.dataset.bropt) { D.draft[t.dataset.bropt] = t.dataset.v; paintChecks(); paintOpts(); paintDirty(); preview(); return; }
      if (t.dataset.preset) { var p = B.PRESETS.filter(function (x) { return x.id === t.dataset.preset; })[0]; D.draft.light = copy(p.light); D.draft.darkAuto = true; D.draft.dark = null; paintAll(); return; }
      if (t.dataset.fix) { var f = t.dataset.fix.split(":"); put(f[0], f[1], f[2]); if (f[0] !== D.mode) D.mode = f[0]; paintAll(); return; }
      if (t.dataset.sw) { put(D.mode, D.slot, t.dataset.sw); syncRow(D.slot); paintChecks(); paintDirty(); preview(); return; }
      if (t.id === "br-usesw") { D.draft.light = B.fromColours(D.swatches); D.draft.darkAuto = true; D.draft.dark = null; D.mode = "light"; paintAll(); return; }
      if (t.id === "br-fromlogo") {
        var u = logoURL(); if (!u) { App.toast("Upload a logo first."); return; }
        B.extract(u, 6).then(function (cols) { D.swatches = cols; paintSwatches(); App.toast("Found " + cols.length + " colours in your logo."); }).catch(function () { App.toast("Couldn't read colours from that logo."); });
        return;
      }
      if (t.id === "br-ms") {
        App.api().microsoftBranding().then(function (br) {
          var bg = B.hex(br.backgroundColor);
          if (!bg) { App.toast("No background colour is set on your Microsoft 365 sign-in page."); return; }
          put("light", "primary", bg); put("light", "buttonText", B.bestOn(bg));
          if (D.swatches.indexOf(bg) < 0) D.swatches.unshift(bg);
          D.mode = "light"; paintAll(); App.toast("Primary set to your Microsoft 365 sign-in colour, " + bg + ".");
        }).catch(App.fail);
        return;
      }
      if (t.id === "br-save") {
        var bad = [];
        ["light", "dark"].forEach(function (m) { B.checks(D.draft, m === "dark").forEach(function (c) { if (!c.ok) bad.push((m === "light" ? "light " : "dark ") + c.label.toLowerCase()); }); });
        $("br-msg").className = "msg"; $("br-msg").textContent = "Saving…";
        App.api().putBranding(B.clean(D.draft)).then(function (o) {
          App.state.org = o; D.saved = JSON.stringify(B.clean(D.draft)); paintDirty();
          $("br-msg").className = "msg " + (bad.length ? "warn" : "ok");
          $("br-msg").textContent = bad.length ? "Saved. Below 4.5:1, so phones use the nearest passing shade for: " + bad.join(", ") + "." : "Saved. Phones pick it up at their next check-in.";
          App.refreshLog();
        }).catch(function (e) { $("br-msg").className = "msg err"; $("br-msg").textContent = e.message; });
        return;
      }
      if (t.id === "br-reset") {
        if (t.dataset.armed !== "1") { t.dataset.armed = "1"; t.textContent = "Click again to reset"; setTimeout(function () { t.dataset.armed = ""; t.textContent = "Reset to the Cardshare look"; }, 4000); return; }
        App.api().putBranding({ reset: true }).then(function (o) { App.state.org = o; load(o); App.refreshLog(); App.toast("Branding reset. Phones go back to the Cardshare look at their next check-in."); }).catch(App.fail);
      }
    });
    card.addEventListener("input", function (e) {
      var i = e.target, k = i.dataset.k;
      if (i.id === "br-font") { D.draft.font = i.value; paintDirty(); preview(); return; }
      if (!k) return;
      var v = i.dataset.f === "pick" ? B.hex(i.value) : i.dataset.f === "hex" ? B.hex(i.value) : i.dataset.f === "rgb" ? B.parse("rgb(" + i.value + ")") : B.parse("hsl(" + i.value + ")");
      i.classList.toggle("bad", !v && i.dataset.f !== "pick");
      if (!v) return;
      put(D.mode, k, v); syncRow(k, i); paintChecks(); paintDirty(); preview();
      if (D.mode === "dark") $("br-auto").checked = false;
      else if (D.draft.darkAuto) { /* the dark set follows */ }
    });
    card.addEventListener("change", function (e) {
      if (e.target.id === "br-font") { D.draft.font = e.target.value; paintDirty(); preview(); }
      if (e.target.id === "br-auto") {
        if (e.target.checked) { D.draft.darkAuto = true; D.draft.dark = null; } else { D.draft.dark = B.darkFrom(D.draft.light); D.draft.darkAuto = false; }
        paintAll();
      }
    });
  }

  function load(org) {
    D.draft = B.clean(org && org.branding ? org.branding : B.DEFAULT);
    if (!D.draft.dark) D.draft.dark = null;
    D.saved = org && org.branding ? JSON.stringify(B.clean(org.branding)) : "";
    D.swatches = []; D.mode = "light"; D.theme = "daylight";
    if (!$("br-rows")) return;
    paintAll();
    if (!(org && org.branding)) { $("br-dirty").textContent = "Not set: phones show the Cardshare look"; $("br-dirty").className = "msg"; }
  }

  window.AdminBranding = {
    mount: function (app) { App = app; $("branding").innerHTML = markup(); wire(); },
    load: load,
    refresh: function () { if (D.draft) { paintOpts(); preview(); } },
    draft: function () { return D.draft; }
  };
})();
