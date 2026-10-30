// Site-wide pageview tracking: device/viewport context, campaign tags, time on
// page, scroll depth, and click tracking for booking, phone, email, social,
// downloads and other outbound links. Fire-and-forget: never blocks or breaks
// the page if /api/track is down.
(function () {
  var isNew = false;

  function visitorId() {
    try {
      var k = "refract_vid";
      var v = localStorage.getItem(k);
      if (!v) {
        v = Math.random().toString(36).slice(2) + Date.now().toString(36);
        localStorage.setItem(k, v);
        isNew = true;
      }
      return v;
    } catch {
      return "anon";
    }
  }

  var vid = visitorId();

  function send(payload) {
    try {
      fetch("/api/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.assign({ path: location.pathname, referrer: document.referrer, visitorId: vid }, payload)),
        keepalive: true,
      }).catch(function () {});
    } catch {}
  }

  function context() {
    var conn = navigator.connection || {};
    var p = new URLSearchParams(location.search);
    return {
      env: {
        sw: screen.width,
        sh: screen.height,
        vw: window.innerWidth,
        dpr: window.devicePixelRatio || 1,
        lang: (navigator.language || "").slice(0, 10),
        touch: navigator.maxTouchPoints > 0,
        scheme: window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
        conn: conn.effectiveType || "",
        returning: !isNew,
      },
      utm: {
        source: p.get("utm_source") || "",
        medium: p.get("utm_medium") || "",
        campaign: p.get("utm_campaign") || "",
      },
    };
  }

  send(Object.assign({ type: "page-view" }, context()));

  function target(a) {
    var href = a.getAttribute("href") || "";
    if (/^tel:/i.test(href)) return "phone";
    if (/^mailto:/i.test(href)) return "email";
    if (/discord.(gg|com)/i.test(href)) return "discord";
    if (/facebook\.com/i.test(href)) return "facebook";
    if (/instagram\.com/i.test(href)) return "instagram";
    if (/maps\.app\.goo\.gl|google\.com\/maps/i.test(href)) return "map";
    if (!/^https?:/i.test(a.href || "")) return "";
    if (/\.(pdf|docx?|xlsx?|zip)(\?|#|$)/i.test(a.pathname || "")) return "download " + a.pathname.split("/").pop();
    if (a.hostname && a.hostname !== location.hostname) return "external " + a.hostname.replace(/^www\./, "");
    return "";
  }

  // Time on page: visible seconds only, flushed whenever the tab is hidden or
  // the page unloads. Each flush sends the delta since the last one, plus the
  // deepest scroll position reached so far when it has grown.
  var shownAt = document.visibilityState === "visible" ? Date.now() : 0;
  var scrollMax = 0;
  var scrollSent = 0;

  function onScroll() {
    var el = document.documentElement;
    var total = Math.max(el.scrollHeight, document.body ? document.body.scrollHeight : 0);
    if (!total) return;
    var pct = Math.min(100, Math.round(((window.scrollY + window.innerHeight) / total) * 10) * 10);
    if (pct > scrollMax) scrollMax = pct;
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  function flush() {
    if (!shownAt) return;
    var secs = Math.round((Date.now() - shownAt) / 1000);
    shownAt = 0;
    if (secs < 1) return;
    var payload = { type: "page-leave", seconds: secs };
    if (scrollMax > scrollSent) {
      payload.scroll = scrollMax;
      scrollSent = scrollMax;
    }
    send(payload);
  }

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flush();
    else if (!shownAt) shownAt = Date.now();
  });
  window.addEventListener("pagehide", flush);

  document.addEventListener(
    "click",
    function (e) {
      var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
      if (!a) return;
      var t = target(a);
      if (t) send({ type: "click", choice: t });
    },
    true
  );
})();
