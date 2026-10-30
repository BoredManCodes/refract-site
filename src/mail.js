import PostalMime from "postal-mime";

// Catch-all mail <-> Discord. Inbound mail lands in a channel as an embed with a Reply button;
// the button opens a modal and the reply goes out through SMTP2GO, threaded to the original.

const DISCORD = "https://discord.com/api/v10";
const MAIL_TTL = 30 * 86400;
const FALLBACK_FROM = "contact@refract-smp.com";

const randomId = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

const htmlToText = (html) =>
  html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const discord = (env, path, body) =>
  fetch(DISCORD + path, {
    method: "POST",
    headers: { authorization: "Bot " + env.DISCORD_BOT_TOKEN, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });

// ---------- inbound ----------

export async function handleEmail(message, env) {
  const mail = await PostalMime.parse(await new Response(message.raw).arrayBuffer());
  const from = mail.from?.address || message.from;
  const text = (mail.text || (mail.html ? htmlToText(mail.html) : "")).trim() || "(empty body)";
  const subject = mail.subject || "(no subject)";
  const id = randomId();

  await env.STATUS.put(
    "mail:" + id,
    JSON.stringify({
      from,
      to: message.to,
      subject,
      messageId: mail.messageId || null,
      references: mail.references || null,
    }),
    { expirationTtl: MAIL_TTL },
  );

  const files = mail.attachments?.length || 0;
  const res = await discord(env, `/channels/${env.MAIL_CHANNEL_ID}/messages`, {
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: clip(subject, 256),
        description: clip(text, 3900),
        color: 0x5865f2,
        author: { name: clip(mail.from?.name ? `${mail.from.name} <${from}>` : from, 256) },
        footer: { text: `To: ${message.to}` + (files ? ` | ${files} attachment${files > 1 ? "s" : ""} not shown` : "") },
        timestamp: new Date().toISOString(),
      },
    ],
    components: [{ type: 1, components: [{ type: 2, style: 1, label: "Reply", custom_id: "mail_reply:" + id }] }],
  });
  if (!res.ok) throw new Error("Discord post failed: " + res.status + " " + (await res.text()));
}

// ---------- Discord interactions (Reply button + modal) ----------

function hexToBytes(h) {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function verified(req, raw, env) {
  const sig = req.headers.get("x-signature-ed25519");
  const ts = req.headers.get("x-signature-timestamp");
  if (!sig || !ts || !env.DISCORD_PUBLIC_KEY) return false;
  try {
    const key = await crypto.subtle.importKey("raw", hexToBytes(env.DISCORD_PUBLIC_KEY), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, hexToBytes(sig), new TextEncoder().encode(ts + raw));
  } catch {
    return false;
  }
}

const reply = (obj) =>
  new Response(JSON.stringify(obj), { headers: { "content-type": "application/json" } });
const ephemeral = (content) => reply({ type: 4, data: { content, flags: 64 } });

async function sendMail(env, entry, body) {
  const from = entry.to.toLowerCase().endsWith("@refract-smp.com") ? entry.to : FALLBACK_FROM;
  const custom_headers = [{ header: "Reply-To", value: from }];
  if (entry.messageId) {
    custom_headers.push({ header: "In-Reply-To", value: entry.messageId });
    custom_headers.push({ header: "References", value: [entry.references, entry.messageId].filter(Boolean).join(" ") });
  }
  return fetch("https://api.smtp2go.com/v3/email/send", {
    method: "POST",
    headers: { "x-smtp2go-api-key": env.SMTP2GO_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      sender: `Refract SMP <${from}>`,
      to: [entry.from],
      subject: /^re:/i.test(entry.subject) ? entry.subject : "Re: " + entry.subject,
      text_body: body,
      custom_headers,
    }),
    signal: AbortSignal.timeout(10000),
  });
}

export async function handleInteraction(req, env) {
  const raw = await req.text();
  if (!(await verified(req, raw, env))) return new Response("bad signature", { status: 401 });
  const i = JSON.parse(raw);

  if (i.type === 1) return reply({ type: 1 });

  if (i.type === 3 && i.data?.custom_id?.startsWith("mail_reply:")) {
    const id = i.data.custom_id.slice(11);
    const entry = await env.STATUS.get("mail:" + id, "json");
    if (!entry) return ephemeral("This email expired (30 days). Reply from your mail client.");
    return reply({
      type: 9,
      data: {
        custom_id: "mail_send:" + id,
        title: clip("Reply to " + entry.from, 45),
        components: [
          { type: 1, components: [{ type: 4, custom_id: "body", style: 2, label: "Message", required: true, max_length: 3500 }] },
        ],
      },
    });
  }

  if (i.type === 5 && i.data?.custom_id?.startsWith("mail_send:")) {
    const id = i.data.custom_id.slice(10);
    const entry = await env.STATUS.get("mail:" + id, "json");
    if (!entry) return ephemeral("This email expired (30 days). Reply from your mail client.");
    const body = i.data.components?.[0]?.components?.[0]?.value?.trim();
    if (!body) return ephemeral("Empty reply, nothing sent.");
    let r;
    try { r = await sendMail(env, entry, body); } catch { return ephemeral("Mail provider timed out. Nothing sent."); }
    if (!r.ok) return ephemeral("Mail provider rejected it: " + clip(await r.text(), 300));
    const user = i.member?.user || i.user;
    return reply({
      type: 4,
      data: {
        allowed_mentions: { parse: [] },
        embeds: [
          {
            title: clip("Re: " + entry.subject, 256),
            description: clip(body, 3900),
            color: 0x57f287,
            author: { name: "Reply to " + entry.from },
            footer: { text: `Sent by ${user.username} from ${entry.to}` },
          },
        ],
      },
    });
  }

  return ephemeral("Unknown action.");
}
