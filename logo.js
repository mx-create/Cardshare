// Cardshare v2: company logos. One slot, 200 × 40, any shape (docs/v2-design/LogoRules.dc.html).
// prepare() runs in the admin console on upload; render() runs on the phone and in the console's preview.
//
//  - Wide wordmark: fits to width. Tall or stacked: fits to height. Never stretched or cropped (object-fit: contain),
//    and a bitmap is never shown bigger than its own pixels.
//  - Square mark only: capped at 36 × 36, with the company name beside it.
//  - Too little contrast with the screen and no version for it: the logo sits on a chip (light chip on dark themes).
//  - No logo: an initials badge and the company name, so the header is never empty.
//  - The QR is never touched: branding is header only.
(function () {
  var SLOT_W = 200, SLOT_H = 40, MARK = 36, CHIP_PAD = 10;

  var css = "" +
    ".cologo{display:flex;flex-direction:column;align-items:center;gap:5px;min-width:0}" +
    ".cologo-slot{width:" + SLOT_W + "px;height:" + SLOT_H + "px;max-width:100%;display:flex;align-items:center;justify-content:center;gap:10px;min-width:0}" +
    ".cologo-slot img{display:block;object-fit:contain;max-width:100%;max-height:100%}" +
    ".cologo-chip{display:flex;align-items:center;justify-content:center;gap:8px;height:" + (SLOT_H - 4) + "px;max-width:100%;padding:0 " + CHIP_PAD + "px;border-radius:9px;background:#f7f1ec;color:#201917}" +
    ".cologo-chip.dark{background:#201917;color:#f7f1ec}" +
    ".cologo-name{font:700 17px/1.1 var(--body,system-ui,sans-serif);color:var(--ink,#f3ece8);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;letter-spacing:-.01em}" +
    ".cologo-chip .cologo-name{color:inherit}" +
    ".cologo-badge{flex:none;width:" + MARK + "px;height:" + MARK + "px;border-radius:50%;background:var(--teams,#7366e8);color:#fff;display:flex;align-items:center;justify-content:center;font:700 14px var(--body,system-ui,sans-serif)}" +
    ".cologo small{font-size:11px;line-height:1;color:var(--ink-dim,#a99c95);letter-spacing:.02em}" +
    ".cologo small b{color:var(--teams-hi,#a79df5);font-weight:600}" +
    ".cologo-slot.outline{outline:1px dashed var(--line,#6a5a52);outline-offset:0;border-radius:6px}";
  function injectCSS() {
    if (document.getElementById("cologo-css")) return;
    var s = document.createElement("style"); s.id = "cologo-css"; s.textContent = css; document.head.appendChild(s);
  }

  // ------------------------------------------------------------- colour helpers
  function lin(c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function lumRGB(r, g, b) { return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); }
  function contrast(a, b) { var hi = Math.max(a, b), lo = Math.min(a, b); return (hi + 0.05) / (lo + 0.05); }
  function cssLum(col) {
    var m = /#([0-9a-f]{6})/i.exec(col || "");
    if (m) { var n = parseInt(m[1], 16); return lumRGB(n >> 16, (n >> 8) & 255, n & 255); }
    m = /rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/.exec(col || "");
    return m ? lumRGB(+m[1], +m[2], +m[3]) : 0.02;
  }
  function groundLum() { return cssLum(getComputedStyle(document.documentElement).getPropertyValue("--ground").trim() || getComputedStyle(document.body).backgroundColor); }

  function initials(n) { var w = String(n || "").replace(/&/g, " ").split(/\s+/).filter(Boolean); return (((w[0] || "")[0] || "") + ((w[1] || "")[0] || "")).toUpperCase() || "?"; }

  // ------------------------------------------------------------- choose and size
  // org: {name, logos:{horizontal, mark, markLight, light, dark}}; markLight = a square mark for dark screens (Microsoft's squareLogoDark).
  // org: {name, logos:{horizontal, mark, light, dark}}; each logo {url, w, h, ratio, lum, vector}.
  // light = a light-coloured version for dark screens, dark = a dark-coloured version for light screens.
  function layout(org, gl) {
    var L = (org && org.logos) || {}, darkScreen = gl < 0.25;
    var wide = darkScreen ? (L.light || L.horizontal || L.dark) : (L.dark || L.horizontal || L.light);
    var out = { kind: "none", name: (org && org.name) || "", warnings: [] };
    if (wide) {
      var r = wide.ratio || 1;
      out.logo = wide; out.kind = r >= 0.8 && r <= 1.25 ? "mark" : r >= 2.5 ? "wide" : "stacked";
    } else if (L.mark || L.markLight) { out.kind = "mark"; out.logo = darkScreen ? (L.markLight || L.mark) : (L.mark || L.markLight); }
    if (!out.logo) return out;
    var lg = out.logo, w = lg.w || 1, h = lg.h || 1, cap = lg.vector ? Infinity : 1;
    var boxW = out.kind === "mark" ? MARK : SLOT_W, boxH = out.kind === "mark" ? MARK : SLOT_H;
    out.chip = typeof lg.lum === "number" && !isNaN(lg.lum) && contrast(lg.lum, gl) < (out.kind === "mark" ? 1.5 : 2.2); // a square mark usually carries its own solid shape
    if (out.chip && out.kind !== "mark") { boxW -= CHIP_PAD * 2; boxH = SLOT_H - 4 - 6; }
    var s = Math.min(boxW / w, boxH / h, cap);
    out.dw = Math.max(1, Math.round(w * s)); out.dh = Math.max(1, Math.round(h * s));
    out.fit = out.kind === "mark" ? "36 × 36 cap" : (boxW / w < boxH / h ? "fit to width" : "fit to height");
    if (s === 1 && !lg.vector && (out.dw < boxW && out.dh < boxH)) out.fit = "original size (not upscaled)";
    if (out.kind === "stacked" && lg.ratio < 1.6) out.warnings.push("Stacked logo: its text may show under 10px. Upload a horizontal version if you have one.");
    return out;
  }

  // Returns an element: the slot plus "work card · via cardshare". opts: {outline, noVia, ground (luminance)}.
  function render(org, opts) {
    injectCSS(); opts = opts || {};
    var gl = typeof opts.ground === "number" ? opts.ground : groundLum(), lay = layout(org, gl);
    var wrap = document.createElement("div"); wrap.className = "cologo"; wrap.setAttribute("role", "img");
    wrap.setAttribute("aria-label", (lay.name || "Company") + " logo. Work card via Cardshare");
    var slot = document.createElement("span"); slot.className = "cologo-slot" + (opts.outline ? " outline" : "");
    var host = slot;
    if (lay.chip) { host = document.createElement("span"); host.className = "cologo-chip" + (gl < 0.25 ? "" : " dark"); slot.appendChild(host); }
    if (lay.logo) {
      var img = document.createElement("img"); img.alt = ""; img.src = lay.logo.url; img.width = lay.dw; img.height = lay.dh;
      img.style.width = lay.dw + "px"; img.style.height = lay.dh + "px"; img.decoding = "async";
      host.appendChild(img);
    } else {
      var b = document.createElement("span"); b.className = "cologo-badge"; b.textContent = initials(lay.name); host.appendChild(b);
    }
    if (lay.kind === "mark" || lay.kind === "none") {
      var n = document.createElement("span"); n.className = "cologo-name"; n.textContent = lay.name; host.appendChild(n);
    }
    wrap.appendChild(slot);
    if (!opts.noVia) { var sm = document.createElement("small"); sm.innerHTML = "work card · via <b>cardshare</b>"; wrap.appendChild(sm); }
    wrap.layout = lay;
    return wrap;
  }

  // ------------------------------------------------------------- upload: trim, measure, store aspect ratio
  function readAs(file, how) { return new Promise(function (ok, fail) { var r = new FileReader(); r.onload = function () { ok(r.result); }; r.onerror = fail; r[how](file); }); }
  function loadImg(src) { return new Promise(function (ok, fail) { var i = new Image(); i.onload = function () { ok(i); }; i.onerror = function () { fail(new Error("That file could not be read as an image.")); }; i.src = src; }); }
  function b64(s) { return btoa(unescape(encodeURIComponent(s))); }

  // Bounding box of the visible pixels and their average luminance.
  function scan(img, W, H) {
    var c = document.createElement("canvas"); c.width = W; c.height = H;
    var x = c.getContext("2d"); x.drawImage(img, 0, 0, W, H);
    var d; try { d = x.getImageData(0, 0, W, H).data; } catch (e) { return { box: { x: 0, y: 0, w: W, h: H }, lum: NaN, canvas: c }; }
    var x0 = W, y0 = H, x1 = -1, y1 = -1, sum = 0, wt = 0, opaque = true;
    for (var y = 0; y < H; y++) for (var i = 0; i < W; i++) {
      var k = (y * W + i) * 4, a = d[k + 3];
      if (a < 250) opaque = false;
      if (a > 10) { if (i < x0) x0 = i; if (i > x1) x1 = i; if (y < y0) y0 = y; if (y > y1) y1 = y; sum += lumRGB(d[k], d[k + 1], d[k + 2]) * a; wt += a; }
    }
    if (x1 < 0) return { box: { x: 0, y: 0, w: W, h: H }, lum: NaN, canvas: c, empty: true };
    return { box: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }, lum: sum / wt, canvas: c, opaque: opaque };
  }

  function prepare(file) {
    var type = file.type || (/\.svg$/i.test(file.name) ? "image/svg+xml" : "");
    if (!/^image\/(svg\+xml|png|webp|jpeg)$/.test(type)) return Promise.reject(new Error("Upload an SVG (best) or a PNG."));
    if (file.size > 2 * 1024 * 1024) return Promise.reject(new Error("That file is over 2 MB. Export a smaller SVG or PNG."));
    return type === "image/svg+xml" ? prepareSVG(file) : prepareBitmap(file, type);
  }

  function prepareSVG(file) {
    return readAs(file, "readAsText").then(function (text) {
      var doc = new DOMParser().parseFromString(text, "image/svg+xml"), svg = doc.documentElement;
      if (!svg || svg.nodeName.toLowerCase() !== "svg" || doc.getElementsByTagName("parsererror").length) throw new Error("That SVG could not be read.");
      // An <img> never runs SVG scripts, but they are dropped anyway so the stored file is inert.
      Array.prototype.slice.call(svg.querySelectorAll("script,foreignObject")).forEach(function (n) { n.remove(); });
      Array.prototype.slice.call(svg.querySelectorAll("*")).concat([svg]).forEach(function (n) {
        Array.prototype.slice.call(n.attributes).forEach(function (a) { if (/^on/i.test(a.name) || /javascript:/i.test(a.value)) n.removeAttribute(a.name); });
      });
      var vb = (svg.getAttribute("viewBox") || "").split(/[\s,]+/).map(Number);
      var w = parseFloat(svg.getAttribute("width")) || 0, h = parseFloat(svg.getAttribute("height")) || 0;
      if (vb.length !== 4 || vb.some(isNaN)) vb = [0, 0, w || 300, h || 100];
      svg.setAttribute("viewBox", vb.join(" "));
      var scale = 800 / Math.max(vb[2], vb[3]), W = Math.max(1, Math.round(vb[2] * scale)), H = Math.max(1, Math.round(vb[3] * scale));
      svg.setAttribute("width", W); svg.setAttribute("height", H); svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
      var src = "data:image/svg+xml;base64," + b64(new XMLSerializer().serializeToString(svg));
      return loadImg(src).then(function (img) {
        var s = scan(img, W, H), b = s.box, trimmed = b.w < W - 1 || b.h < H - 1;
        if (s.empty) throw new Error("That SVG looks empty.");
        var nvb = [vb[0] + b.x / scale, vb[1] + b.y / scale, b.w / scale, b.h / scale].map(function (v) { return Math.round(v * 1000) / 1000; });
        svg.setAttribute("viewBox", nvb.join(" "));
        // Displayed size comes from the slot; keep a nominal 400px-wide intrinsic size for the aspect ratio.
        var iw = 400, ih = Math.max(1, Math.round(400 * nvb[3] / nvb[2]));
        svg.setAttribute("width", iw); svg.setAttribute("height", ih);
        return { url: "data:image/svg+xml;base64," + b64(new XMLSerializer().serializeToString(svg)), type: "image/svg+xml", w: iw, h: ih,
          ratio: Math.round(nvb[2] / nvb[3] * 1000) / 1000, lum: Math.round(s.lum * 1000) / 1000, trimmed: trimmed, vector: true, warnings: [] };
      });
    });
  }

  function prepareBitmap(file, type) {
    return readAs(file, "readAsDataURL").then(loadImg).then(function (img) {
      var W = img.naturalWidth, H = img.naturalHeight, s = scan(img, W, H), b = s.box, warnings = [];
      if (s.empty) throw new Error("That image is fully transparent.");
      if (W < 400) warnings.push("This PNG is " + W + "px wide. 400px or more stays sharp on every phone; SVG is best.");
      if (s.opaque && type !== "image/png") warnings.push("No transparency, so the background shows as a box. A PNG with a transparent background or an SVG looks better.");
      var max = 800, k = Math.min(1, max / b.w), cw = Math.max(1, Math.round(b.w * k)), ch = Math.max(1, Math.round(b.h * k));
      var c = document.createElement("canvas"); c.width = cw; c.height = ch;
      c.getContext("2d").drawImage(s.canvas, b.x, b.y, b.w, b.h, 0, 0, cw, ch);
      return { url: c.toDataURL("image/png"), type: "image/png", w: cw, h: ch, ratio: Math.round(cw / ch * 1000) / 1000,
        lum: Math.round(s.lum * 1000) / 1000, trimmed: b.w < W || b.h < H, vector: false, warnings: warnings };
    });
  }

  // For sample logos written as SVG text (admin console "Try a sample").
  function prepareText(svgText, name) {
    var f; try { f = new File([svgText], name || "sample.svg", { type: "image/svg+xml" }); }
    catch (e) { f = new Blob([svgText], { type: "image/svg+xml" }); f.name = name || "sample.svg"; }
    return prepare(f);
  }

  window.CardshareLogo = { render: render, layout: layout, prepare: prepare, prepareText: prepareText, groundLum: groundLum, initials: initials, SLOT_W: SLOT_W, SLOT_H: SLOT_H };
})();
