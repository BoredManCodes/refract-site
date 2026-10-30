// Password-gated /admin/stats dashboard. Reads the permanent KV log that
// track.js writes on every page-view and click event (see its
// trackAnalytics). Every dimension worth tallying lives in the key NAME
// (date, path/choice, country, visitor id), not the value, so this needs a
// plain list() per prefix and never a per-key get().
const ADMIN_COOKIE = "refract_admin_auth";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

const html = (body, status = 200) =>
  new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Constant-time-ish compare; good enough for a single admin password, not a
// substitute for real auth infra.
function timingSafeEqual(a, b) {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

function isAuthed(request, password) {
  const cookie = request.headers.get("cookie") || "";
  const m = cookie.match(/(?:^|;\s*)refract_admin_auth=([^;]+)/);
  if (!m) return false;
  let v;
  try {
    v = decodeURIComponent(m[1]);
  } catch {
    return false;
  }
  return timingSafeEqual(v, password);
}

function gatePage({ error } = {}) {
  const errMsg = error === "wrong" ? "Wrong password." : error === "bad-request" ? "Bad request." : null;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Admin | Refract SMP</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#F6F7F9;color:#2B2B2B;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{background:#fff;border:1px solid #E4E7EC;border-radius:12px;padding:2rem;max-width:380px;width:100%;box-shadow:0 8px 24px -8px rgba(0,0,0,.15)}
h1{margin:0 0 .5rem;font-size:1.4rem}h1 em{font-style:normal;color:#1B6E8C}
input[type=password]{width:100%;box-sizing:border-box;border:1px solid #D6DDE5;border-radius:8px;padding:.6rem .8rem;font-size:1rem;margin-top:1rem}
button{margin-top:1rem;background:#1B6E8C;color:#fff;border:0;border-radius:999px;padding:.65rem 1.25rem;font-size:.9rem;font-weight:600;cursor:pointer}
.err{color:#B3311F;font-size:.9rem;margin-top:.75rem}</style></head>
<body><div class="box"><h1>Refract SMP <em>Admin</em></h1><p>Enter the admin password to view stats.</p>
<form method="POST" action="/admin/login">
<input type="password" name="password" autofocus required>
<button type="submit">Unlock &rarr;</button>
${errMsg ? `<p class="err">${errMsg}</p>` : ""}
</form></div></body></html>`;
}

// Every page in public/ (index.html files outside wp-*). Update when pages are
// added to the mirror; used to flag pages that have never had a visitor.
const KNOWN_PAGES = ["/", "/rules", "/privacy"];

const normPath = (p) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

function fmtSecs(s) {
  if (s == null) return "-";
  if (s < 60) return `${Math.round(s)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : 0);

function median(nums) {
  if (!nums.length) return null;
  const a = [...nums].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function addUniq(map, value, vid) {
  if (!map.has(value)) map.set(value, new Set());
  map.get(value).add(vid);
}

// Bar list of unique visitors per value, labelled with their share of all visitors.
function audienceBars(map, total, limit = 8) {
  const rows = topRows(new Map([...map].map(([k, v]) => [k, v.size])), limit);
  if (!rows.length) return '<p class="empty">No data yet.</p>';
  const max = rows[0][1];
  return rows.map(([k, n]) => statBar(`${k} (${pct(n, total)}%)`, n, max)).join("");
}

function bump(map, key, by = 1) {
  map.set(key, (map.get(key) || 0) + by);
}

function topRows(map, limit) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function statBar(label, count, max) {
  const pct = max > 0 ? Math.max(2, Math.round((count / max) * 100)) : 0;
  return `<div class="row"><span class="label">${escapeHtml(label)}</span>
<span class="track"><span class="fill" style="width:${pct}%"></span></span>
<span class="count">${count.toLocaleString("en-AU")}</span></div>`;
}

async function fetchAllKeys(kv, prefix) {
  let names = [];
  let cursor;
  do {
    const res = await kv.list({ prefix, cursor, limit: 1000 });
    names = names.concat(res.keys.map((k) => k.name));
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
  return names;
}

const STATS_CSS = `<style>
:root{--ink:#2B2B2B;--mute:#6B7C93;--line:#E4E7EC;--accent:#1B6E8C;--surface:#fff;--bg:#F6F7F9}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.5}
.wrap{max-width:1100px;margin:0 auto;padding:2rem 1.5rem 3rem}
h1{font-size:1.4rem;margin:0 0 1.5rem}h1 em{font-style:normal;color:var(--accent)}
h2{font-size:1rem;margin:0 0 .75rem;color:var(--mute);text-transform:uppercase;letter-spacing:.06em;font-weight:600}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:1rem;margin-bottom:2rem}
.card{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:1.1rem 1.25rem}
.card .num{font-size:1.8rem;font-weight:700}.card .lab{color:var(--mute);font-size:.8rem;margin-top:.15rem}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:2rem}
section{margin-bottom:1rem}
.row{display:grid;grid-template-columns:minmax(0,1fr) 100px 48px;align-items:center;gap:.6rem;padding:.3rem 0;font-size:.82rem}
.label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.track{background:var(--line);border-radius:4px;height:6px;overflow:hidden}
.fill{display:block;height:100%;background:var(--accent);border-radius:4px}
.count{text-align:right;color:var(--mute);font-family:ui-monospace,monospace;font-size:.72rem}
.empty{color:var(--mute);font-size:.8rem}
table{width:100%;border-collapse:collapse;font-size:.85rem}
th,td{text-align:left;padding:.45rem .6rem;border-bottom:1px solid var(--line)}
tr.zero td{color:var(--mute);font-style:italic}
.insights{margin:0;padding-left:1.1rem;font-size:.9rem}.insights li{margin:.25rem 0}
th{color:var(--mute);font-weight:600;font-size:.75rem;text-transform:uppercase;letter-spacing:.04em}
</style>`;

async function statsPage(env) {
  const [pvKeys, refKeys, clickKeys, durKeys, envKeys, scrollKeys, utmKeys] = await Promise.all([
    fetchAllKeys(env.SITE_STATS, "pv:"),
    fetchAllKeys(env.SITE_STATS, "ref:"),
    fetchAllKeys(env.SITE_STATS, "click:"),
    fetchAllKeys(env.SITE_STATS, "dur:"),
    fetchAllKeys(env.SITE_STATS, "env:"),
    fetchAllKeys(env.SITE_STATS, "scroll:"),
    fetchAllKeys(env.SITE_STATS, "utm:"),
  ]);

  const byPath = new Map();
  const byCountry = new Map();
  const allVids = new Set();
  const vidsByPath = new Map(); // normalized path -> Set of vids
  const pathsByVid = new Map(); // vid -> Set of normalized paths
  const viewsByNorm = new Map();
  for (const key of pvKeys) {
    const parts = key.split(":");
    if (parts.length < 5) continue;
    const [, , path, country, vid] = parts;
    bump(byPath, path);
    bump(byCountry, country);
    allVids.add(vid);
    const np = normPath(path);
    bump(viewsByNorm, np);
    if (!vidsByPath.has(np)) vidsByPath.set(np, new Set());
    vidsByPath.get(np).add(vid);
    if (!pathsByVid.has(vid)) pathsByVid.set(vid, new Set());
    pathsByVid.get(vid).add(np);
  }

  const timesByPath = new Map(); // normalized path -> seconds[]
  for (const key of durKeys) {
    const parts = key.split(":");
    if (parts.length < 6) continue;
    const secs = Number(parts[3]);
    if (!(secs >= 1)) continue;
    const np = normPath(parts[2]);
    if (!timesByPath.has(np)) timesByPath.set(np, []);
    timesByPath.get(np).push(secs);
  }

  const byReferrer = new Map();
  for (const key of refKeys) {
    const parts = key.split(":");
    if (parts.length < 4) continue;
    bump(byReferrer, parts[2]);
  }

  // Audience context: one env key per page-view. Dimensions are tallied per
  // unique visitor (a visitor on two devices counts once for each); hour and
  // weekday are tallied per page-view.
  const dims = { device: new Map(), browser: new Map(), os: new Map(), region: new Map(), city: new Map(), lang: new Map(), width: new Map(), res: new Map(), scheme: new Map(), conn: new Map(), visit: new Map() };
  const byHour = new Map();
  const byDow = new Map();
  const envVids = new Set();
  for (const key of envKeys) {
    const parts = key.split(":");
    if (parts.length < 16) continue;
    const [, day, hour, device, browser, os, region, city, lang, width, res, scheme, conn, visit, vid] = parts;
    for (const [name, value] of Object.entries({ device, browser, os, region, city, lang, width, res, scheme, conn, visit })) {
      if (value && value !== "?") addUniq(dims[name], name === "visit" ? (value === "ret" ? "returning" : "new") : value, vid);
    }
    bump(byHour, hour);
    bump(byDow, DOW[new Date(day + "T12:00:00Z").getUTCDay()]);
    envVids.add(vid);
  }
  const envVisitors = envVids.size;

  const depthByPath = new Map(); // normalized path -> Map(vid -> deepest scroll)
  for (const key of scrollKeys) {
    const parts = key.split(":");
    if (parts.length < 6) continue;
    const np = normPath(parts[2]);
    const depth = Number(parts[3]);
    if (!depthByPath.has(np)) depthByPath.set(np, new Map());
    const m = depthByPath.get(np);
    m.set(parts[4], Math.max(m.get(parts[4]) || 0, depth));
  }

  const utms = new Map();
  const utmVids = new Set();
  for (const key of utmKeys) {
    const parts = key.split(":");
    if (parts.length < 7) continue;
    addUniq(utms, `${parts[2]} / ${parts[3]} / ${parts[4]}`, parts[5]);
    utmVids.add(parts[5]);
  }

  const clicks = new Map();
  const clickVids = new Map(); // target -> Set of vids
  const anyClickVids = new Set();
  for (const key of clickKeys) {
    const parts = key.split(":");
    if (parts.length < 5) continue;
    const [, , target, vid] = parts;
    bump(clicks, target);
    if (!clickVids.has(target)) clickVids.set(target, new Set());
    clickVids.get(target).add(vid);
    anyClickVids.add(vid);
  }
  const totalVisitors = allVids.size;
  const clickRows = topRows(clicks, 20)
    .map(
      ([t, c]) =>
        `<tr><td>${escapeHtml(t)}</td><td>${c.toLocaleString("en-AU")}</td><td>${clickVids.get(t).size.toLocaleString("en-AU")}</td><td>${pct(clickVids.get(t).size, totalVisitors)}%</td></tr>`
    )
    .join("");

  // Per-page breakdown: every known page plus anything else that logged a view.
  const pageSet = new Set([...KNOWN_PAGES.map(normPath), ...viewsByNorm.keys()]);
  const pageRows = [...pageSet]
    .map((p) => {
      const times = timesByPath.get(p) || [];
      const depths = [...(depthByPath.get(p)?.values() || [])];
      return {
        scroll: depths.length ? depths.reduce((a, b) => a + b, 0) / depths.length : null,
        path: p,
        views: viewsByNorm.get(p) || 0,
        visitors: vidsByPath.get(p)?.size || 0,
        timed: times.length,
        avg: times.length ? times.reduce((a, b) => a + b, 0) / times.length : null,
        med: median(times),
      };
    })
    .sort((a, b) => b.views - a.views || a.path.localeCompare(b.path));

  const insights = [];
  if (totalVisitors > 0) {
    const bookers = new Set();
    for (const t of ["discord"]) for (const v of clickVids.get(t) || []) bookers.add(v);
    insights.push(`${pct(bookers.size, totalVisitors)}% of visitors (${bookers.size} of ${totalVisitors}) clicked through to Discord.`);
    const contactors = new Set();
    for (const t of ["phone", "email"]) for (const v of clickVids.get(t) || []) contactors.add(v);
    if (contactors.size) insights.push(`${pct(contactors.size, totalVisitors)}% of visitors (${contactors.size}) tapped phone or email.`);
    insights.push(`${pct(anyClickVids.size, totalVisitors)}% of visitors clicked at least one tracked link.`);
    const other = new Map(
      [...clickVids].filter(([t]) => !["fresha booking", "fresha gift cards", "phone", "email"].includes(t)).map(([t, v]) => [t, v.size])
    );
    for (const [t, n] of topRows(other, 3)) insights.push(`${pct(n, totalVisitors)}% of visitors clicked "${t}".`);
    if (envVisitors > 0) {
      const share = (map, label, v) => {
        const n = map.get(v)?.size || 0;
        if (n) insights.push(`${pct(n, envVisitors)}% of visitors were ${label}.`);
      };
      share(dims.device, "on mobile", "mobile");
      share(dims.device, "on desktop", "desktop");
      share(dims.device, "on a tablet", "tablet");
      share(dims.visit, "returning visitors", "returning");
      const topOf = (map) => topRows(new Map([...map].map(([k, v]) => [k, v.size])), 1)[0];
      const topCity = topOf(dims.city);
      if (topCity) insights.push(`Most common city: ${topCity[0]} (${pct(topCity[1], envVisitors)}% of visitors).`);
      const topBrowser = topOf(dims.browser);
      if (topBrowser) insights.push(`Most common browser: ${topBrowser[0]} (${pct(topBrowser[1], envVisitors)}%).`);
      const fresha = new Set();
      for (const t of ["discord"]) for (const v of clickVids.get(t) || []) fresha.add(v);
      for (const [device, set] of dims.device) {
        const n = [...set].filter((v) => fresha.has(v)).length;
        if (set.size >= 3) insights.push(`${pct(n, set.size)}% of ${device} visitors (${n} of ${set.size}) clicked through to Discord.`);
      }
    }
    const single = [...pathsByVid.values()].filter((s) => s.size === 1).length;
    insights.push(`${pct(single, totalVisitors)}% of visitors only ever viewed one page.`);
    insights.push(`Visitors viewed ${(pvKeys.length / totalVisitors).toFixed(1)} pageviews each on average.`);
  }
  const unvisited = pageRows.filter((r) => r.views === 0).map((r) => r.path);
  if (unvisited.length) insights.push(`Never visited: ${unvisited.join(", ")}.`);
  const timedRows = pageRows.filter((r) => r.timed >= 3 && r.avg != null);
  if (timedRows.length >= 2) {
    const byAvg = [...timedRows].sort((a, b) => b.avg - a.avg);
    insights.push(`Longest average time on page: ${byAvg[0].path} (${fmtSecs(byAvg[0].avg)}). Shortest: ${byAvg.at(-1).path} (${fmtSecs(byAvg.at(-1).avg)}).`);
  }
  const insightHtml = insights.length
    ? `<ul class="insights">${insights.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>`
    : '<p class="empty">No data yet.</p>';
  const pageTable = `<table><tr><th>Page</th><th>Views</th><th>Visitors</th><th>% of visitors</th><th>Avg time</th><th>Median time</th><th>Avg scroll</th></tr>${pageRows
    .map(
      (r) =>
        `<tr${r.views === 0 ? ' class="zero"' : ""}><td>${escapeHtml(r.path)}</td><td>${r.views.toLocaleString("en-AU")}</td><td>${r.visitors.toLocaleString("en-AU")}</td><td>${pct(r.visitors, totalVisitors)}%</td><td>${fmtSecs(r.avg)}</td><td>${fmtSecs(r.med)}</td><td>${r.scroll == null ? "-" : Math.round(r.scroll) + "%"}</td></tr>`
    )
    .join("")}</table>`;

  const topPaths = topRows(byPath, 15);
  const topReferrers = topRows(byReferrer, 15);
  const topCountries = topRows(byCountry, 10);
  const maxPath = topPaths[0]?.[1] || 0;
  const maxRef = topReferrers[0]?.[1] || 0;
  const maxCty = topCountries[0]?.[1] || 0;

  return `<!doctype html><html><head><meta charset="utf-8"><title>Stats | Refract SMP Admin</title><meta name="robots" content="noindex,nofollow">${STATS_CSS}</head>
<body><div class="wrap">
<h1>Refract SMP <em>Admin</em> · Stats</h1>
<div class="cards">
<div class="card"><div class="num">${pvKeys.length.toLocaleString("en-AU")}</div><div class="lab">Pageviews</div></div>
<div class="card"><div class="num">${allVids.size.toLocaleString("en-AU")}</div><div class="lab">Unique visitors</div></div>
<div class="card"><div class="num">${refKeys.length.toLocaleString("en-AU")}</div><div class="lab">Sessions with a referrer</div></div>
</div>

<section>
<h2>Insights</h2>
${insightHtml}
</section>

<section>
<h2>Pages</h2>
${pageTable}
</section>

<section>
<h2>Link clicks</h2>
${
  clickRows
    ? `<table><tr><th>Target</th><th>Clicks</th><th>Visitors</th><th>% of visitors</th></tr>${clickRows}</table>`
    : '<p class="empty">No clicks logged yet.</p>'
}
</section>

<h2>Audience</h2>
<div class="grid">
<section><h2>Device</h2>${audienceBars(dims.device, envVisitors)}</section>
<section><h2>Browser</h2>${audienceBars(dims.browser, envVisitors)}</section>
<section><h2>Operating system</h2>${audienceBars(dims.os, envVisitors)}</section>
<section><h2>State / region</h2>${audienceBars(dims.region, envVisitors)}</section>
<section><h2>City</h2>${audienceBars(dims.city, envVisitors, 10)}</section>
<section><h2>Language</h2>${audienceBars(dims.lang, envVisitors)}</section>
<section><h2>Viewport width</h2>${audienceBars(dims.width, envVisitors)}</section>
<section><h2>Screen resolution</h2>${audienceBars(dims.res, envVisitors)}</section>
<section><h2>New vs returning</h2>${audienceBars(dims.visit, envVisitors)}</section>
<section><h2>Colour scheme</h2>${audienceBars(dims.scheme, envVisitors)}</section>
<section><h2>Connection</h2>${audienceBars(dims.conn, envVisitors)}</section>
<section><h2>Campaigns (UTM)</h2>${audienceBars(utms, utmVids.size)}</section>
<section><h2>Hour of day (Sydney time)</h2>${byHour.size ? [...byHour].sort((a, b) => a[0].localeCompare(b[0])).map(([h, c]) => statBar(h + ":00", c, Math.max(...byHour.values()))).join("") : '<p class="empty">No data yet.</p>'}</section>
<section><h2>Day of week</h2>${byDow.size ? DOW.filter((d) => byDow.has(d)).map((d) => statBar(d, byDow.get(d), Math.max(...byDow.values()))).join("") : '<p class="empty">No data yet.</p>'}</section>
</div>

<h2 style="margin-top:2rem">Traffic</h2>
<div class="grid">
<section><h2>Top pages</h2>${topPaths.length ? topPaths.map(([p, c]) => statBar(p, c, maxPath)).join("") : '<p class="empty">No pageviews logged yet.</p>'}</section>
<section><h2>Referrers</h2>${topReferrers.length ? topReferrers.map(([r, c]) => statBar(r, c, maxRef)).join("") : '<p class="empty">No referrers logged yet.</p>'}</section>
<section><h2>Countries</h2>${topCountries.length ? topCountries.map(([cc, c]) => statBar(cc, c, maxCty)).join("") : '<p class="empty">No countries logged yet.</p>'}</section>
</div>
<p style="color:var(--mute);font-size:.72rem;margin-top:2rem">Log is permanent, no expiry. Referrer count is session-entry hits only (internal navigation between pages is excluded). Time on page counts visible-tab seconds only, capped at 30 min per flush. Visitors are per browser (cleared storage or a second device counts as a new visitor). Time, scroll and audience data start from when each was deployed; bots are filtered out. Audience figures come from the browser user agent and Cloudflare IP lookup (city is approximate); no IP or raw user agent is stored in the log.</p>
</div></body></html>`;
}

export async function handleAdmin(request, env, url) {
  const password = env.ADMIN_PASSWORD;
  if (!password) {
    return html('<h1 style="font-family:sans-serif;padding:2rem">ADMIN_PASSWORD not set.</h1>', 500);
  }
  if (!env.SITE_STATS) {
    return html('<h1 style="font-family:sans-serif;padding:2rem">SITE_STATS KV binding not configured.</h1>', 500);
  }

  if (request.method === "POST" && url.pathname === "/admin/login") {
    let fd;
    try {
      fd = await request.formData();
    } catch {
      return html(gatePage({ error: "bad-request" }), 400);
    }
    const submitted = (fd.get("password") || "").toString();
    if (timingSafeEqual(submitted, password)) {
      return new Response(null, {
        status: 303,
        headers: {
          Location: "/admin/stats",
          "Set-Cookie": `${ADMIN_COOKIE}=${encodeURIComponent(password)}; Path=/admin; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`,
          "Cache-Control": "no-store",
        },
      });
    }
    return html(gatePage({ error: "wrong" }), 401);
  }

  if (!isAuthed(request, password)) {
    return html(gatePage(), 200);
  }

  if (url.pathname === "/admin/stats" || url.pathname === "/admin" || url.pathname === "/admin/") {
    return html(await statsPage(env), 200);
  }

  return html("<h1>Not found</h1>", 404);
}
