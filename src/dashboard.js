'use strict';

/**
 * The built-in analytics dashboard: a single self-contained HTML page (inline
 * CSS + JS, no CDN, no build step) that fetches GET /v1/stats/summary and draws
 * KPIs + charts as hand-rolled SVG. Kept dependency-free on purpose so it works
 * offline, survives Render cold starts, and needs nothing beyond this service.
 *
 * Same-origin fetches automatically carry the Basic-Auth credentials the browser
 * already cached for /dashboard, so the stats endpoint stays gated too.
 */
function dashboardHtml() {
  return String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>MediWall · Analytics</title>
<style>
  :root {
    --bg: #f5f7fa; --card: #ffffff; --ink: #0f172a; --muted: #64748b;
    --line: #e6eaf0; --accent: #0d9488; --accent2: #6366f1; --warn: #ef4444;
    --ok: #16a34a; --chip: #f1f5f9; --shadow: 0 1px 2px rgba(16,24,40,.06), 0 1px 3px rgba(16,24,40,.1);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  header {
    display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
    padding: 18px 24px; background: var(--card); border-bottom: 1px solid var(--line);
    position: sticky; top: 0; z-index: 5;
  }
  .brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 16px; }
  .brand .dot { width: 26px; height: 26px; border-radius: 8px;
    background: linear-gradient(135deg, var(--accent), var(--accent2)); }
  .brand small { font-weight: 500; color: var(--muted); }
  .spacer { flex: 1; }
  .controls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .seg { display: inline-flex; background: var(--chip); border-radius: 9px; padding: 3px; }
  .seg button {
    border: 0; background: transparent; color: var(--muted); cursor: pointer;
    padding: 6px 12px; border-radius: 7px; font-weight: 600; font-size: 13px;
  }
  .seg button.active { background: var(--card); color: var(--ink); box-shadow: var(--shadow); }
  .btn {
    border: 1px solid var(--line); background: var(--card); color: var(--ink);
    padding: 7px 12px; border-radius: 9px; cursor: pointer; font-weight: 600; font-size: 13px;
  }
  .btn:hover { background: #fafbfc; }
  .updated { color: var(--muted); font-size: 12px; }
  main { padding: 22px; max-width: 1200px; margin: 0 auto; }
  .grid { display: grid; gap: 16px; }
  .kpis { grid-template-columns: repeat(auto-fill, minmax(168px, 1fr)); margin-bottom: 18px; }
  .charts { grid-template-columns: repeat(2, 1fr); }
  @media (max-width: 760px) { .charts { grid-template-columns: 1fr; } }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 14px;
    padding: 16px 18px; box-shadow: var(--shadow); }
  .kpi .label { color: var(--muted); font-size: 12.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .03em; }
  .kpi .value { font-size: 28px; font-weight: 700; margin-top: 6px; letter-spacing: -.01em; }
  .kpi .sub { color: var(--muted); font-size: 12px; margin-top: 2px; }
  .card h3 { margin: 0 0 2px; font-size: 14.5px; }
  .card .hint { color: var(--muted); font-size: 12px; margin: 0 0 12px; }
  .legend { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 8px; font-size: 12px; color: var(--muted); }
  .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; }
  svg { width: 100%; height: auto; display: block; overflow: visible; }
  .hoverband { cursor: crosshair; }
  .slice { cursor: pointer; transition: opacity 140ms cubic-bezier(.23,1,.32,1); }
  .crosshair { pointer-events: none; transition: opacity 120ms cubic-bezier(.23,1,.32,1); }
  /* Hover tooltip — follows the cursor, scales in from the point (ease-out, <150ms) */
  .tip {
    position: fixed; left: 0; top: 0; z-index: 60; pointer-events: none;
    background: #0f172a; color: #f8fafc; border: 1px solid rgba(148,163,184,.18);
    border-radius: 10px; padding: 8px 11px; font-size: 12.5px; line-height: 1.5;
    box-shadow: 0 8px 24px rgba(2,6,23,.28), 0 2px 6px rgba(2,6,23,.22);
    white-space: nowrap; opacity: 0;
    transform: translate(-50%, calc(-100% - 12px)) scale(.96); transform-origin: 50% 100%;
    transition: opacity 140ms cubic-bezier(.23,1,.32,1), transform 140ms cubic-bezier(.23,1,.32,1);
  }
  .tip.show { opacity: 1; transform: translate(-50%, calc(-100% - 12px)) scale(1); }
  .tip.below { transform: translate(-50%, 12px) scale(.96); transform-origin: 50% 0%; }
  .tip.below.show { transform: translate(-50%, 12px) scale(1); }
  .tip .t-title { font-weight: 700; color: #fff; font-size: 11.5px; margin-bottom: 5px; }
  .tip .t-row { display: flex; align-items: center; gap: 8px; }
  .tip .t-row + .t-row { margin-top: 2px; }
  .tip .sw { width: 9px; height: 9px; border-radius: 3px; flex: none; }
  .tip .t-name { color: #cbd5e1; }
  .tip .t-val { margin-left: auto; padding-left: 16px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .tip::after { content: ""; position: absolute; left: 50%; bottom: -5px; width: 9px; height: 9px; background: #0f172a;
    border-right: 1px solid rgba(148,163,184,.18); border-bottom: 1px solid rgba(148,163,184,.18);
    transform: translateX(-50%) rotate(45deg); }
  .tip.below::after { top: -5px; bottom: auto; border: 0;
    border-left: 1px solid rgba(148,163,184,.18); border-top: 1px solid rgba(148,163,184,.18); }
  @media (prefers-reduced-motion: reduce) {
    .tip, .crosshair, .slice { transition: opacity 120ms ease; }
    .tip, .tip.show { transform: translate(-50%, calc(-100% - 12px)); }
    .tip.below, .tip.below.show { transform: translate(-50%, 12px); }
  }
  .empty { color: var(--muted); font-size: 13px; padding: 28px 0; text-align: center; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .03em; }
  td.msg { max-width: 420px; }
  .chip { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 11.5px; font-weight: 700; }
  .chip.bug { background: #fee2e2; color: #b91c1c; }
  .chip.idea { background: #e0e7ff; color: #4338ca; }
  .chip.other { background: var(--chip); color: var(--muted); }
  .full { grid-column: 1 / -1; }
  .banner { background: #fef3c7; color: #92400e; border: 1px solid #fde68a; border-radius: 10px;
    padding: 10px 14px; margin-bottom: 16px; font-size: 13px; display: none; }
  a { color: var(--accent2); }
</style>
</head>
<body>
<header>
  <div class="brand"><span class="dot"></span> MediWall <small>· Product Analytics</small></div>
  <div class="spacer"></div>
  <div class="controls">
    <div class="seg" id="range">
      <button data-days="7">7d</button>
      <button data-days="30" class="active">30d</button>
      <button data-days="90">90d</button>
    </div>
    <button class="btn" id="refresh">↻ Refresh</button>
    <span class="updated" id="updated"></span>
  </div>
</header>
<main>
  <div class="banner" id="banner"></div>
  <section class="grid kpis" id="kpis"></section>
  <section class="grid charts" id="charts"></section>
</main>

<script>
(function () {
  "use strict";
  var SVGNS = "http://www.w3.org/2000/svg";
  var COLORS = ["#0d9488", "#6366f1", "#f59e0b", "#ec4899", "#0ea5e9", "#84cc16", "#a855f7", "#64748b"];
  var state = { days: 30, loading: false };

  // ── tiny helpers ────────────────────────────────────────────────────────────
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) { if (k === "class") n.className = attrs[k]; else if (k === "html") n.innerHTML = attrs[k]; else n.setAttribute(k, attrs[k]); }
    (kids || []).forEach(function (c) { n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }
  function svg(tag, attrs) { var n = document.createElementNS(SVGNS, tag); for (var k in attrs) n.setAttribute(k, attrs[k]); return n; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function fmt(n) { return (n == null) ? "—" : Number(n).toLocaleString(); }
  function pct(x) { return (x == null) ? "—" : (x * 100).toFixed(1) + "%"; }
  function pretty(name) { return String(name).replace(/_/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }
  function shortDate(s) { var d = new Date(s + "T00:00:00Z"); return (d.getUTCMonth() + 1) + "/" + d.getUTCDate(); }
  function longDate(s) { var d = new Date(s + "T00:00:00Z"); return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }); }

  // ── shared hover tooltip (one element, reused by every chart) ────────────────
  var tipEl = null;
  function ensureTip() { if (!tipEl) { tipEl = el("div", { class: "tip" }); document.body.appendChild(tipEl); } return tipEl; }
  function tipRows(title, rows) {
    var h = '<div class="t-title">' + esc(title) + "</div>";
    rows.forEach(function (r) {
      h += '<div class="t-row"><span class="sw" style="background:' + r.color + '"></span><span class="t-name">' +
        esc(r.name) + '</span><span class="t-val">' + esc(r.value) + "</span></div>";
    });
    return h;
  }
  function placeTip(cx, cy) {
    var t = ensureTip();
    t.classList.toggle("below", cy < 120); // flip below the cursor near the top edge
    t.style.top = cy + "px";
    var vw = (typeof window !== "undefined" && window.innerWidth) || 1200;
    var half = (t.offsetWidth || 0) / 2;
    t.style.left = Math.max(8 + half, Math.min(cx, vw - 8 - half)) + "px"; // keep on-screen
  }
  function showTip(html, cx, cy) { ensureTip().innerHTML = html; placeTip(cx, cy); ensureTip().classList.add("show"); }
  function hideTip() { if (tipEl) tipEl.classList.remove("show"); }

  // ── KPI cards ───────────────────────────────────────────────────────────────
  function kpiCard(label, value, sub) {
    return el("div", { class: "card kpi" }, [
      el("div", { class: "label" }, [label]),
      el("div", { class: "value" }, [value]),
      el("div", { class: "sub" }, [sub || ""]),
    ]);
  }

  // ── multi-series line chart (continuous trend) ──────────────────────────────
  function lineChart(series, xLabels, valueFmt) {
    valueFmt = valueFmt || fmt;
    var W = 720, H = 240, padL = 44, padR = 12, padT = 14, padB = 26;
    var iw = W - padL - padR, ih = H - padT - padB;
    var max = 1;
    series.forEach(function (s) { s.values.forEach(function (v) { if (v > max) max = v; }); });
    max = niceMax(max);
    var n = xLabels.length;
    var x = function (i) { return padL + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw); };
    var y = function (v) { return padT + ih - (v / max) * ih; };
    var s = svg("svg", { viewBox: "0 0 " + W + " " + H });

    // gridlines + y ticks
    for (var g = 0; g <= 4; g++) {
      var gy = padT + (g / 4) * ih, val = Math.round(max - (g / 4) * max);
      s.appendChild(svg("line", { x1: padL, y1: gy, x2: W - padR, y2: gy, stroke: "#eef1f5" }));
      var t = svg("text", { x: padL - 8, y: gy + 4, "text-anchor": "end", fill: "#94a3b8", "font-size": "11" }); t.textContent = fmt(val); s.appendChild(t);
    }
    // x ticks (~6 evenly spaced)
    var step = Math.max(1, Math.round(n / 6));
    for (var i = 0; i < n; i += step) {
      var tx = svg("text", { x: x(i), y: H - 6, "text-anchor": "middle", fill: "#94a3b8", "font-size": "11" }); tx.textContent = shortDate(xLabels[i]); s.appendChild(tx);
    }
    // series paths + area for the first
    series.forEach(function (ser, si) {
      var d = "", area = "";
      ser.values.forEach(function (v, i) { var px = x(i), py = y(v); d += (i ? "L" : "M") + px + " " + py + " "; area += (i ? "L" : "M") + px + " " + py + " "; });
      if (si === 0) {
        area += "L" + x(n - 1) + " " + (padT + ih) + " L" + x(0) + " " + (padT + ih) + " Z";
        s.appendChild(svg("path", { d: area, fill: ser.color, "fill-opacity": "0.08", stroke: "none" }));
      }
      s.appendChild(svg("path", { d: d, fill: "none", stroke: ser.color, "stroke-width": "2.2", "stroke-linejoin": "round", "stroke-linecap": "round" }));
      if (n <= 31) ser.values.forEach(function (v, i) {
        s.appendChild(svg("circle", { cx: x(i), cy: y(v), r: "2.6", fill: ser.color }));
      });
    });

    // ── hover: vertical guide + highlighted points + tooltip ────────────────────
    // A single transparent rect over the whole plot is the hover target, so the
    // user just has to be in the column — not pixel-on the 2.6px dot.
    var guide = svg("line", { x1: padL, y1: padT, x2: padL, y2: padT + ih, stroke: "#94a3b8", "stroke-width": "1", "stroke-dasharray": "3 4", class: "crosshair", opacity: "0" });
    s.appendChild(guide);
    var dots = series.map(function (ser) {
      var c = svg("circle", { r: "4.5", fill: ser.color, stroke: "#fff", "stroke-width": "2", class: "crosshair", opacity: "0" });
      s.appendChild(c); return c;
    });
    var band = svg("rect", { x: padL, y: padT, width: iw, height: ih, fill: "transparent", class: "hoverband" });
    s.appendChild(band);

    var last = -1;
    function at(ev) {
      var r = band.getBoundingClientRect();
      if (!r.width) return; // not laid out yet
      var vbX = (ev.clientX - r.left) * (W / r.width); // client px → viewBox units
      var i = n <= 1 ? 0 : Math.round(((vbX - padL) / iw) * (n - 1));
      i = i < 0 ? 0 : i > n - 1 ? n - 1 : i;
      var px = x(i);
      guide.setAttribute("x1", px); guide.setAttribute("x2", px); guide.setAttribute("opacity", "1");
      if (i !== last) { // only rebuild content when the column changes
        last = i;
        var rows = series.map(function (ser, si) {
          dots[si].setAttribute("cx", px); dots[si].setAttribute("cy", y(ser.values[i])); dots[si].setAttribute("opacity", "1");
          return { name: ser.name, color: ser.color, value: valueFmt(ser.values[i]) };
        });
        ensureTip().innerHTML = tipRows(longDate(xLabels[i]), rows);
      }
      placeTip(ev.clientX, ev.clientY); // follows the cursor; instant (no left/top transition)
      ensureTip().classList.add("show");
    }
    band.addEventListener("mousemove", at);
    band.addEventListener("mouseenter", at);
    band.addEventListener("mouseleave", function () {
      last = -1; guide.setAttribute("opacity", "0");
      dots.forEach(function (c) { c.setAttribute("opacity", "0"); });
      hideTip();
    });
    return s;
  }
  function niceMax(m) { if (m <= 5) return 5; var p = Math.pow(10, Math.floor(Math.log10(m))); var f = m / p; var nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10; return nice * p; }

  // ── horizontal bar chart (rankings: features, versions) ─────────────────────
  function barChart(items, valueFmt) {
    valueFmt = valueFmt || fmt;
    if (!items.length || items.every(function (i) { return !i.value; })) return el("div", { class: "empty" }, ["No data yet."]);
    var max = items.reduce(function (m, i) { return Math.max(m, i.value); }, 0) || 1;
    var rowH = 30, W = 720, labelW = 150, barW = W - labelW - 70, H = items.length * rowH + 6;
    var s = svg("svg", { viewBox: "0 0 " + W + " " + H });
    items.forEach(function (it, i) {
      var y = i * rowH + 6, w = Math.max(2, (it.value / max) * barW);
      var lab = svg("text", { x: labelW - 10, y: y + 14, "text-anchor": "end", fill: "#334155", "font-size": "12.5" }); lab.textContent = it.label; s.appendChild(lab);
      s.appendChild(svg("rect", { x: labelW, y: y, width: barW, height: 16, rx: 5, fill: "#f1f5f9" }));
      s.appendChild(svg("rect", { x: labelW, y: y, width: w, height: 16, rx: 5, fill: it.color || COLORS[i % COLORS.length] }));
      var val = svg("text", { x: labelW + barW + 8, y: y + 14, fill: "#0f172a", "font-size": "12.5", "font-weight": "600" }); val.textContent = valueFmt(it.value); s.appendChild(val);
    });
    return s;
  }

  // ── donut (platform split) ──────────────────────────────────────────────────
  function donut(items) {
    var total = items.reduce(function (s, i) { return s + i.value; }, 0);
    if (!total) return el("div", { class: "empty" }, ["No data yet."]);
    var W = 320, H = 220, cx = 110, cy = 110, r = 78, rin = 48, a = -Math.PI / 2;
    var s = svg("svg", { viewBox: "0 0 " + W + " " + H });
    var paths = [];
    items.forEach(function (it, i) {
      var frac = it.value / total, a2 = a + frac * Math.PI * 2, large = frac > 0.5 ? 1 : 0;
      var color = it.color || COLORS[i % COLORS.length];
      var p = svg("path", { d: arc(cx, cy, r, rin, a, a2, large), fill: color, class: "slice" });
      (function (label, value, fr, col) {
        function over(ev) {
          paths.forEach(function (q) { q.setAttribute("opacity", q === p ? "1" : "0.4"); }); // emphasise the hovered slice
          showTip(tipRows(label, [{ name: "installs", color: col, value: fmt(value) + " · " + (fr * 100).toFixed(0) + "%" }]), ev.clientX, ev.clientY);
        }
        p.addEventListener("mousemove", over);
        p.addEventListener("mouseenter", over);
        p.addEventListener("mouseleave", function () { paths.forEach(function (q) { q.setAttribute("opacity", "1"); }); hideTip(); });
      })(it.label, it.value, frac, color);
      paths.push(p); s.appendChild(p); a = a2;
    });
    var c = svg("text", { x: cx, y: cy - 2, "text-anchor": "middle", fill: "#0f172a", "font-size": "22", "font-weight": "700" }); c.textContent = fmt(total); s.appendChild(c);
    var cl = svg("text", { x: cx, y: cy + 16, "text-anchor": "middle", fill: "#94a3b8", "font-size": "11" }); cl.textContent = "installs"; s.appendChild(cl);
    // legend on the right
    items.forEach(function (it, i) {
      var ly = 40 + i * 24;
      s.appendChild(svg("rect", { x: 210, y: ly - 9, width: 11, height: 11, rx: 3, fill: it.color || COLORS[i % COLORS.length] }));
      var lt = svg("text", { x: 228, y: ly, fill: "#334155", "font-size": "12.5" }); lt.textContent = it.label + " · " + fmt(it.value); s.appendChild(lt);
    });
    return s;
  }
  function arc(cx, cy, r, rin, a1, a2, large) {
    var x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1), x2 = cx + r * Math.cos(a2), y2 = cy + r * Math.sin(a2);
    var x3 = cx + rin * Math.cos(a2), y3 = cy + rin * Math.sin(a2), x4 = cx + rin * Math.cos(a1), y4 = cy + rin * Math.sin(a1);
    return "M" + x1 + " " + y1 + " A" + r + " " + r + " 0 " + large + " 1 " + x2 + " " + y2 +
      " L" + x3 + " " + y3 + " A" + rin + " " + rin + " 0 " + large + " 0 " + x4 + " " + y4 + " Z";
  }

  function chartCard(title, hint, body, legend, full) {
    var kids = [el("h3", null, [title])];
    if (hint) kids.push(el("p", { class: "hint" }, [hint]));
    kids.push(body);
    if (legend) kids.push(legend);
    return el("section", { class: "card" + (full ? " full" : "") }, kids);
  }
  function legendRow(entries) {
    var box = el("div", { class: "legend" });
    entries.forEach(function (e) { box.appendChild(el("span", { html: '<i style="background:' + e.color + '"></i>' + esc(e.name) }));  });
    return box;
  }

  // ── render everything from the summary payload ──────────────────────────────
  function render(d) {
    var k = d.kpis;
    var kpis = document.getElementById("kpis");
    kpis.innerHTML = "";
    [
      kpiCard("Active installs", fmt(k.activeInstalls), "in last " + d.range.days + " days"),
      kpiCard("DAU today", fmt(k.dauToday), "active installs · " + d.range.to),
      kpiCard("New installs", fmt(k.newInstalls), "first seen in window"),
      kpiCard("Sessions", fmt(k.totalSessions), "in window"),
      kpiCard("Crash-free", pct(k.crashFreeRate), fmt(k.totalCrashes) + " crashes / window"),
      kpiCard("Day-1 retention", pct(k.d1Retention), "of eligible cohorts"),
      kpiCard("Day-7 retention", pct(k.d7Retention), "of eligible cohorts"),
    ].forEach(function (c) { kpis.appendChild(c); });

    var charts = document.getElementById("charts");
    charts.innerHTML = "";
    var xLabels = d.daily.map(function (r) { return r.date; });

    // Active users trend
    charts.appendChild(chartCard(
      "Active users & sessions", "Daily active installs vs. sessions started",
      lineChart([
        { name: "DAU", color: COLORS[0], values: d.daily.map(function (r) { return r.dau; }) },
        { name: "Sessions", color: COLORS[1], values: d.daily.map(function (r) { return r.sessions; }) },
      ], xLabels),
      legendRow([{ name: "DAU", color: COLORS[0] }, { name: "Sessions", color: COLORS[1] }])
    ));

    // Engagement / stability trend
    charts.appendChild(chartCard(
      "Engagement & stability", "Home opens and crashes per day",
      lineChart([
        { name: "Home opens", color: COLORS[4], values: d.daily.map(function (r) { return r.opens; }) },
        { name: "Crashes", color: COLORS[2], values: d.daily.map(function (r) { return r.crashes; }) },
      ], xLabels),
      legendRow([{ name: "Home opens", color: COLORS[4] }, { name: "Crashes", color: COLORS[2] }])
    ));

    // Feature adoption
    charts.appendChild(chartCard(
      "Feature adoption", "Total actions in the window — what's actually being used",
      barChart(d.features.map(function (f, i) { return { label: pretty(f.name), value: f.count, color: COLORS[i % COLORS.length] }; }))
    ));

    // Platform split
    charts.appendChild(chartCard(
      "Platform split", "Distinct installs by OS",
      donut(d.platforms.map(function (p, i) { return { label: p.label === "ios" ? "iOS" : p.label === "android" ? "Android" : p.label, value: p.installs, color: COLORS[i % COLORS.length] }; }))
    ));

    // App versions
    charts.appendChild(chartCard(
      "App versions", "Distinct installs on each build (top 8)",
      barChart(d.versions.map(function (v, i) { return { label: v.label, value: v.installs, color: COLORS[(i + 2) % COLORS.length] }; }))
    ));

    // Retention cohorts
    if (d.retention && d.retention.length) {
      var rl = d.retention.map(function (c) { return c.cohort; });
      charts.appendChild(chartCard(
        "Retention by cohort", "Share of each day's new installs returning on day 1 / day 7",
        lineChart([
          { name: "Day 1", color: COLORS[0], values: d.retention.map(function (c) { return Math.round(c.d1Rate * 100); }) },
          { name: "Day 7", color: COLORS[3], values: d.retention.map(function (c) { return Math.round(c.d7Rate * 100); }) },
        ], rl, function (v) { return v + "%"; }),
        legendRow([{ name: "Day 1 (%)", color: COLORS[0] }, { name: "Day 7 (%)", color: COLORS[3] }])
      ));
    } else {
      charts.appendChild(chartCard("Retention by cohort", "Returning installs by cohort", el("div", { class: "empty" }, ["Not enough history yet."])));
    }

    // Feedback breakdown
    var fb = d.feedback;
    charts.appendChild(chartCard(
      "Feedback", fb.total + " submission(s) in window",
      barChart([
        { label: "Bugs", value: fb.byCategory.bug, color: "#ef4444" },
        { label: "Ideas", value: fb.byCategory.idea, color: COLORS[1] },
        { label: "Other", value: fb.byCategory.other, color: COLORS[7] },
      ])
    ));

    // Recent feedback table (full width)
    charts.appendChild(feedbackTable(fb.recent));

    document.getElementById("updated").textContent = "Updated " + new Date(d.generatedAt).toLocaleString();
  }

  function feedbackTable(rows) {
    var body;
    if (!rows || !rows.length) { body = el("div", { class: "empty" }, ["No feedback yet."]); }
    else {
      var html = "<table><thead><tr><th>When</th><th>Type</th><th>OS</th><th>Version</th><th>Message</th><th>Contact</th></tr></thead><tbody>";
      rows.forEach(function (r) {
        var when = r.submittedAt ? new Date(r.submittedAt).toLocaleString() : "—";
        var cat = (r.category || "other").toLowerCase();
        var contact = r.contactEmail ? '<a href="mailto:' + esc(r.contactEmail) + '">' + esc(r.contactEmail) + "</a>" : "—";
        html += "<tr><td>" + esc(when) + '</td><td><span class="chip ' + esc(cat) + '">' + esc(cat) + "</span></td><td>" +
          esc(r.os || "—") + "</td><td>" + esc(r.appVersion || "—") + '</td><td class="msg">' + esc(r.message || "") + "</td><td>" + contact + "</td></tr>";
      });
      html += "</tbody></table>";
      body = el("div", { html: html });
    }
    return el("section", { class: "card full" }, [el("h3", null, ["Recent feedback"]), el("p", { class: "hint" }, ["Newest 50 submissions — triage bugs and ideas here."]), body]);
  }

  // ── data load ───────────────────────────────────────────────────────────────
  function load() {
    if (state.loading) return;
    state.loading = true;
    var banner = document.getElementById("banner"); banner.style.display = "none";
    fetch("v1/stats/summary?days=" + state.days, { headers: { "Accept": "application/json" } })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (d) { render(d); })
      .catch(function (e) { banner.textContent = "Couldn't load analytics: " + e.message; banner.style.display = "block"; })
      .then(function () { state.loading = false; });
  }

  // ── wire controls ───────────────────────────────────────────────────────────
  document.getElementById("range").addEventListener("click", function (e) {
    var b = e.target.closest("button"); if (!b) return;
    state.days = parseInt(b.getAttribute("data-days"), 10);
    [].forEach.call(this.children, function (c) { c.classList.toggle("active", c === b); });
    load();
  });
  document.getElementById("refresh").addEventListener("click", load);
  load();
  setInterval(load, 5 * 60 * 1000); // gentle auto-refresh every 5 min
})();
</script>
</body>
</html>`;
}

module.exports = { dashboardHtml };
