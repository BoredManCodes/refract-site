// Page-view + outbound-click tracking. POST /api/track, routed from index.js.
//
// Same trick as most day-bucketed KV analytics: KV has no atomic increment,
// so a shared counter loses writes under concurrent hits. Instead every event
// gets its own never-colliding key and admin.js tallies by listing keys at
// read time. All the dimensions worth counting (path, country, referrer
// bucket, click target) live in the KEY NAME, not the value.
//
//   pv:<date>:<path>:<country>:<vid>:<rand>        one per real page-view
//   ref:<date>:<bucket>:<vid>:<rand>                one per session-entry referrer
//   click:<date>:<target>:<vid>:<rand>              one per booking/phone/email/social click
//   dur:<date>:<path>:<seconds>:<vid>:<rand>        one per visible-time flush on a page
//   scroll:<date>:<path>:<pct>:<vid>:<rand>         deepest scroll reached (10% steps)
//   utm:<date>:<source>:<medium>:<campaign>:<vid>:<rand>   campaign-tagged landing
//   env:<date>:<hour>:<device>:<browser>:<os>:<region>:<city>:<lang>:<width>:<res>:<scheme>:<conn>:<new|ret>:<vid>:<rand>
//                                                  one per page-view, audience context
//
// Bots (UA match) are dropped before anything is written.
//
// Requires:
//   env.SITE_STATS           - KV namespace binding (permanent stats log)
//   env.VISIT_LOGS            - KV namespace binding (live Discord session state)
//   env.DISCORD_WEBHOOK_URL  - Discord webhook URL (secret), optional
//
// Referrer is only logged when it's meaningful: empty/unparseable is
// "direct", and the site's own hostname is internal navigation (every page
// after the first in a session), not a referrer worth reporting, so those
// are skipped. Internal nav falls out of this naturally because the
// client sends document.referrer, which is the site's own URL once a
// visitor has moved past their first page.
import { isBot, parseBrowser, parseOS, deviceType, widthBucket, siteHour, field } from "./ua.js";

const PAGES_PREVIEW_REGEX = /^[a-z0-9-]+\.[a-z0-9-]+\.(pages|workers)\.dev$/;
const OWN_HOSTS = ["refract-smp.com", "www.refract-smp.com"];

const SESSION_TTL_MS = 30 * 60 * 1000; // gap > 30 min -> new session
const KV_TTL_S = 7200; // 2h KV entry lifetime (allows end-session detection)
const SOFT_LIMIT = 1800; // stay under Discord's 2000-char limit

const json = (obj, status = 200) => Response.json(obj, { status });

