/* Minimal canvas charts: bar, line, donut. No external libraries. */
(function (global) {
  "use strict";

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
  var PALETTE_VARS = ["--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5", "--chart-6", "--chart-7", "--chart-8"];

  function palette() { return PALETTE_VARS.map(cssVar); }

  function prepare(canvas) {
    var dpr = window.devicePixelRatio || 1;
    var rect = canvas.getBoundingClientRect();
    var w = Math.max(1, Math.floor(rect.width));
    var h = Math.max(1, Math.floor(rect.height));
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = "12px " + cssVar("--font");
    return { ctx: ctx, w: w, h: h, ink: cssVar("--ink"), muted: cssVar("--muted"), line: cssVar("--line") };
  }

  function formatShort(n) {
    if (n >= 1e7) return "₹" + (n / 1e7).toFixed(1).replace(/\.0$/, "") + "Cr";
    if (n >= 1e5) return "₹" + (n / 1e5).toFixed(1).replace(/\.0$/, "") + "L";
    if (n >= 1e3) return "₹" + (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
    return "₹" + Math.round(n);
  }

  function niceMax(v) {
    if (v <= 0) return 1;
    var exp = Math.pow(10, Math.floor(Math.log10(v)));
    var f = v / exp;
    var nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
    return nice * exp;
  }

  function axes(p, max, padL, padR, padT, padB) {
    var ctx = p.ctx;
    var steps = 4;
    ctx.strokeStyle = p.line;
    ctx.fillStyle = p.muted;
    ctx.lineWidth = 1;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (var i = 0; i <= steps; i++) {
      var y = padT + (p.h - padT - padB) * (1 - i / steps);
      ctx.beginPath();
      ctx.moveTo(padL, y + 0.5);
      ctx.lineTo(p.w - padR, y + 0.5);
      ctx.stroke();
      ctx.fillText(formatShort(max * i / steps), padL - 6, y);
    }
  }

  function barChart(canvas, labels, values, opts) {
    opts = opts || {};
    var p = prepare(canvas);
    var ctx = p.ctx;
    if (!values.length) return emptyText(p, "No data for this period");
    var padL = 54, padR = 10, padT = 10, padB = 34;
    var max = niceMax(Math.max.apply(null, values));
    axes(p, max, padL, padR, padT, padB);
    var innerW = p.w - padL - padR;
    var innerH = p.h - padT - padB;
    var slot = innerW / values.length;
    var bw = Math.min(46, slot * 0.62);
    var colors = palette();
    var hits = [];
    values.forEach(function (v, i) {
      var h = innerH * (v / max);
      var x = padL + slot * i + (slot - bw) / 2;
      var y = padT + innerH - h;
      ctx.fillStyle = opts.multicolor ? colors[i % colors.length] : colors[0];
      roundRect(ctx, x, y, bw, h, 3);
      ctx.fill();
      hits.push({ x: x, y: y, w: bw, h: h, i: i });
      ctx.fillStyle = p.muted;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      var lbl = truncate(ctx, String(labels[i]), slot - 4);
      ctx.fillText(lbl, padL + slot * i + slot / 2, padT + innerH + 6);
    });
    attachHover(canvas, hits, function (hit) { return labels[hit.i] + ": " + formatINR(values[hit.i]); }, opts.onClick);
  }

  function lineChart(canvas, labels, values, opts) {
    opts = opts || {};
    var p = prepare(canvas);
    var ctx = p.ctx;
    if (!values.length) return emptyText(p, "No data for this period");
    var padL = 54, padR = 12, padT = 12, padB = 34;
    var max = niceMax(Math.max.apply(null, values));
    axes(p, max, padL, padR, padT, padB);
    var innerW = p.w - padL - padR;
    var innerH = p.h - padT - padB;
    var n = values.length;
    var pts = values.map(function (v, i) {
      return { x: padL + (n === 1 ? innerW / 2 : innerW * i / (n - 1)), y: padT + innerH * (1 - v / max), i: i };
    });
    var color = palette()[0];
    ctx.beginPath();
    pts.forEach(function (pt, i) { i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y); });
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.lineTo(pts[n - 1].x, padT + innerH);
    ctx.lineTo(pts[0].x, padT + innerH);
    ctx.closePath();
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = 1;
    var hits = [];
    pts.forEach(function (pt) {
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      hits.push({ x: pt.x - 12, y: 0, w: 24, h: p.h, i: pt.i });
    });
    ctx.fillStyle = p.muted;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    var every = Math.ceil(n / Math.max(1, Math.floor(innerW / 60)));
    pts.forEach(function (pt, i) {
      if (i % every === 0 || i === n - 1) ctx.fillText(String(labels[i]), pt.x, padT + innerH + 6);
    });
    attachHover(canvas, hits, function (hit) { return labels[hit.i] + ": " + formatINR(values[hit.i]); }, opts.onClick);
  }

  function donutChart(canvas, labels, values, opts) {
    opts = opts || {};
    var p = prepare(canvas);
    var ctx = p.ctx;
    var total = values.reduce(function (a, b) { return a + b; }, 0);
    if (!total) return emptyText(p, "No data for this period");
    var cx = p.w / 2, cy = p.h / 2;
    var r = Math.min(p.w, p.h) / 2 - 8;
    var inner = r * 0.6;
    var colors = palette();
    var start = -Math.PI / 2;
    var hits = [];
    values.forEach(function (v, i) {
      var angle = (v / total) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r, start, start + angle);
      ctx.arc(cx, cy, inner, start + angle, start, true);
      ctx.closePath();
      ctx.fillStyle = colors[i % colors.length];
      ctx.fill();
      hits.push({ arc: true, cx: cx, cy: cy, r: r, inner: inner, a0: start, a1: start + angle, i: i });
      start += angle;
    });
    ctx.fillStyle = p.ink;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "600 14px " + cssVar("--font");
    ctx.fillText(formatShort(total), cx, cy);
    attachHover(canvas, hits, function (hit) {
      var v = values[hit.i];
      return labels[hit.i] + ": " + formatINR(v) + " (" + Math.round(v / total * 100) + "%)";
    }, opts.onClick);
  }

  function emptyText(p, msg) {
    p.ctx.fillStyle = p.muted;
    p.ctx.textAlign = "center";
    p.ctx.textBaseline = "middle";
    p.ctx.fillText(msg, p.w / 2, p.h / 2);
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x, y + h);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function truncate(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    while (text.length > 1 && ctx.measureText(text + "…").width > maxW) text = text.slice(0, -1);
    return text + "…";
  }

  function formatINR(n) {
    return "₹" + Number(n).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }

  function hitTest(hits, x, y) {
    for (var k = 0; k < hits.length; k++) {
      var h = hits[k];
      if (h.arc) {
        var dx = x - h.cx, dy = y - h.cy;
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d < h.inner || d > h.r) continue;
        var a = Math.atan2(dy, dx);
        if (a < -Math.PI / 2) a += Math.PI * 2;
        if (a >= h.a0 && a <= h.a1) return h;
      } else if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) {
        return h;
      }
    }
    return null;
  }

  function attachHover(canvas, hits, label, onClick) {
    canvas.__hits = hits;
    canvas.__label = label;
    canvas.__onClick = onClick;
    if (canvas.__bound) return;
    canvas.__bound = true;
    canvas.style.cursor = onClick ? "pointer" : "default";
    function pos(e) {
      var r = canvas.getBoundingClientRect();
      var src = e.touches ? e.touches[0] : e;
      return { x: src.clientX - r.left, y: src.clientY - r.top };
    }
    canvas.addEventListener("mousemove", function (e) {
      var pt = pos(e);
      var hit = hitTest(canvas.__hits, pt.x, pt.y);
      canvas.title = hit ? canvas.__label(hit) : "";
      canvas.style.cursor = hit && canvas.__onClick ? "pointer" : "default";
    });
    canvas.addEventListener("click", function (e) {
      var pt = pos(e);
      var hit = hitTest(canvas.__hits, pt.x, pt.y);
      if (hit && canvas.__onClick) canvas.__onClick(hit.i);
    });
  }

  global.Charts = { bar: barChart, line: lineChart, donut: donutChart, formatINR: formatINR, formatShort: formatShort };
})(window);
