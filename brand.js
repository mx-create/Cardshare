// Cardshare v2: company branding for managed Work cards. Shared by the phone (index.html) and the admin console.
//
// An organisation's branding: {light:{primary, accent, card, text, buttonText}, dark:{…}, darkAuto, radius, cardStyle,
// logoPlace, font}. light is used with the app's Daylight theme, dark with Midnight, Ocean and Ember. With darkAuto the dark
// set is generated from the light one.
//
// Safety: resolve() never returns an unreadable pair. Text on the card and button text on the primary colour are held
// to WCAG AA (4.5:1); a failing colour is swapped for the nearest passing shade of the same hue. The QR is never branded.
(function () {
  var AA = 4.5;

  // ------------------------------------------------------------ colour maths
  function hex(v) {
    var s = String(v == null ? "" : v).trim().replace(/^#/, "");
    if (/^[0-9a-f]{3}$/i.test(s)) s = s.replace(/./g, function (c) { return c + c; });
    return /^[0-9a-f]{6}$/i.test(s) ? "#" + s.toUpperCase() : null;
  }
  function rgb(h) { h = hex(h) || "#000000"; var n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; }
  function toHex(r, g, b) { return "#" + [r, g, b].map(function (x) { x = Math.max(0, Math.min(255, Math.round(x))); return ("0" + x.toString(16)).slice(-2); }).join("").toUpperCase(); }
  function hsl(h) {
    var c = rgb(h).map(function (x) { return x / 255; }), mx = Math.max.apply(0, c), mn = Math.min.apply(0, c), l = (mx + mn) / 2, d = mx - mn, H = 0, S = 0;
    if (d) {
      S = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      H = mx === c[0] ? (c[1] - c[2]) / d + (c[1] < c[2] ? 6 : 0) : mx === c[1] ? (c[2] - c[0]) / d + 2 : (c[0] - c[1]) / d + 4;
      H *= 60;
    }
    return [Math.round(H), Math.round(S * 100), Math.round(l * 100)];
  }
  function fromHsl(H, S, L) {
    S = Math.max(0, Math.min(100, S)) / 100; L = Math.max(0, Math.min(100, L)) / 100; H = ((H % 360) + 360) % 360;
    var k = function (n) { return (n + H / 30) % 12; }, a = S * Math.min(L, 1 - L);
    var f = function (n) { return L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))); };
    return toHex(f(0) * 255, f(8) * 255, f(4) * 255);
  }
  // Accepts #hex, rgb(…), "r, g, b" and hsl(…).
  function parse(v) {
    var s = String(v || "").trim(), m;
    if (hex(s)) return hex(s);
    if ((m = /^(?:rgba?\()?\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*(?:[,/][^)]*)?\)?$/i.exec(s)) && !/^hsl/i.test(s)) return toHex(+m[1], +m[2], +m[3]);
    if ((m = /^hsla?\(\s*(-?\d+(?:\.\d+)?)(?:deg)?\s*[, ]\s*(\d+(?:\.\d+)?)%?\s*[, ]\s*(\d+(?:\.\d+)?)%?/i.exec(s))) return fromHsl(+m[1], +m[2], +m[3]);
    return null;
  }
  function lin(c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function lum(h) { var c = rgb(h); return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]); }
  function contrast(a, b) { var x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
  function mix(a, b, t) { var p = rgb(a), q = rgb(b); return toHex(p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t); }
  function rgba(h, a) { var c = rgb(h); return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + a + ")"; }
  function bestOn(bg) { return contrast("#FFFFFF", bg) >= contrast("#111111", bg) ? "#FFFFFF" : "#111111"; }

  // The shade of fg (same hue and saturation) closest in lightness that reaches `target` against bg.
  function nearestPassing(fg, bg, target) {
    target = target || AA; fg = hex(fg) || "#000000"; bg = hex(bg) || "#FFFFFF";
    if (contrast(fg, bg) >= target) return fg;
    var c = hsl(fg), best = null;
    for (var d = 1; d <= 100 && !best; d++) {
      [c[2] - d, c[2] + d].forEach(function (L) {
        if (best || L < 0 || L > 100) return;
        var t = fromHsl(c[0], c[1], L); if (contrast(t, bg) >= target) best = t;
      });
    }
    return best || bestOn(bg);
  }

  // ------------------------------------------------------------ themes
  // A dark-theme set from a light one: same hues, a deep card, light text, colours lifted so they still read.
  function darkFrom(L) {
    var p = hsl(L.primary), a = hsl(L.accent), c = hsl(L.card);
    var card = c[2] <= 30 ? L.card : fromHsl(c[1] > 8 ? c[0] : p[0], Math.min(Math.max(c[1], p[1] * 0.35), 30), 13);
    var primary = p[2] < 52 ? fromHsl(p[0], p[1], 58) : L.primary;
    var accent = a[2] < 55 ? fromHsl(a[0], a[1], 64) : L.accent;
    var text = lum(L.text) > 0.6 ? L.text : fromHsl(hsl(L.text)[0], Math.min(hsl(L.text)[1], 20), 94);
    return { primary: primary, accent: accent, card: card, text: text, buttonText: bestOn(primary) };
  }

  var KEYS = ["primary", "accent", "card", "text", "buttonText"];
  var FONTS = {
    // All served with the site from fonts/ (SIL OFL, licences alongside): no outside requests.
    inter: { n: "Inter", stack: '"Inter",system-ui,-apple-system,"Segoe UI",sans-serif', url: "" },
    serif: { n: "Serif (Fraunces)", stack: '"Fraunces",Georgia,"Times New Roman",serif', url: "" },
    geometric: { n: "Geometric sans (Outfit)", stack: '"Outfit","Century Gothic",Futura,system-ui,sans-serif', url: "" },
    system: { n: "System", stack: 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif', url: "" }
  };
  var RADII = { sharp: { card: 4, button: 4 }, soft: { card: 16, button: 12 }, round: { card: 28, button: 999 } };
  var CARD_STYLES = { brand: "Brand colour", light: "Light", dark: "Dark" };
  var NEUTRAL = { light: "#F8F7F4", dark: "#17181D" };

  var DEFAULT = { light: { primary: "#6654E8", accent: "#7366E8", card: "#FFFFFF", text: "#1B1C24", buttonText: "#FFFFFF" },
    dark: null, darkAuto: true, radius: "soft", cardStyle: "brand", logoPlace: "centre", font: "inter" };
  var PRESETS = [
    { id: "coral", n: "Coral & navy", light: { primary: "#B8441F", accent: "#1F3A5F", card: "#FFF8F3", text: "#1B2433", buttonText: "#FFFFFF" } },
    { id: "forest", n: "Forest", light: { primary: "#2E5E3A", accent: "#9BC48A", card: "#F4EFE3", text: "#23301F", buttonText: "#F4EFE3" } },
    { id: "fjord", n: "Fjord", light: { primary: "#1E7A70", accent: "#3FA7A0", card: "#0F2B2E", text: "#E8F6F3", buttonText: "#FFFFFF" } },
    { id: "ink", n: "Ink", light: { primary: "#111111", accent: "#E5484D", card: "#FFFFFF", text: "#111111", buttonText: "#FFFFFF" } },
    { id: "royal", n: "Royal", light: { primary: "#3B2FA8", accent: "#F2B84B", card: "#F3F1FF", text: "#1A1640", buttonText: "#FFFFFF" } },
    { id: "sunrise", n: "Sunrise", light: { primary: "#F2B84B", accent: "#E5484D", card: "#2A1A12", text: "#FFF4E6", buttonText: "#2A1A12" } }
  ];

  // Anything from an admin or the server, made well-formed. Unknown or broken values fall back to the defaults.
  function clean(b) {
    b = b || {};
    var out = { light: {}, dark: null, darkAuto: b.darkAuto !== false,
      radius: RADII[b.radius] ? b.radius : DEFAULT.radius, cardStyle: CARD_STYLES[b.cardStyle] ? b.cardStyle : DEFAULT.cardStyle,
      logoPlace: b.logoPlace === "left" ? "left" : "centre", font: FONTS[b.font] ? b.font : DEFAULT.font };
    KEYS.forEach(function (k) { out.light[k] = hex(b.light && b.light[k]) || DEFAULT.light[k]; });
    if (!out.darkAuto) { out.dark = {}; var gen = darkFrom(out.light); KEYS.forEach(function (k) { out.dark[k] = hex(b.dark && b.dark[k]) || gen[k]; }); }
    return out;
  }
  function variant(b, dark) { b = clean(b); return dark ? (b.darkAuto ? darkFrom(b.light) : b.dark) : b.light; }

  // What a phone actually paints, after the card style and the contrast safety net. fixes lists any swapped colour.
  function resolve(b, dark) {
    b = clean(b);
    var v = variant(b, dark), card = b.cardStyle === "brand" ? v.card : NEUTRAL[b.cardStyle], fixes = [];
    var text = v.text;
    if (b.cardStyle !== "brand" && contrast(text, card) < AA) text = bestOn(card); // a light/dark card picks its own text
    else if (contrast(text, card) < AA) { text = nearestPassing(text, card); fixes.push({ k: "text", from: v.text, to: text }); }
    var btn = v.buttonText;
    if (contrast(btn, v.primary) < AA) { btn = nearestPassing(btn, v.primary); fixes.push({ k: "buttonText", from: v.buttonText, to: btn }); }
    var f = FONTS[b.font], r = RADII[b.radius];
    return { primary: v.primary, accent: v.accent, card: card, text: text, buttonText: btn,
      hair: rgba(text, 0.14), soft: rgba(text, 0.72), dim: rgba(text, 0.56), glow: rgba(v.primary, 0.24), accentBg: rgba(v.accent, 0.14),
      radius: r.card, buttonRadius: r.button, font: f.stack, fontUrl: f.url, logoPlace: b.logoPlace, cardStyle: b.cardStyle,
      cardLum: lum(card), fixes: fixes };
  }

  // The checks the admin console shows live, on the colours exactly as typed (before any safety swap).
  function checks(b, dark) {
    b = clean(b);
    var v = variant(b, dark), card = b.cardStyle === "brand" ? v.card : NEUTRAL[b.cardStyle];
    var text = b.cardStyle !== "brand" && contrast(v.text, card) < AA ? bestOn(card) : v.text;
    return [
      { k: "text", label: "Text on card", fg: text, bg: card, ratio: contrast(text, card), auto: text !== v.text },
      { k: "buttonText", label: "Button text on primary", fg: v.buttonText, bg: v.primary, ratio: contrast(v.buttonText, v.primary) }
    ].map(function (c) { c.ok = c.ratio >= AA; c.fix = c.ok ? null : nearestPassing(c.fg, c.bg); return c; });
  }

  // ------------------------------------------------------------ colours from a logo
  // Draws the logo small, buckets its visible pixels, merges near neighbours, and returns up to `n` colours, most used first.
  // Near-white and near-black are kept but sorted after the real colours.
  function extract(src, n) {
    n = n || 6;
    return new Promise(function (ok, fail) {
      var img = new Image();
      img.onload = function () {
        var W = 64, H = Math.max(1, Math.round(64 * img.naturalHeight / Math.max(1, img.naturalWidth)));
        if (H > 128) { H = 128; W = Math.max(1, Math.round(128 * img.naturalWidth / img.naturalHeight)); }
        var c = document.createElement("canvas"); c.width = W; c.height = H;
        var x = c.getContext("2d"); x.drawImage(img, 0, 0, W, H);
        var d; try { d = x.getImageData(0, 0, W, H).data; } catch (e) { fail(e); return; }
        var buckets = {};
        for (var i = 0; i < d.length; i += 4) {
          if (d[i + 3] < 128) continue;
          var k = (d[i] >> 4) + "," + (d[i + 1] >> 4) + "," + (d[i + 2] >> 4), bk = buckets[k] || (buckets[k] = { r: 0, g: 0, b: 0, n: 0 });
          bk.r += d[i]; bk.g += d[i + 1]; bk.b += d[i + 2]; bk.n++;
        }
        var list = Object.keys(buckets).map(function (k) { var b = buckets[k]; return { hex: toHex(b.r / b.n, b.g / b.n, b.b / b.n), n: b.n }; })
          .sort(function (a, b) { return b.n - a.n; });
        var out = [];
        list.forEach(function (c) {
          var p = rgb(c.hex), near = out.filter(function (o) { var q = rgb(o.hex); return Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) < 60; })[0];
          if (near) near.n += c.n; else out.push(c);
        });
        var plain = function (h) { var l = hsl(h)[2], s = hsl(h)[1]; return l > 92 || l < 8 || s < 6; };
        out.sort(function (a, b) { return (plain(a.hex) - plain(b.hex)) || (b.n - a.n); });
        ok(out.slice(0, n).map(function (c) { return c.hex; }));
      };
      img.onerror = function () { fail(new Error("logo")); };
      img.src = src;
    });
  }
  // A starting palette from logo colours: the strongest colour as primary, the next as accent, a pale tint as the card.
  function fromColours(cols) {
    var sat = cols.slice().sort(function (a, b) { return hsl(b)[1] * (1 - Math.abs(hsl(b)[2] - 50) / 50) - hsl(a)[1] * (1 - Math.abs(hsl(a)[2] - 50) / 50); });
    var primary = sat[0] || DEFAULT.light.primary, accent = sat[1] || primary, p = hsl(primary);
    var card = fromHsl(p[0], Math.min(p[1], 40), 97), text = fromHsl(p[0], Math.min(p[1], 35), 14);
    return { primary: primary, accent: accent, card: card, text: text, buttonText: bestOn(primary) };
  }

  window.CardshareBrand = { AA: AA, hex: hex, rgb: rgb, toHex: toHex, hsl: hsl, fromHsl: fromHsl, parse: parse, lum: lum, contrast: contrast,
    mix: mix, rgba: rgba, bestOn: bestOn, nearestPassing: nearestPassing, darkFrom: darkFrom, clean: clean, variant: variant, resolve: resolve,
    checks: checks, extract: extract, fromColours: fromColours, KEYS: KEYS, FONTS: FONTS, RADII: RADII, CARD_STYLES: CARD_STYLES, DEFAULT: DEFAULT, PRESETS: PRESETS };
})();