function refererBucket(referer) {
  if (!referer || referer === "direct") return null;
  let host;
  try {
    host = new URL(referer).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
  if (OWN_HOSTS.includes(host) || OWN_HOSTS.includes("www." + host)) return null;
  if (PAGES_PREVIEW_REGEX.test(host)) return null;
  return host;
}

function safeVid(v) {
  return typeof v === "string" ? v.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "anon" : "anon";
}

function safeStr(v, max) {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : "";
}

export async function handleTrack(request, env, ctx) {
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ ok: false, error: "bad request body" }, 400);
  }

  const type = data.type;
  if (!["page-view", "click", "page-leave"].includes(type)) {
    return json({ ok: false, error: "unknown event type" }, 400);
  }

  if (isBot(request.headers.get("User-Agent") || "")) return json({ ok: true, skipped: "bot" });

  const vid = safeVid(data.visitorId);
  const path = safeStr(data.path, 200) || "/";
  const choice = safeStr(data.choice, 100);
  if (type === "click" && !choice) {
    return json({ ok: false, error: "choice is required" }, 400);
  }

  if (type === "page-leave") {
    // Cap at 30 min so a tab left open overnight can't skew the averages.
    const seconds = Math.min(Math.round(Number(data.seconds)), 1800);
    if (!(seconds >= 1)) return json({ ok: false, error: "seconds is required" }, 400);
    const scroll = Math.round(Number(data.scroll));
    const work = trackDuration(env, { path, vid, seconds, scroll: scroll >= 0 && scroll <= 100 ? scroll : null });
    if (ctx && ctx.waitUntil) ctx.waitUntil(work);
    else await work;
    return json({ ok: true });
  }

  // X-Real-IP / X-Real-Country come from the Caddy reverse proxy on the production server -
  // see the comment in handler.js. request.cf/CF-Connecting-IP alone would describe
  // Caddy's own hop, not the visitor, since the worker is reached through a second
  // Cloudflare proxy step.
  const country = request.headers.get("X-Real-Country") || request.cf?.country || "?";
  const referer = safeStr(data.referrer, 200) || "direct";
  const ua = (request.headers.get("User-Agent") || "?").slice(0, 200);
  const ip = request.headers.get("X-Real-IP") || request.headers.get("CF-Connecting-IP") || "?";

  const e = data.env && typeof data.env === "object" ? data.env : {};
  const vw = Number(e.vw) || 0;
  const touch = e.touch === true;
  const audience = {
    device: deviceType(ua, vw, touch),
    browser: parseBrowser(ua),
    os: parseOS(ua),
    region: request.cf?.region || "?",
    city: request.cf?.city || "?",
    lang: safeStr(e.lang, 10).toLowerCase(),
    width: widthBucket(vw),
    res: Number(e.sw) > 0 && Number(e.sh) > 0 ? `${Math.round(Number(e.sw))}x${Math.round(Number(e.sh))}` : "?",
    scheme: e.scheme === "dark" ? "dark" : "light",
    conn: safeStr(e.conn, 10),
    visit: e.returning === true ? "ret" : "new",
  };
  const utm = data.utm && typeof data.utm === "object" ? data.utm : {};

  const work = trackAnalytics(env, { type, path, country, referer, vid, choice, audience, utm });
  if (ctx && ctx.waitUntil) ctx.waitUntil(work);
  else await work;

  const discordWork = postToDiscord(env, { type, path, choice, country, ip, ua, referer, vid, audience });
  if (ctx && ctx.waitUntil) ctx.waitUntil(discordWork);
  else await discordWork;

  return json({ ok: true });
}

async function trackAnalytics(env, { type, path, country, referer, vid, choice, audience, utm }) {
  if (!env.SITE_STATS) {
    console.warn("SITE_STATS KV binding not configured");
    return;
  }

  const day = new Date().toISOString().slice(0, 10);
  const rand = Math.random().toString(36).slice(2, 10);
  const writes = [];

  if (type === "page-view") {
    const safePath = path.replace(/[^A-Za-z0-9/_.-]/g, "_");
    const safeCountry = (country || "?").replace(/[^A-Za-z]/g, "?").slice(0, 2) || "?";
    writes.push(env.SITE_STATS.put(`pv:${day}:${safePath}:${safeCountry}:${vid}:${rand}`, "1"));
    const bucket = refererBucket(referer);
    if (bucket) writes.push(env.SITE_STATS.put(`ref:${day}:${bucket}:${vid}:${rand}`, "1"));

    const a = audience;
    writes.push(
      env.SITE_STATS.put(
        ["env", day, siteHour(), a.device, a.browser, a.os, ...[a.region, a.city, a.lang, a.width, a.res, a.scheme, a.conn, a.visit].map((v) => field(v)), vid, rand].join(":"),
        "1"
      )
    );
    const source = safeStr(utm.source, 40);
    if (source) {
      writes.push(
        env.SITE_STATS.put(`utm:${day}:${field(source)}:${field(safeStr(utm.medium, 40))}:${field(safeStr(utm.campaign, 40))}:${vid}:${rand}`, "1")
      );
    }
  } else {
    const safeChoice = choice.replace(/[^A-Za-z0-9 _.-]/g, "_");
    writes.push(env.SITE_STATS.put(`click:${day}:${safeChoice}:${vid}:${rand}`, "1"));
  }

  try {
    await Promise.all(writes);
  } catch (err) {
    console.error("trackAnalytics KV write error:", err.message || err);
  }
}

async function trackDuration(env, { path, vid, seconds, scroll }) {
  if (!env.SITE_STATS) return;
  const day = new Date().toISOString().slice(0, 10);
  const rand = Math.random().toString(36).slice(2, 10);
  const safePath = path.replace(/[^A-Za-z0-9/_.-]/g, "_");
  try {
    const writes = [env.SITE_STATS.put(`dur:${day}:${safePath}:${seconds}:${vid}:${rand}`, "1")];
    if (scroll != null) writes.push(env.SITE_STATS.put(`scroll:${day}:${safePath}:${scroll}:${vid}:${rand}`, "1"));
    await Promise.all(writes);
  } catch (err) {
    console.error("trackDuration KV write error:", err.message || err);
  }
}

