// User-agent and viewport classification for analytics. Pure functions, no I/O.
// The UA string is parsed once at write time; only the derived labels are
// stored (never the raw UA), so the KV log holds no fingerprintable detail.
const SITE_TZ = "Australia/Sydney";

const BOT_RE =
  /bot|crawl|spider|slurp|facebookexternalhit|preview|headless|lighthouse|pingdom|uptime|monitor|curl|wget|python-requests|node-fetch|axios|go-http|java\//i;

export const isBot = (ua) => !ua || BOT_RE.test(ua);

export function parseBrowser(ua) {
  if (/FBAN|FBAV|FB_IAB/i.test(ua)) return "Facebook app";
  if (/Instagram/i.test(ua)) return "Instagram app";
  if (/EdgA?\/|Edg\//.test(ua)) return "Edge";
  if (/OPR\/|Opera/.test(ua)) return "Opera";
  if (/SamsungBrowser/.test(ua)) return "Samsung Internet";
  if (/FxiOS|Firefox\//.test(ua)) return "Firefox";
  if (/CriOS|Chrome\//.test(ua)) return "Chrome";
  if (/Safari\//.test(ua)) return "Safari";
  return "Other";
}

export function parseOS(ua) {
  if (/Windows/.test(ua)) return "Windows";
  if (/iPhone|iPad|iPod/.test(ua)) return "iOS";
  if (/Android/.test(ua)) return "Android";
  if (/Mac OS X|Macintosh/.test(ua)) return "macOS";
  if (/CrOS/.test(ua)) return "ChromeOS";
  if (/Linux/.test(ua)) return "Linux";
  return "Other";
}

// UA says mobile/tablet when it can; otherwise a touch device narrower than
// 1024px is a tablet, narrower than 600px a phone. iPadOS Safari reports as a
// Mac, so touch + a Mac UA is also a tablet.
export function deviceType(ua, vw, touch) {
  if (/iPad|Tablet/i.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))) return "tablet";
  if (/Mobi|iPhone|iPod/.test(ua)) return "mobile";
  if (touch && /Macintosh/.test(ua)) return "tablet";
  if (touch && vw > 0 && vw < 600) return "mobile";
  if (touch && vw > 0 && vw < 1024) return "tablet";
  return "desktop";
}

export function widthBucket(vw) {
  if (!(vw > 0)) return "?";
  if (vw < 360) return "under 360";
  if (vw < 480) return "360-479";
  if (vw < 768) return "480-767";
  if (vw < 1024) return "768-1023";
  if (vw < 1280) return "1024-1279";
  if (vw < 1600) return "1280-1599";
  return "1600+";
}

export function siteHour(date = new Date()) {
  const h = new Intl.DateTimeFormat("en-AU", { timeZone: SITE_TZ, hour: "2-digit", hourCycle: "h23" }).format(date);
  return String(parseInt(h, 10)).padStart(2, "0");
}

// Key-name-safe label: no ":" (the field delimiter), bounded length.
export function field(v, max = 30) {
  if (v === "?") return "?"; // unknown marker; admin.js skips it
  const s = String(v ?? "").replace(/[^A-Za-z0-9 _.+\-]/g, "_").trim().slice(0, max);
  return s || "?";
}
