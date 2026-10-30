import { handleTrack } from "./analytics/track.js";
import { handleAdmin } from "./analytics/admin.js";
import { handleEmail, handleInteraction } from "./mail.js";

const JSON_HEADERS = { "content-type": "application/json", "x-content-type-options": "nosniff", "cache-control": "no-store" };
const SESSION_TTL = 7 * 86400;
const DISCORD = "https://discord.com/api/v10";

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { ...JSON_HEADERS, ...extra } });

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));

function cookie(req, name) {
  const m = (req.headers.get("cookie") || "").match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
  return m ? m[1] : null;
}

const setCookie = (name, value, maxAge, path = "/") =>
  `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

async function session(req, env) {
  const sid = cookie(req, "sid");
  if (!sid || !/^[a-f0-9]{64}$/.test(sid)) return null;
  const data = await env.STATUS.get("sess:" + sid, "json");
  return data ? { sid, ...data } : null;
}

const sameOrigin = (req) => req.headers.get("origin") === new URL(req.url).origin;
const oauthReady = (env) => Boolean(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET);

// ---------- bot status (the Worker asks the bot) ----------

const bot = (env, path, init = {}, ms = 5000) =>
  fetch(env.BOT_URL + path, {
    ...init,
    headers: { authorization: "Bearer " + env.BOT_API_TOKEN, "content-type": "application/json" },
    signal: AbortSignal.timeout(ms),
  });

async function status(req, env) {
  if (req.method !== "GET") return json({ error: "method" }, 405, { allow: "GET" });
  const extra = { address: env.SERVER_ADDRESS || null, version: env.SERVER_VERSION || null };
  const last = await env.STATUS.get("status", "json"); // { at, data }
  if (last && Date.now() - last.at < 30000) return json({ ...last.data, ...extra }, 200, { "cache-control": "public, max-age=15" });
  try {
    const r = await bot(env, "/status");
    if (!r.ok) throw new Error("bot " + r.status);
    const data = await r.json();
    data.updated = data.generated;
    await env.STATUS.put("status", JSON.stringify({ at: Date.now(), data }));
    return json({ ...data, ...extra }, 200, { "cache-control": "public, max-age=15" });
  } catch {
    // bot or tunnel down: serve the last good copy; its old "updated" time shows on the page
    return json({ ...(last ? last.data : {}), ...extra }, 200, { "cache-control": "no-store" });
  }
}

// ---------- Discord sign-in ----------

async function login(req, env) {
  if (!oauthReady(env)) return json({ error: "sign-in not configured" }, 503);
  const url = new URL(req.url);
  const state = randomHex(16);
  const auth = new URL("https://discord.com/oauth2/authorize");
  auth.search = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    response_type: "code",
    scope: "identify",
    redirect_uri: url.origin + "/auth/callback",
    state,
  }).toString();
  return new Response(null, {
    status: 302,
    headers: { location: auth.toString(), "set-cookie": setCookie("oauth_state", state, 600, "/auth"), "cache-control": "no-store" },
  });
}

async function callback(req, env) {
  if (!oauthReady(env)) return json({ error: "sign-in not configured" }, 503);
  const url = new URL(req.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const clear = setCookie("oauth_state", "", 0, "/auth");
  const back = () => new Response(null, { status: 302, headers: { location: "/#staff", "set-cookie": clear } });
  if (!code || !state || state !== cookie(req, "oauth_state")) return back();
  const tokenRes = await fetch(DISCORD + "/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: url.origin + "/auth/callback",
    }),
  });
  if (!tokenRes.ok) return back();
  const { access_token } = await tokenRes.json();
  const meRes = await fetch(DISCORD + "/users/@me", { headers: { authorization: "Bearer " + access_token } });
  if (!meRes.ok) return back();
  const me = await meRes.json();
  const sid = randomHex(32);
  await env.STATUS.put(
    "sess:" + sid,
    JSON.stringify({
      id: me.id,
      name: me.global_name || me.username,
      username: me.username,
      avatar: me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=64` : null,
    }),
    { expirationTtl: SESSION_TTL },
  );
  const headers = new Headers({ location: "/#staff", "cache-control": "no-store" });
  headers.append("set-cookie", clear);
  headers.append("set-cookie", setCookie("sid", sid, SESSION_TTL));
  return new Response(null, { status: 302, headers });
}

async function logout(req, env) {
  if (req.method !== "POST" || !sameOrigin(req)) return json({ error: "bad request" }, 400);
  const s = await session(req, env);
  if (s) await env.STATUS.delete("sess:" + s.sid);
  return json({ ok: true }, 200, { "set-cookie": setCookie("sid", "", 0) });
}

async function me(req, env) {
  const s = await session(req, env);
  return json({ configured: oauthReady(env), user: s ? { name: s.name, avatar: s.avatar } : null });
}

// ---------- staff applications ----------

async function apply(req, env) {
  if (req.method !== "POST") return json({ error: "method" }, 405, { allow: "POST" });
  if (!sameOrigin(req)) return json({ error: "bad origin" }, 403);
  const s = await session(req, env);
  if (!s) return json({ error: "Sign in with Discord first." }, 401);
  const raw = await req.text();
  if (raw.length > 8192) return json({ error: "Too long." }, 413);
  let f;
  try { f = JSON.parse(raw); } catch { return json({ error: "Bad request." }, 400); }
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  const mc = str(f.mc), why = str(f.why), exp = str(f.exp), hours = str(f.hours);
  if (!/^[A-Za-z0-9_]{3,16}$/.test(mc)) return json({ error: "Enter a valid Minecraft username (3 to 16 letters, numbers or underscores)." }, 400);
  if (!why || why.length > 1000) return json({ error: "Tell us why you want to be staff (up to 1000 characters)." }, 400);
  if (exp.length > 1000) return json({ error: "Experience must be 1000 characters or fewer." }, 400);
  if (!hours || hours.length > 50) return json({ error: "Enter your weekly hours (up to 50 characters)." }, 400);
  if (await env.STATUS.get("rate:" + s.id)) return json({ error: "Please wait a few minutes before applying again." }, 429);

  let r;
  try {
    r = await bot(env, "/applications", { method: "POST", body: JSON.stringify({ user_id: s.id, username: s.username, mc, why, exp, hours }) }, 15000);
  } catch {
    return json({ error: "The bot is offline right now. Try again in a few minutes, or use /apply in Discord." }, 502);
  }
  const out = await r.json().catch(() => ({}));
  if (!r.ok) return json({ error: out.error || "Could not send the application." }, r.status === 409 ? 409 : 502);
  await env.STATUS.put("rate:" + s.id, "1", { expirationTtl: 300 });
  return json({ ok: true });
}

export default {
  async fetch(req, env, ctx) {
    const { pathname } = new URL(req.url);
    if (pathname === "/api/track") return req.method === "POST" ? handleTrack(req, env, ctx) : json({ error: "method" }, 405, { allow: "POST" });
    if (pathname.startsWith("/admin")) return handleAdmin(req, env, new URL(req.url));
    if (pathname === "/api/status") return status(req, env);
    if (pathname === "/api/me") return me(req, env);
    if (pathname === "/api/apply") return apply(req, env);
    if (pathname === "/api/discord/interactions" && req.method === "POST") return handleInteraction(req, env);
    if (pathname === "/auth/login") return login(req, env);
    if (pathname === "/auth/callback") return callback(req, env);
    if (pathname === "/auth/logout") return logout(req, env);
    if (pathname.startsWith("/api/")) return json({ error: "not found" }, 404);
    return env.ASSETS.fetch(req);
  },
  email: (message, env) => handleEmail(message, env),
};