function labelFor({ type, path, choice }) {
  if (type === "page-view") return `visited \`${path}\``;
  return `clicked "${choice}"`;
}

function formatDelta(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `*${s} seconds later*`;
  if (s < 3600) return `*${Math.round(s / 60)} minutes later*`;
  return `*${Math.round(s / 3600)} hours later*`;
}

// ── Live per-visitor Discord timeline ───────────────────────────────
// Builds a Discord message and edits it as the visitor navigates or
// clicks a tracked link. Sessions expire after SESSION_TTL_MS of
// inactivity; the final message gets a "session ended" line appended.
async function postToDiscord(env, { type, path, choice, country, ip, ua, referer, vid, audience }) {
  if (!env.DISCORD_WEBHOOK_URL) return;
  if (!env.VISIT_LOGS) {
    console.warn("VISIT_LOGS KV binding not configured");
    return;
  }

  const webhook = env.DISCORD_WEBHOOK_URL;
  const now = Date.now();
  const key = "refract:vis:" + vid;
  const label = labelFor({ type, path, choice });

  let state = null;
  try {
    const raw = await env.VISIT_LOGS.get(key);
    if (raw) state = JSON.parse(raw);
  } catch (err) {
    console.error("KV read error:", err.message || err);
  }

  if (state && now - state.lastTime >= SESSION_TTL_MS) {
    const endedContent = state.header + "\n" + [...state.lines, "*session ended*"].join("\n");
    if (endedContent.length <= 2000) {
      fetch(webhook + "/messages/" + state.messageId, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: endedContent }),
      }).catch(() => {});
    }
    state = null;
  }

  const header = [
    `**visit** \`${vid.slice(0, 8)}\` · ${country} · \`${ip}\``,
    `${audience.device} · ${audience.browser} · ${audience.os} · ${audience.city}, ${audience.region}`,
    `ua: \`${ua}\``,
    `ref: \`${referer}\``,
    "─".repeat(36),
  ].join("\n");

  if (!state) {
    const lines = [label];
    const content = header + "\n" + lines.join("\n");
    try {
      const res = await fetch(webhook + "?wait=true", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "refract-visits", content }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return console.error("Discord POST failed:", res.status);
      const msg = await res.json();
      await env.VISIT_LOGS.put(
        key,
        JSON.stringify({ messageId: msg.id, lines, lastTime: now, header }),
        { expirationTtl: KV_TTL_S }
      );
    } catch (err) {
      console.error("track new-session error:", err.message || err);
    }
    return;
  }

  const deltaLine = formatDelta(now - state.lastTime);
  const newLines = [...state.lines, deltaLine, label];
  const candidate = state.header + "\n" + newLines.join("\n");

  if (candidate.length <= SOFT_LIMIT) {
    try {
      const res = await fetch(webhook + "/messages/" + state.messageId, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: candidate }),
        signal: AbortSignal.timeout(5_000),
      });
      if (res.status === 404) {
        await env.VISIT_LOGS.delete(key).catch(() => {});
        return;
      }
      await env.VISIT_LOGS.put(key, JSON.stringify({ ...state, lines: newLines, lastTime: now }), {
        expirationTtl: KV_TTL_S,
      });
    } catch (err) {
      console.error("track PATCH error:", err.message || err);
    }
    return;
  }

  const contLines = [deltaLine, label];
  const contContent = state.header + " *(cont.)*\n" + contLines.join("\n");
  try {
    const res = await fetch(webhook + "?wait=true", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "refract-visits", content: contContent }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return console.error("Discord cont POST failed:", res.status);
    const msg = await res.json();
    await env.VISIT_LOGS.put(key, JSON.stringify({ ...state, messageId: msg.id, lines: contLines, lastTime: now }), {
      expirationTtl: KV_TTL_S,
    });
  } catch (err) {
    console.error("track overflow error:", err.message || err);
  }
}
