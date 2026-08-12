interface Env {
  DB: D1Database;
  SYNC_QUEUE: Queue<SyncJob>;
  TELEGRAM_BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  CREDENTIAL_KEY: string;
  TELEMETRY_DISABLED?: string;
  TELEMETRY_COLLECTOR?: string;
}

type SyncRequestJob = {
  kind?: "sync";
  chatId: number;
  manual?: boolean;
  initial?: boolean;
  assignmentRefresh?: boolean;
  enqueuedAt?: string;
};

type SyncResultJob = {
  kind: "sync-result";
  chatId: number;
  initial?: boolean;
};

type SyncCourseJob = {
  kind: "sync-course";
  chatId: number;
  runId: string;
  position: number;
  manual?: boolean;
  initial?: boolean;
  enqueuedAt: string;
};

type SyncFinalizeJob = {
  kind: "sync-finalize";
  chatId: number;
  runId: string;
  manual?: boolean;
  initial?: boolean;
  enqueuedAt: string;
};

type SyncJob = SyncRequestJob | SyncResultJob | SyncCourseJob | SyncFinalizeJob;

type VolpSession = { token: string; uid: string };
type Assignment = {
  key: string;
  title: string;
  course: string;
  type: string;
  dueAt: Date;
  submitted: boolean;
};
const BASE_HEADERS: Record<string, string> = {
  Accept: "application/json, text/plain, */*",
  "Content-Type": "application/json;charset=utf-8",
  "organization-code": "null",
  device: "Web",
  Origin: "https://classroom.volp.in",
  Referer: "https://classroom.volp.in/"
};
const DEFAULT_REMINDER_HOURS = 1;
const REMINDER_HOUR_OPTIONS = Array.from({ length: 10 }, (_, index) => index + 1);
const SYNC_INTERVAL_MS = 3 * 60 * 60_000;
const SYNC_DISPATCH_GRACE_MS = 5 * 60_000;
const MISSING_ASSIGNMENT_GRACE_MS = 24 * 60 * 60_000;
const MAX_CONNECTED_ACCOUNTS = 90;
const REPOSITORY_URL = "https://github.com/nemesis0007/volp-telegram-reminder-bot";
const BOT_VERSION = "1.5.7";
const TELEMETRY_ORIGIN = "https://volp-telegram-reminder-bot.nirajbots.workers.dev";
const TELEMETRY_ENDPOINT = `${TELEMETRY_ORIGIN}/telemetry/v1`;
const TELEMETRY_INTERVAL_MS = 24 * 60 * 60_000;
const MAX_TELEMETRY_INSTALLATIONS = 10_000;
const MISSED_ASSIGNMENT_RETENTION_MS = 45 * 24 * 60 * 60_000;
const VOLP_MAINTENANCE_END_MINUTE_IST = 6 * 60 + 30;
const VOLP_MAINTENANCE_MESSAGE =
  "🌙 VOLP is unavailable for scheduled maintenance from 12:00 AM to 6:30 AM. I’ll sync automatically after 6:30 AM.";

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

function telemetryIsDisabled(env: Env) {
  return String(env.TELEMETRY_DISABLED ?? "").toLowerCase() === "true";
}

async function collectUsageTelemetry(request: Request, env: Env) {
  const raw = await request.text();
  if (raw.length > 2_048) return json({ error: "Payload too large" }, 413);
  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const installationId = String(body.installationId ?? "");
  const version = String(body.version ?? "");
  const userCount = Number(body.userCount);
  const connectedUserCount = Number(body.connectedUserCount);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(installationId) ||
    !/^[0-9A-Za-z._-]{1,40}$/.test(version) ||
    !Number.isInteger(userCount) ||
    !Number.isInteger(connectedUserCount) ||
    userCount < 0 ||
    userCount > 100_000 ||
    connectedUserCount < 0 ||
    connectedUserCount > userCount
  ) {
    return json({ error: "Invalid telemetry payload" }, 400);
  }
  const now = new Date().toISOString();
  const stored = await env.DB.prepare(
    `INSERT INTO telemetry_installations(
       installation_id,first_seen_at,last_seen_at,version,user_count,connected_user_count
     )
     SELECT ?,?,?,?,?,?
     WHERE EXISTS(
       SELECT 1 FROM telemetry_installations WHERE installation_id=?
     ) OR (
       SELECT COUNT(*) FROM telemetry_installations
     ) < ?
     ON CONFLICT(installation_id) DO UPDATE SET
       last_seen_at=excluded.last_seen_at,
       version=excluded.version,
       user_count=excluded.user_count,
       connected_user_count=excluded.connected_user_count`
  ).bind(
    installationId,
    now,
    now,
    version,
    userCount,
    connectedUserCount,
    installationId,
    MAX_TELEMETRY_INSTALLATIONS
  ).run();
  if (stored.meta.changes !== 1) {
    return json({ error: "Telemetry capacity reached" }, 503);
  }
  return new Response(null, { status: 204 });
}

async function sendUsageTelemetry(env: Env) {
  if (telemetryIsDisabled(env)) return;
  let state = await env.DB.prepare(
    "SELECT installation_id,last_sent_at FROM telemetry_state WHERE singleton=1"
  ).first<{ installation_id: string; last_sent_at: string | null }>();
  if (!state) {
    const installationId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO telemetry_state(singleton,installation_id,last_sent_at) VALUES(1,?,NULL)"
    ).bind(installationId).run();
    state = await env.DB.prepare(
      "SELECT installation_id,last_sent_at FROM telemetry_state WHERE singleton=1"
    ).first<{ installation_id: string; last_sent_at: string | null }>();
  }
  if (!state) return;
  const lastSent = state.last_sent_at ? new Date(state.last_sent_at).getTime() : 0;
  if (Date.now() - lastSent < TELEMETRY_INTERVAL_MS) return;
  const counts = await env.DB.prepare(
    `SELECT COUNT(*) AS user_count,
            SUM(CASE WHEN va.chat_id IS NOT NULL THEN 1 ELSE 0 END) AS connected_user_count
     FROM users u LEFT JOIN volp_accounts va ON va.chat_id=u.chat_id`
  ).first<{ user_count: number; connected_user_count: number | null }>();
  const telemetryRequest = new Request(TELEMETRY_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      installationId: state.installation_id,
      version: BOT_VERSION,
      userCount: counts?.user_count ?? 0,
      connectedUserCount: counts?.connected_user_count ?? 0
    })
  });
  const response = String(env.TELEMETRY_COLLECTOR ?? "").toLowerCase() === "true"
    ? await collectUsageTelemetry(telemetryRequest, env)
    : await fetch(telemetryRequest, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Telemetry collector returned ${response.status}`);
  await env.DB.prepare(
    "UPDATE telemetry_state SET last_sent_at=? WHERE singleton=1 AND installation_id=?"
  ).bind(new Date().toISOString(), state.installation_id).run();
}

function html(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline' https://telegram.org; connect-src 'self' https://admin.volp.in; form-action 'self'; base-uri 'none'; frame-ancestors https://telegram.org https://*.telegram.org"
    }
  });
}

function page(content: string) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="#424093"><title>Connect to VOLP</title><link href="https://fonts.googleapis.com/icon?family=Material+Icons" rel="stylesheet"><style>
  :root{color-scheme:light;--volp:#49459b;--blue:#0b0c91;--accent:#eca918;--ink:#252525;--muted:#767676;--field:#e8f0fc;--panel:#e7e7e9}
  *{box-sizing:border-box}body{min-height:100vh;margin:0;color:var(--ink);font:16px/1.5 Roboto,Arial,sans-serif}.shell{min-height:100vh;display:grid;grid-template-columns:1fr 1fr;background:#fff}
  .brand-panel{position:relative;display:flex;align-items:center;justify-content:center;background:var(--panel)}.tile-logo{width:min(25vw,230px);height:min(20.5vw,188px);display:grid;grid-template-columns:1fr 1fr;align-content:center;justify-items:center;padding:18px 34px 20px;border-radius:10px;background:var(--volp);color:#fff;font-size:clamp(52px,5.6vw,80px);font-weight:900;line-height:.77;letter-spacing:-.08em;transform:translate(-.45vw,-13.4vh);box-shadow:0 1px 1px rgba(0,0,0,.08)}.tile-logo .gold{color:var(--accent)}
  main{display:flex;align-items:flex-start;justify-content:center;padding:clamp(64px,11.5vh,110px) clamp(24px,5vw,90px) 48px}.form-column{width:min(100%,468px)}.top-wordmark{text-align:center;color:var(--blue);font-size:clamp(40px,4vw,47px);font-weight:900;line-height:1;letter-spacing:.02em}.top-wordmark .gold{color:var(--accent)}
  .signin-title{margin:18px 0 43px;text-align:center;color:var(--blue);font-size:21px;font-weight:800;line-height:1}.signin-title span{color:var(--accent)}form{margin:0}.field-row{display:grid;grid-template-columns:34px minmax(0,1fr) 29px;align-items:end}.field-row+.field-row{margin-top:34px}.field-row label{display:block}.field-row input{width:100%;height:33px;padding:6px 1px;border:0;border-bottom:1px solid #aaa;border-radius:0;background:var(--field);color:#171717;font:16px/1.2 Roboto,Arial,sans-serif;outline:0}.field-row input:focus{border-bottom:2px solid var(--volp);box-shadow:0 3px 0 rgba(73,69,155,.1)}.field-row input::placeholder{color:#888}.sr-only{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}
  .material-icons{font-family:'Material Icons';font-weight:normal;font-style:normal;line-height:1;letter-spacing:normal;text-transform:none;white-space:nowrap;word-wrap:normal;direction:ltr;-webkit-font-feature-settings:'liga';-webkit-font-smoothing:antialiased;font-feature-settings:'liga'}.field-icon{width:27px;height:33px;display:grid;place-items:center;color:#7d7d7d;font-size:23px}
  .eye-toggle{width:29px;height:33px;display:grid;place-items:center;margin:0;border:0;background:transparent;color:#7d7d7d;cursor:pointer}.eye-toggle .material-icons{font-size:24px}.eye-toggle[aria-pressed="false"] .visibility-off,.eye-toggle[aria-pressed="true"] .visibility-on{display:none}.eye-toggle:focus-visible{outline:3px solid rgba(236,169,24,.45);outline-offset:1px}
  .submit-button{width:100%;margin:50px 0 0;padding:10px 16px;border:0;border-radius:24px;background:var(--volp);box-shadow:0 2px 4px rgba(37,37,37,.28);color:#fff;font:800 15px/1.2 Roboto,Arial,sans-serif;letter-spacing:.03em;cursor:pointer}.submit-button:hover{background:#3f3b8b}.submit-button:focus-visible{outline:3px solid rgba(236,169,24,.5);outline-offset:3px}.submit-button:disabled{cursor:wait;opacity:.68}.status{min-height:18px;margin:10px 0 0;text-align:center}.note{color:var(--muted);font-size:13px}.error{color:#b42318;font-weight:700}.forgot{display:block;margin:38px 0 0;text-align:center;color:#2f2a9c;font-size:16px;text-decoration:none}.forgot:hover{text-decoration:underline}.support-copy{margin-top:36px;text-align:center}.support-copy p{margin:0;color:#777;font-size:15px;letter-spacing:.08em}.support-copy .cache-note{display:inline-block;margin-top:10px;padding:0 2px;background:#fff96d;color:#8e8a32;font-size:12px;font-style:italic;letter-spacing:0}.state-card{padding-top:42px;text-align:center}.state-card h1{margin:12px 0;color:var(--blue);font-size:28px}.state-card .lede{color:var(--muted)}.state-icon{display:grid;width:48px;height:48px;margin:0 auto 18px;place-items:center;border-radius:50%;background:#eeedf8;color:var(--volp);font-size:22px}.success .state-icon{background:#e8f7ef;color:#087443}
  @media(max-width:760px){body,.shell{min-height:100dvh}.shell{display:block}.brand-panel{display:none}main{min-height:100dvh;padding:105px 28px 48px}.form-column{width:100%;max-width:520px}.top-wordmark{font-size:43px;letter-spacing:.015em}.signin-title{margin:20px 0 52px;font-size:21px}.field-row{grid-template-columns:34px minmax(0,1fr) 34px}.field-row+.field-row{margin-top:34px}.field-row input{height:36px;padding:6px 0;background:transparent;font-size:16px}.field-icon{width:28px;height:36px;font-size:24px}.eye-toggle{width:34px;height:36px}.eye-toggle .material-icons{font-size:26px}.submit-button{margin-top:50px;padding:11px 16px;border-radius:24px;font-size:15px;font-weight:500;letter-spacing:.08em}.status{margin-top:10px}.forgot{margin-top:42px;font-size:17px}.support-copy{margin-top:38px}.support-copy p{font-size:15px}.support-copy .cache-note{margin-top:10px;font-size:12px;line-height:1.35}}
  @media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
  </style><script src="https://telegram.org/js/telegram-web-app.js"></script></head><body><div class="shell"><aside class="brand-panel" aria-label="VOLP Assignment Reminder">
    <div class="tile-logo" aria-hidden="true"><span>V</span><span class="gold">O</span><span>L</span><span>P</span></div>
  </aside><main><div class="form-column"><div class="top-wordmark" aria-label="VOLP"><span>V</span><span class="gold">O</span><span>LP</span></div><div id="page-content">${content}</div></div></main></div></body></html>`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function truncate(value: string, maximum: number) {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1).trimEnd()}…`;
}

function decodeHtmlEntities(value: string) {
  const named: Record<string, string> = {
    amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"',
    rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“"
  };
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    if (code[0] === "#") {
      const number = code[1]?.toLowerCase() === "x"
        ? Number.parseInt(code.slice(2), 16)
        : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(number) ? String.fromCodePoint(number) : entity;
    }
    return named[code.toLowerCase()] ?? entity;
  });
}

function stripHtml(value: unknown) {
  return decodeHtmlEntities(String(value ?? "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function trueVolpFlag(value: unknown) {
  if (value === true || value === 1) return true;
  if (typeof value !== "string") return false;
  return ["1", "true", "yes", "submitted", "completed", "evaluated", "uploaded"]
    .includes(value.trim().toLowerCase());
}

function completeVolpPercentage(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) && value >= 100;
  if (typeof value !== "string") return false;
  const parsed = Number.parseFloat(value.replace("%", "").trim());
  return Number.isFinite(parsed) && parsed >= 100;
}

function handsOnSubmitted(item: any) {
  const filePath = item.filePath ?? item.filepath ?? item.file_path ?? item.uploaded_file;
  if (typeof filePath === "string" && filePath.trim()) return true;
  if ([
    item.isevaluated, item.isEvaluated, item.issubmitted, item.isSubmitted,
    item.is_submitted, item.submitted, item.isuploaded, item.isUploaded
  ].some(trueVolpFlag)) return true;
  if ([item.status, item.submission_status, item.assignment_status].some(trueVolpFlag)) return true;
  return [
    item.progress, item.percentage, item.percent, item.completion_percentage,
    item.assignment_percentage, item.submission_percentage
  ].some(completeVolpPercentage);
}

function istDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number
) {
  if (
    month < 1 || month > 12 || day < 1 || day > 31 ||
    hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59
  ) return null;
  const wallClock = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    wallClock.getUTCFullYear() !== year || wallClock.getUTCMonth() !== month - 1 ||
    wallClock.getUTCDate() !== day || wallClock.getUTCHours() !== hour ||
    wallClock.getUTCMinutes() !== minute || wallClock.getUTCSeconds() !== second
  ) return null;
  return new Date(wallClock.getTime() - 330 * 60_000);
}

function parseDueDate(value: unknown): Date | null {
  if (!value) return null;
  const raw = String(value).trim();
  const volp = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:\s*,?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i);
  if (volp) {
    const first = Number(volp[1]);
    const second = Number(volp[2]);
    if (first > 12 && second > 12) return null;
    // VOLP's API normally emits month/day/year, while a few endpoints emit
    // day/month/year. An unambiguous value above 12 identifies the day;
    // ambiguous values retain the API's established month-first behavior.
    const day = first > 12 ? first : second;
    const month = first > 12 ? second : first;
    let hour = Number(volp[4] ?? 23);
    const marker = volp[7]?.toUpperCase();
    if (marker && (hour < 1 || hour > 12)) return null;
    if (marker === "PM" && hour < 12) hour += 12;
    if (marker === "AM" && hour === 12) hour = 0;
    return istDate(
      Number(volp[3]), month, day,
      hour, Number(volp[5] ?? 59), Number(volp[6] ?? 0)
    );
  }

  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/i);
  if (!iso) return null;
  if (iso[7]) {
    const direct = new Date(raw);
    return Number.isNaN(direct.getTime()) ? null : direct;
  }
  return istDate(
    Number(iso[1]), Number(iso[2]), Number(iso[3]),
    Number(iso[4] ?? 23), Number(iso[5] ?? 59), Number(iso[6] ?? 0)
  );
}

function volpHeaders(session?: VolpSession, route = "/") {
  return {
    ...BASE_HEADERS,
    "router-path": route,
    ...(session ? { token: session.token, uid: session.uid, ut: "Learner" } : {})
  };
}

async function postVolp(url: string, body: unknown, session?: VolpSession, route?: string) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: volpHeaders(session, route),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000)
      });
      if (response.ok) {
        const data = await response.json<any>();
        const status = String(data?.status ?? "");
        if (session && status === "100" && data.token) session.token = String(data.token);
        if (status === "401") throw new Error("VOLP session expired. Use /connect to reconnect.");
        if (status === "402") throw new Error("VOLP organization is not configured");
        if (status === "405") throw new Error("VOLP access denied");
        if (status === "406") throw new Error("VOLP tenant was not found");
        return data;
      }
      if (attempt === 0 && [429, 502, 503, 504].includes(response.status)) {
        await delay(500);
        continue;
      }
      throw new Error(`VOLP request failed (${response.status})`);
    } catch (error) {
      if (attempt === 0 && error instanceof Error && error.name === "TimeoutError") {
        await delay(500);
        continue;
      }
      throw error;
    }
  }
  throw new Error("VOLP request failed");
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function credentialKey(secret: string) {
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptSecret(value: string, secret: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await credentialKey(secret), new TextEncoder().encode(value));
  return `${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(cipher))}`;
}

async function decryptSecret(value: string, secret: string) {
  const [iv, cipher] = value.split(".");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(iv) }, await credentialKey(secret), base64ToBytes(cipher));
  return new TextDecoder().decode(plain);
}

async function telegram(env: Env, method: string, body: Record<string, unknown>) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000)
    });
    const data: any = await response.json().catch(() => ({}));
    if (response.ok && data.ok !== false) return data;
    const retryAfter = Number(data.parameters?.retry_after ?? 0);
    if (attempt === 0 && response.status === 429 && retryAfter > 0 && retryAfter <= 5) {
      await delay(retryAfter * 1000);
      continue;
    }
    throw new Error(`Telegram ${method} failed (${response.status}): ${String(data.description ?? "unknown error").slice(0, 120)}`);
  }
  throw new Error(`Telegram ${method} failed`);
}

async function configureTelegram(env: Env, origin: string) {
  await Promise.all([
    telegram(env, "setMyCommands", {
      commands: [
        { command: "connect", description: "Connect or reconnect your VOLP account" },
        { command: "assignments", description: "View upcoming assignments" },
        { command: "missed", description: "View missed assignments" },
        { command: "sync", description: "Check VOLP now" },
        { command: "settings", description: "Choose reminder timing" },
        { command: "about", description: "About this bot and its privacy" },
        { command: "disconnect", description: "Delete your VOLP connection and data" }
      ]
    }),
    telegram(env, "setMyDescription", {
      description: "Checks VOLP every 3 hours for upcoming assignments and sends private deadline reminders at the time you choose."
    }),
    telegram(env, "setMyShortDescription", {
      short_description: "VOLP checks every 3 hours with personal deadline reminders."
    }),
    telegram(env, "setWebhook", {
      url: `${origin}/webhook/${env.WEBHOOK_SECRET}`,
      secret_token: env.WEBHOOK_SECRET,
      allowed_updates: ["message", "callback_query"],
      max_connections: 20
    })
  ]);
}

async function send(env: Env, chatId: number, text: string, replyMarkup?: unknown) {
  return telegram(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  });
}

async function makeSetupLink(env: Env, chatId: number, origin: string) {
  const tokenBytes = crypto.getRandomValues(new Uint8Array(16));
  const token = btoa(String.fromCharCode(...tokenBytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  const expires = new Date(Date.now() + 15 * 60_000).toISOString();
  await env.DB.prepare("DELETE FROM setup_tokens WHERE chat_id=? OR expires_at < ?").bind(chatId, new Date().toISOString()).run();
  await env.DB.prepare("INSERT INTO setup_tokens(token,chat_id,expires_at) VALUES(?,?,?)").bind(token, chatId, expires).run();
  return `${origin}/c/${token}`;
}

async function hasConnectionCapacity(env: Env, chatId: number) {
  const existing = await env.DB.prepare(
    "SELECT 1 AS connected FROM volp_accounts WHERE chat_id=?"
  ).bind(chatId).first();
  if (existing) return true;
  const count = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM volp_accounts"
  ).first<{ count: number }>();
  return (count?.count ?? 0) < MAX_CONNECTED_ACCOUNTS;
}

function reminderKeyboard(current?: number) {
  return {
    inline_keyboard: [0, 5].map((start) =>
      REMINDER_HOUR_OPTIONS.slice(start, start + 5).map((hours) => ({
        text: `${hours}h${current === hours ? " ✓" : ""}`,
        callback_data: `reminder_hours:${hours}`
      }))
    )
  };
}

async function showSettings(env: Env, chatId: number) {
  const user = await env.DB.prepare("SELECT reminder_hours FROM users WHERE chat_id=?").bind(chatId).first<{ reminder_hours: number }>();
  const current = user?.reminder_hours ?? DEFAULT_REMINDER_HOURS;
  return send(
    env,
    chatId,
    `⚙️ <b>Reminder timing</b>\n\nEveryone receives a reminder <b>1 hour before the deadline</b>.\n\nYour selected reminder: <b>${current} hour${current === 1 ? "" : "s"} before</b>.${current === 1 ? " This is combined with the standard 1-hour reminder, so you receive it only once." : ""}\n\nChoose any time from 1 to 10 hours:`,
    reminderKeyboard(current)
  );
}

async function handleCallback(env: Env, callback: any) {
  const chatId = callback.message?.chat?.id;
  const data = String(callback.data ?? "");
  if (!chatId) {
    return telegram(env, "answerCallbackQuery", { callback_query_id: callback.id });
  }
  if (data === "disconnect:cancel") {
    await telegram(env, "answerCallbackQuery", { callback_query_id: callback.id, text: "Disconnect cancelled" });
    return send(env, chatId, "Your VOLP connection was kept.");
  }
  if (data === "disconnect:confirm") {
    await telegram(env, "answerCallbackQuery", { callback_query_id: callback.id, text: "Disconnecting…" });
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sent_notifications WHERE chat_id=?").bind(chatId),
      env.DB.prepare("DELETE FROM new_assignment_notifications WHERE chat_id=?").bind(chatId),
      env.DB.prepare("DELETE FROM daily_digest_log WHERE chat_id=?").bind(chatId),
      env.DB.prepare("DELETE FROM assignments WHERE chat_id=?").bind(chatId),
      env.DB.prepare("DELETE FROM sync_runs WHERE chat_id=?").bind(chatId),
      env.DB.prepare("DELETE FROM volp_accounts WHERE chat_id=?").bind(chatId),
      env.DB.prepare("DELETE FROM setup_tokens WHERE chat_id=?").bind(chatId),
      env.DB.prepare("DELETE FROM sync_locks WHERE chat_id=?").bind(chatId),
      env.DB.prepare("DELETE FROM users WHERE chat_id=?").bind(chatId)
    ]);
    return send(env, chatId, "✅ Disconnected. Your stored VOLP session, assignments, reminders, and preferences were deleted.");
  }
  if (data === "assignments:view") {
    await telegram(env, "answerCallbackQuery", { callback_query_id: callback.id });
    return sendAssignments(env, chatId);
  }
  const match = data.match(/^reminder_hours:([1-9]|10)$/);
  if (!match) {
    if (/^reminder:(60|90|120)$/.test(data)) {
      await telegram(env, "answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "Reminder options changed. Choose a new time below."
      });
      return showSettings(env, chatId);
    }
    return telegram(env, "answerCallbackQuery", { callback_query_id: callback.id });
  }
  const hours = Number(match[1]);
  await env.DB.prepare(
    `INSERT INTO users(chat_id,created_at,reminder_hours) VALUES(?,?,?)
     ON CONFLICT(chat_id) DO UPDATE SET reminder_hours=excluded.reminder_hours`
  ).bind(chatId, new Date().toISOString(), hours).run();
  await telegram(env, "answerCallbackQuery", {
    callback_query_id: callback.id,
    text: `${hours === 1 ? "Reminder" : "Additional reminder"} set to ${hours} hour${hours === 1 ? "" : "s"} before`
  });
  return send(
    env,
    chatId,
    `✅ Reminder set to <b>${hours} hour${hours === 1 ? "" : "s"} before the deadline</b>.${hours === 1 ? "" : " You’ll also receive the standard 1-hour reminder."}`
  );
}

type StoredAssignment = {
  title: string;
  course: string;
  assignment_type: string;
  due_at: string;
  submitted: number;
};

async function sendAssignmentList(
  env: Env,
  chatId: number,
  rows: StoredAssignment[],
  heading: string,
  emptyMessage: string,
  dateLabel: string
) {
  if (!rows.length) return send(env, chatId, emptyMessage);
  const messages: string[] = [];
  let message = heading;
  let currentCourse: string | null = null;
  for (const assignment of rows) {
    const course = truncate(assignment.course, 160);
    const courseHeading = course === currentCourse ? "" : `\n\n<b>${escapeHtml(course)}</b>`;
    const entry =
      `${courseHeading}\n• ${escapeHtml(truncate(assignment.title, 700))}\n` +
      `  ${escapeHtml(assignment.assignment_type)} · ${dateLabel}: ` +
      `${new Date(assignment.due_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}\n` +
      `  ${assignment.submitted ? "✅ Submitted" : "🟠 Not submitted"}`;
    if (`${message}${entry}`.length > 3_800) {
      messages.push(message);
      message = `${heading} <i>(continued)</i>`;
      currentCourse = "";
      const repeatedEntry =
        `\n\n<b>${escapeHtml(course)}</b>\n• ${escapeHtml(truncate(assignment.title, 700))}\n` +
        `  ${escapeHtml(assignment.assignment_type)} · ${dateLabel}: ` +
        `${new Date(assignment.due_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}\n` +
        `  ${assignment.submitted ? "✅ Submitted" : "🟠 Not submitted"}`;
      message += repeatedEntry;
    } else {
      message += entry;
    }
    currentCourse = course;
  }
  messages.push(message);
  for (const part of messages) await send(env, chatId, part);
}

async function sendAssignments(env: Env, chatId: number) {
  const rows = await env.DB.prepare(
    `SELECT title,course,assignment_type,due_at,submitted
     FROM assignments
     WHERE chat_id=? AND due_at>?
     ORDER BY course COLLATE NOCASE,due_at`
  ).bind(chatId, new Date().toISOString()).all<StoredAssignment>();
  return sendAssignmentList(
    env,
    chatId,
    rows.results,
    "📚 <b>Upcoming assignments</b>",
    "No saved upcoming assignments found.",
    "Due"
  );
}

async function showAssignmentsAndRefresh(env: Env, chatId: number) {
  const account = await env.DB.prepare(
    "SELECT last_sync_at FROM volp_accounts WHERE chat_id=?"
  ).bind(chatId).first<{ last_sync_at: string | null }>();
  if (!account) {
    return send(env, chatId, "Connect your VOLP account first with /connect.");
  }
  if (!account.last_sync_at) {
    return send(env, chatId, "⏳ Your first VOLP sync is still loading assignments. I’ll send them automatically when it finishes.");
  }

  // Reply from D1 first so a slow VOLP request never delays the assignments button.
  await sendAssignments(env, chatId);

  if (isVolpMaintenanceWindow()) {
    return send(env, chatId, VOLP_MAINTENANCE_MESSAGE);
  }

  const enqueuedAt = new Date().toISOString();
  const redispatchBefore = new Date(Date.now() - 30 * 60_000).toISOString();
  const queued = await env.DB.prepare(
    `UPDATE volp_accounts SET sync_enqueued_at=?
     WHERE chat_id=?
       AND (sync_enqueued_at IS NULL OR sync_enqueued_at<?)`
  ).bind(enqueuedAt, chatId, redispatchBefore).run();
  if (queued.meta.changes !== 1) {
    return send(env, chatId, "⏳ I’m already checking VOLP for new assignments.");
  }

  try {
    await env.SYNC_QUEUE.send({ chatId, assignmentRefresh: true, enqueuedAt });
  } catch {
    await env.DB.prepare(
      "UPDATE volp_accounts SET sync_enqueued_at=NULL WHERE chat_id=? AND sync_enqueued_at=?"
    ).bind(chatId, enqueuedAt).run();
    return send(env, chatId, "⚠️ I couldn’t queue the VOLP refresh. Your saved assignments are still available; please try again later.");
  }
  return send(env, chatId, "🔄 Checking VOLP for new assignments in the background.");
}

async function deliverSyncResult(env: Env, chatId: number, initial = false) {
  return send(
    env,
    chatId,
    initial
      ? "✅ Your assignments are loaded. I’ll now check VOLP every 3 hours."
      : "✅ VOLP sync finished. Your assignment data is up to date.",
    { inline_keyboard: [[{ text: "View assignments 📚", callback_data: "assignments:view" }]] }
  );
}

async function sendMissedAssignments(env: Env, chatId: number) {
  const rows = await env.DB.prepare(
    `SELECT title,course,assignment_type,due_at,submitted
     FROM assignments
     WHERE chat_id=? AND due_at<=? AND submitted=0
     ORDER BY course COLLATE NOCASE,due_at DESC`
  ).bind(chatId, new Date().toISOString()).all<StoredAssignment>();
  return sendAssignmentList(
    env,
    chatId,
    rows.results,
    "🕰 <b>Missed assignments</b>",
    "🎉 No missed assignments found.",
    "Was due"
  );
}

async function markCurrentAssignmentsSeen(env: Env, chatId: number) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO new_assignment_notifications(chat_id,assignment_key,notified_at)
     SELECT chat_id,assignment_key,? FROM assignments WHERE chat_id=?`
  ).bind(new Date().toISOString(), chatId).run();
}

async function sendNewAssignmentNotifications(env: Env, chatId: number) {
  const rows = await env.DB.prepare(
    `SELECT a.assignment_key,a.title,a.course,a.due_at,a.submitted
     FROM assignments a
     WHERE a.chat_id=? AND a.due_at>?
       AND NOT EXISTS (
         SELECT 1 FROM new_assignment_notifications n
         WHERE n.chat_id=a.chat_id AND n.assignment_key=a.assignment_key
       )
     ORDER BY a.due_at`
  ).bind(chatId, new Date().toISOString()).all<any>();
  if (!rows.results.length) return;

  const messages: string[] = [];
  let message = "🆕 <b>New assignments added</b>";
  for (const assignment of rows.results) {
    const entry =
      `• <b>${escapeHtml(truncate(assignment.title, 700))}</b>\n` +
      `  ${escapeHtml(truncate(assignment.course, 160))} · ` +
      `${new Date(assignment.due_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}\n` +
      `  ${assignment.submitted ? "✅ Submitted" : "🟠 Not submitted"}`;
    if (`${message}\n\n${entry}`.length > 3_800) {
      messages.push(message);
      message = "🆕 <b>New assignments added (continued)</b>";
    }
    message += `\n\n${entry}`;
  }
  messages.push(message);
  for (const part of messages) await send(env, chatId, part);

  const notifiedAt = new Date().toISOString();
  await env.DB.batch(rows.results.map((assignment) =>
    env.DB.prepare(
      "INSERT OR IGNORE INTO new_assignment_notifications(chat_id,assignment_key,notified_at) VALUES(?,?,?)"
    ).bind(chatId, assignment.assignment_key, notifiedAt)
  ));
}

function istDateAndHour(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    hour: Number(value("hour")),
    minute: Number(value("minute"))
  };
}

function isVolpMaintenanceWindow(now = new Date()) {
  const ist = istDateAndHour(now);
  return ist.hour * 60 + ist.minute < VOLP_MAINTENANCE_END_MINUTE_IST;
}

async function sendDailyDigest(env: Env, chatId: number, digestDate: string) {
  const claimed = await env.DB.prepare(
    "INSERT OR IGNORE INTO daily_digest_log(chat_id,digest_date,sent_at) VALUES(?,?,?)"
  ).bind(chatId, digestDate, new Date().toISOString()).run();
  if (claimed.meta.changes !== 1) return;

  try {
    const now = new Date();
    const rows = await env.DB.prepare(
      `SELECT title,course,due_at FROM assignments
       WHERE chat_id=? AND submitted=0 AND due_at>? AND due_at<=?
       ORDER BY due_at`
    ).bind(chatId, now.toISOString(), new Date(now.getTime() + 72 * 60 * 60_000).toISOString()).all<any>();
    if (!rows.results.length) {
      return;
    }

    const entries = rows.results.map((assignment) =>
      `• <b>${escapeHtml(truncate(assignment.title, 700))}</b>\n` +
      `  ${escapeHtml(truncate(assignment.course, 160))} · ` +
      `${new Date(assignment.due_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`
    );
    const messages: string[] = [];
    let message = "☀️ <b>Due within the next 3 days</b>";
    for (const entry of entries) {
      if (`${message}\n\n${entry}`.length > 3_800) {
        messages.push(message);
        message = "☀️ <b>Due within the next 3 days (continued)</b>";
      }
      message += `\n\n${entry}`;
    }
    messages.push(message);
    for (const part of messages) await send(env, chatId, part);
  } catch (error) {
    await env.DB.prepare(
      "DELETE FROM daily_digest_log WHERE chat_id=? AND digest_date=?"
    ).bind(chatId, digestDate).run();
    throw error;
  }
}

async function handleCommand(env: Env, chatId: number, text: string, origin: string) {
  const command = text.trim().split(/\s+/)[0].split("@")[0].toLowerCase();
  if (command === "/start" || command === "/connect") {
    if (command === "/start") await configureTelegram(env, origin);
    await env.DB.prepare(
      "INSERT OR IGNORE INTO users(chat_id,created_at,reminder_minutes) VALUES(?,?,?)"
    ).bind(chatId, new Date().toISOString(), 60).run();
    if (!(await hasConnectionCapacity(env, chatId))) {
      return send(
        env,
        chatId,
        "⛔ <b>Bot capacity reached</b>\n\nNew VOLP connections are temporarily closed to keep reminders reliable. Existing connected users can continue using the bot."
      );
    }
    const link = await makeSetupLink(env, chatId, origin);
    return send(env, chatId,
      `👋 <b>VOLP Assignment Reminder</b>\n\nConnect your VOLP account using the private link below. It expires in 15 minutes.\n\nYour VOLP password will be stored encrypted and used only for automatic re-login. Use /disconnect anytime to erase all stored credentials and data.`,
      {
        inline_keyboard: [
          [{ text: "Connect VOLP 🔐", web_app: { url: link } }],
          [{ text: "Choose reminder time", callback_data: "reminder_hours:1" }]
        ]
      });
  }
  if (command === "/assignments") {
    return showAssignmentsAndRefresh(env, chatId);
  }
  if (command === "/missed") {
    const account = await env.DB.prepare(
      "SELECT last_sync_at FROM volp_accounts WHERE chat_id=?"
    ).bind(chatId).first<{ last_sync_at: string | null }>();
    if (!account) {
      return send(env, chatId, "Connect your VOLP account first with /connect.");
    }
    if (!account.last_sync_at) {
      return send(env, chatId, "⏳ Your first VOLP sync is still loading assignments.");
    }
    return sendMissedAssignments(env, chatId);
  }
  if (command === "/sync") {
    if (isVolpMaintenanceWindow()) {
      const account = await env.DB.prepare(
        "SELECT 1 AS connected FROM volp_accounts WHERE chat_id=?"
      ).bind(chatId).first();
      if (!account) {
        return send(env, chatId, "Connect your VOLP account first with /connect.");
      }
      return send(env, chatId, VOLP_MAINTENANCE_MESSAGE);
    }
    const enqueuedAt = new Date().toISOString();
    const redispatchBefore = new Date(Date.now() - 30 * 60_000).toISOString();
    const queued = await env.DB.prepare(
      `UPDATE volp_accounts SET sync_enqueued_at=?
       WHERE chat_id=?
         AND (sync_enqueued_at IS NULL OR sync_enqueued_at<?)`
    ).bind(enqueuedAt, chatId, redispatchBefore).run();
    if (queued.meta.changes !== 1) {
      const account = await env.DB.prepare(
        "SELECT 1 AS connected FROM volp_accounts WHERE chat_id=?"
      ).bind(chatId).first();
      if (!account) {
        return send(env, chatId, "Connect your VOLP account first with /connect.");
      }
      return send(env, chatId, "⏳ I’m already checking VOLP for you. I’ll message you when it finishes.");
    }
    try {
      await env.SYNC_QUEUE.send({ chatId, manual: true, enqueuedAt });
    } catch {
      await env.DB.prepare(
        "UPDATE volp_accounts SET sync_enqueued_at=NULL WHERE chat_id=? AND sync_enqueued_at=?"
      ).bind(chatId, enqueuedAt).run();
      return send(env, chatId, "⚠️ I couldn’t queue the VOLP sync. Please try /sync again.");
    }
    return send(env, chatId, "⏳ Checking VOLP in the background. I’ll message you when it finishes.");
  }
  if (command === "/settings" || command === "/reminder") {
    return showSettings(env, chatId);
  }
  if (command === "/about") {
    return send(
      env,
      chatId,
      `ℹ️ <b>About VOLP Assignment Reminder</b>\n\nI check VOLP every 3 hours, list upcoming hands-on and subjective assignments, and remind each user at their chosen time.\n\nVOLP session tokens and passwords are encrypted. The saved password is used only for automatic re-login. Use /disconnect to erase all stored credentials and data.\n\nSelf-hosted copies send default-on daily anonymous usage totals: a random installation ID, bot version, registered-user count, and connected-account count. No user identities, credentials, assignments, or messages are sent. Operators can disable this in wrangler.jsonc.\n\nOpen-source and unaffiliated with VOLP or VIT.`,
      { inline_keyboard: [[{ text: "View source code", url: REPOSITORY_URL }]] }
    );
  }
  if (command === "/disconnect") {
    return send(
      env,
      chatId,
      "⚠️ <b>Disconnect VOLP?</b>\n\nThis deletes your stored VOLP session, assignments, reminders, and preference settings.",
      {
        inline_keyboard: [[
          { text: "Yes, delete my data", callback_data: "disconnect:confirm" },
          { text: "Cancel", callback_data: "disconnect:cancel" }
        ]]
      }
    );
  }
  return send(env, chatId, "Commands: /connect, /assignments, /missed, /sync, /settings, /about, /disconnect");
}

function collectHandsOn(
  found: Assignment[],
  items: any[],
  courseName: string,
  fallbackId: string | number
) {
  for (const item of items) {
    const dueAt = parseDueDate(item.duedate);
    if (!dueAt || dueAt.getTime() < Date.now() - MISSED_ASSIGNMENT_RETENTION_MS) continue;
    const title = stripHtml(item.assignment_text) || "Hands-on assignment";
    found.push({
      key: `hands:${fallbackId}:${item.ass_id ?? item.id ?? title.slice(0, 80)}`,
      title,
      course: courseName,
      type: "Hands-on",
      dueAt,
      submitted: handsOnSubmitted(item)
    });
  }
}

async function fetchCourseList(session: VolpSession): Promise<any[]> {
  const courseData = await postVolp(
    "https://learner.volp.in/learnerCourseDashboard/learnerCourseList", {}, session, "/learner/my-courses"
  );
  if (!Array.isArray(courseData.col_list)) {
    throw new Error("VOLP session expired. Use /connect to reconnect.");
  }
  // VOLP reports some newly registered/current courses with a falsy
  // course_status even though they are available to the learner.
  return (courseData.col_list ?? []).filter((course: any) => !course.is_archived);
}

async function fetchCourseAssignments(course: any, session: VolpSession): Promise<Assignment[]> {
  const found: Assignment[] = [];
  const courseName = stripHtml(course.course?.course_name) || "Course";
  await postVolp(
    "https://learner.volp.in/learnerCourseDashboard/startCourse",
    { colid: course.colid }, session, "/learner-course-overview"
  );
  const content = await postVolp(
    "https://learner.volp.in/learnerCourseContent/courseContentData",
    { colid: course.colid }, session, "/learner-course-content"
  );
  const courseId =
    content.course_id ||
    course.crsid ||
    course.course_id ||
    course.course?.course_id ||
    course.course?.crsid;
  if (courseId && (content.course_level?.assigns?.hands?.length ?? 0) > 0) {
    const data = await postVolp(
      "https://learner.volp.in/HandOnAssignment/getHandsOnDetails",
      {
        course_offering_learner_id: course.colid,
        courseId,
        type: "content"
      },
      session, "/learner-handson-assignment"
    );
    collectHandsOn(found, data.ass_list ?? [], courseName, courseId);
  }
  const units = content.unit_level ?? [];
  const queriedUnitIds = new Set<string>();
  const fetchUnitHandsOn = async (unit: any) => {
    if (unit.unit_id == null) return;
    const unitId = String(unit.unit_id);
    if (queriedUnitIds.has(unitId)) return;
    queriedUnitIds.add(unitId);
    const data = await postVolp(
      "https://learner.volp.in/HandOnAssignment/getHandsOnDetails",
      { course_offering_learner_id: course.colid, outline: unit.unit_id, type: "content" },
      session, "/learner-handson-assignment"
    );
    collectHandsOn(found, data.ass_list ?? [], courseName, unit.unit_id);
  };
  for (const unit of units) {
    if (!(unit.assigns?.hands ?? []).length) continue;
    await fetchUnitHandsOn(unit);
  }
  // VOLP can remove a submitted unit assignment from the course outline even
  // while its deadline is still in the future. If the advertised endpoints
  // produced only past work, inspect the remaining units before concluding
  // that the course has no upcoming assignments.
  if (found.length > 0 && !found.some((assignment) => assignment.dueAt.getTime() > Date.now())) {
    for (const unit of units) await fetchUnitHandsOn(unit);
  }
  if (courseId && (content.course_level?.assigns?.proj?.length ?? 0) > 0) {
    const subjective = await postVolp(
      "https://learner.volp.in/SubjectiveAssignment/getSubjectiveAssignment_new",
      { course_offering_learner_id: course.colid, courseId, type: "content" },
      session, "/learner-subjective-assignment"
    );
    for (const item of subjective.question_list ?? []) {
      const dueAt = parseDueDate(item.due_date);
      if (!dueAt || dueAt.getTime() < Date.now() - MISSED_ASSIGNMENT_RETENTION_MS) continue;
      found.push({
        key: `subjective:${courseId}:${item.question_id ?? item.id ?? stripHtml(item.question).slice(0, 80)}`,
        title: stripHtml(item.question) || "Subjective assignment",
        course: courseName,
        type: "Subjective",
        dueAt,
        submitted: Boolean(item.issubmitted || item.isevaluated)
      });
    }
  }
  return found;
}

async function acquireSyncLock(env: Env, chatId: number) {
  const now = new Date();
  const expires = new Date(now.getTime() + 10 * 60_000).toISOString();
  const result = await env.DB.prepare(
    `INSERT INTO sync_locks(chat_id,expires_at) VALUES(?,?)
     ON CONFLICT(chat_id) DO UPDATE SET expires_at=excluded.expires_at
     WHERE sync_locks.expires_at < ?`
  ).bind(chatId, expires, now.toISOString()).run();
  return result.meta.changes === 1;
}

async function releaseSyncLock(env: Env, chatId: number) {
  await env.DB.prepare("DELETE FROM sync_locks WHERE chat_id=?").bind(chatId).run();
}

async function clearSyncEnqueued(env: Env, job: { chatId: number; enqueuedAt?: string }) {
  if (job.enqueuedAt) {
    await env.DB.prepare(
      "UPDATE volp_accounts SET sync_enqueued_at=NULL WHERE chat_id=? AND sync_enqueued_at=?"
    ).bind(job.chatId, job.enqueuedAt).run();
    return;
  }
  await env.DB.prepare("UPDATE volp_accounts SET sync_enqueued_at=NULL WHERE chat_id=?")
    .bind(job.chatId).run();
}

async function waitForRefreshedSession(
  env: Env,
  chatId: number,
  previousEncryptedToken: string
): Promise<{ session: VolpSession; encryptedToken: string } | null> {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (attempt) await delay(500);
    const latest = await env.DB.prepare(
      "SELECT uid,encrypted_token FROM volp_accounts WHERE chat_id=?"
    ).bind(chatId).first<{ uid: string; encrypted_token: string }>();
    if (!latest) throw new Error("VOLP account is not connected");
    if (latest.encrypted_token !== previousEncryptedToken) {
      return {
        session: {
          token: await decryptSecret(latest.encrypted_token, env.CREDENTIAL_KEY),
          uid: latest.uid
        },
        encryptedToken: latest.encrypted_token
      };
    }
  }
  return null;
}

async function withAccountSession<T>(
  env: Env,
  chatId: number,
  operation: (session: VolpSession) => Promise<T>
): Promise<T> {
  const account = await env.DB.prepare(
    `SELECT username,uid,encrypted_token,encrypted_password,auto_relogin,last_reauth_at
     FROM volp_accounts WHERE chat_id=?`
  ).bind(chatId).first<any>();
  if (!account) throw new Error("VOLP account is not connected");
  let storedEncryptedToken = String(account.encrypted_token);
  try {
    let storedToken = await decryptSecret(storedEncryptedToken, env.CREDENTIAL_KEY);
    let session = { token: storedToken, uid: account.uid };
    let reauthenticatedAt: string | null = null;
    let result: T;
    try {
      result = await operation(session);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (!message.includes("session expired") || !account.auto_relogin || !account.encrypted_password) throw error;

      const latest = await env.DB.prepare(
        "SELECT uid,encrypted_token,last_reauth_at FROM volp_accounts WHERE chat_id=?"
      ).bind(chatId).first<{ uid: string; encrypted_token: string; last_reauth_at: string | null }>();
      if (!latest) throw new Error("VOLP account is not connected");
      if (latest.encrypted_token !== storedEncryptedToken) {
        storedEncryptedToken = latest.encrypted_token;
        storedToken = await decryptSecret(storedEncryptedToken, env.CREDENTIAL_KEY);
        session = { token: storedToken, uid: latest.uid };
        result = await operation(session);
      } else {
        const cutoff = new Date(Date.now() - 15 * 60_000).toISOString();
        reauthenticatedAt = new Date().toISOString();
        const claimed = await env.DB.prepare(
          `UPDATE volp_accounts SET last_reauth_at=?
           WHERE chat_id=? AND encrypted_token=?
             AND (last_reauth_at IS NULL OR last_reauth_at<?)`
        ).bind(reauthenticatedAt, chatId, storedEncryptedToken, cutoff).run();
        if (claimed.meta.changes !== 1) {
          const refreshed = await waitForRefreshedSession(env, chatId, storedEncryptedToken);
          if (!refreshed) {
            throw new Error("VOLP session expired; automatic re-login is cooling down");
          }
          storedEncryptedToken = refreshed.encryptedToken;
          storedToken = refreshed.session.token;
          session = refreshed.session;
          reauthenticatedAt = null;
          result = await operation(session);
        } else {
          const password = await decryptSecret(account.encrypted_password, env.CREDENTIAL_KEY);
          const login = await postVolp(
            "https://admin.volp.in/login/process",
            { username: account.username, pwd: password }
          );
          if (login.flag !== "YES" || !login.token) {
            throw new Error("VOLP automatic re-login failed. Use /connect to update the saved password.");
          }
          session = { token: String(login.token), uid: String(login.uid || account.uid) };
          storedToken = session.token;
          const refreshedEncryptedToken = await encryptSecret(storedToken, env.CREDENTIAL_KEY);
          const published = await env.DB.prepare(
            `UPDATE volp_accounts
             SET uid=?,encrypted_token=?,last_error=NULL
             WHERE chat_id=? AND encrypted_token=? AND last_reauth_at=?`
          ).bind(session.uid, refreshedEncryptedToken, chatId, storedEncryptedToken, reauthenticatedAt).run();
          if (published.meta.changes !== 1) {
            throw new Error("VOLP account changed during automatic login");
          }
          storedEncryptedToken = refreshedEncryptedToken;
          result = await operation(session);
        }
      }
    }
    const encryptedToken = session.token === storedToken
      ? storedEncryptedToken
      : await encryptSecret(session.token, env.CREDENTIAL_KEY);
    const accountUpdate = await env.DB.prepare(
      `UPDATE volp_accounts
       SET uid=?,encrypted_token=?,last_reauth_at=COALESCE(?,last_reauth_at),
           last_error=NULL
       WHERE chat_id=? AND encrypted_token=?`
    ).bind(session.uid, encryptedToken, reauthenticatedAt, chatId, storedEncryptedToken).run();
    if (accountUpdate.meta.changes !== 1) {
      const current = await env.DB.prepare(
        "SELECT uid FROM volp_accounts WHERE chat_id=?"
      ).bind(chatId).first<{ uid: string }>();
      if (!current || current.uid !== session.uid) {
        throw new Error("VOLP account changed during sync");
      }
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 200) : "Sync failed";
    await env.DB.prepare(
      "UPDATE volp_accounts SET last_error=? WHERE chat_id=? AND encrypted_token=?"
    ).bind(message, chatId, storedEncryptedToken).run();
    throw error;
  }
}

async function enqueueSyncFinalizer(
  env: Env,
  job: Pick<SyncCourseJob, "chatId" | "runId" | "manual" | "initial" | "enqueuedAt">
) {
  const unfinished = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM sync_run_courses WHERE run_id=? AND status<>'done'"
  ).bind(job.runId).first<{ count: number }>();
  if ((unfinished?.count ?? 0) > 0) return;

  const claimed = await env.DB.prepare(
    `UPDATE sync_runs SET finalize_enqueued=1
     WHERE run_id=? AND chat_id=? AND status='running' AND finalize_enqueued=0`
  ).bind(job.runId, job.chatId).run();
  if (claimed.meta.changes !== 1) return;

  try {
    await env.SYNC_QUEUE.send({ ...job, kind: "sync-finalize" });
  } catch (error) {
    await env.DB.prepare(
      "UPDATE sync_runs SET finalize_enqueued=0 WHERE run_id=? AND status='running'"
    ).bind(job.runId).run();
    throw error;
  }
}

async function enqueueNextSyncCourse(
  env: Env,
  job: Pick<SyncCourseJob, "chatId" | "runId" | "manual" | "initial" | "enqueuedAt">,
  position: number,
  courseCount: number
) {
  if (position < courseCount) {
    await env.SYNC_QUEUE.send({ ...job, kind: "sync-course", position });
    return;
  }
  await enqueueSyncFinalizer(env, job);
}

async function startChunkedSync(env: Env, job: SyncRequestJob, force = false) {
  if (!(await acquireSyncLock(env, job.chatId))) {
    throw new Error("VOLP sync already in progress");
  }
  try {
    const account = await env.DB.prepare(
      "SELECT last_sync_at FROM volp_accounts WHERE chat_id=?"
    ).bind(job.chatId).first<{ last_sync_at: string | null }>();
    if (!account) throw new Error("VOLP account is not connected");
    const lastSync = account.last_sync_at ? new Date(account.last_sync_at).getTime() : 0;
    if (!force && Date.now() - lastSync < SYNC_INTERVAL_MS - SYNC_DISPATCH_GRACE_MS) return false;

    const courses = await withAccountSession(env, job.chatId, fetchCourseList);
    const runId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const enqueuedAt = job.enqueuedAt ?? startedAt;
    const statements = [
      env.DB.prepare("DELETE FROM sync_runs WHERE chat_id=?").bind(job.chatId),
      env.DB.prepare(
        `INSERT INTO sync_runs(
           run_id,chat_id,enqueued_at,started_at,status,course_count,manual,initial
         ) VALUES(?,?,?,?,'running',?,?,?)`
      ).bind(
        runId,
        job.chatId,
        enqueuedAt,
        startedAt,
        courses.length,
        job.manual || job.assignmentRefresh ? 1 : 0,
        job.initial ? 1 : 0
      ),
      ...courses.map((course, position) => env.DB.prepare(
        `INSERT INTO sync_run_courses(run_id,position,course_json,status)
         VALUES(?,?,?,'pending')`
      ).bind(runId, position, JSON.stringify(course)))
    ];
    await env.DB.batch(statements);
    const courseJob = {
      chatId: job.chatId,
      runId,
      manual: job.manual || job.assignmentRefresh,
      initial: job.initial,
      enqueuedAt
    };
    await enqueueNextSyncCourse(env, courseJob, 0, courses.length);
    return true;
  } finally {
    await releaseSyncLock(env, job.chatId);
  }
}

async function processSyncCourseJob(env: Env, job: SyncCourseJob) {
  const run = await env.DB.prepare(
    "SELECT status,course_count FROM sync_runs WHERE run_id=? AND chat_id=?"
  ).bind(job.runId, job.chatId).first<{ status: string; course_count: number }>();
  if (!run || run.status !== "running") return;
  const courseRow = await env.DB.prepare(
    "SELECT course_json,status FROM sync_run_courses WHERE run_id=? AND position=?"
  ).bind(job.runId, job.position).first<{ course_json: string; status: string }>();
  if (!courseRow) {
    await enqueueNextSyncCourse(env, job, job.position + 1, run.course_count);
    return;
  }
  if (courseRow.status !== "done") {
    const course = JSON.parse(courseRow.course_json);
    const assignments = await withAccountSession(
      env,
      job.chatId,
      (session) => fetchCourseAssignments(course, session)
    );
    const writes = assignments.map((assignment) => env.DB.prepare(
      `INSERT INTO sync_run_assignments(
         run_id,assignment_key,title,course,assignment_type,due_at,submitted
       ) VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(run_id,assignment_key) DO UPDATE SET
       title=excluded.title,course=excluded.course,assignment_type=excluded.assignment_type,
       due_at=excluded.due_at,submitted=excluded.submitted`
    ).bind(
      job.runId,
      assignment.key,
      assignment.title,
      assignment.course,
      assignment.type,
      assignment.dueAt.toISOString(),
      assignment.submitted ? 1 : 0
    ));
    writes.push(env.DB.prepare(
      "UPDATE sync_run_courses SET status='done' WHERE run_id=? AND position=?"
    ).bind(job.runId, job.position));
    await env.DB.batch(writes);
  }
  await enqueueNextSyncCourse(env, job, job.position + 1, run.course_count);
}

async function notifyCompletedSyncRun(
  env: Env,
  run: { run_id: string; chat_id: number; manual: number; initial: number; completion_notified_at: string | null }
) {
  if (run.completion_notified_at) return;
  if (run.manual || run.initial) {
    await markCurrentAssignmentsSeen(env, run.chat_id);
    await env.SYNC_QUEUE.send({
      kind: "sync-result",
      chatId: run.chat_id,
      initial: run.initial === 1
    });
  } else {
    await sendNewAssignmentNotifications(env, run.chat_id);
  }
  await env.DB.prepare(
    "UPDATE sync_runs SET completion_notified_at=? WHERE run_id=? AND completion_notified_at IS NULL"
  ).bind(new Date().toISOString(), run.run_id).run();
}

async function processSyncFinalizeJob(env: Env, job: SyncFinalizeJob) {
  const run = await env.DB.prepare(
    `SELECT run_id,chat_id,enqueued_at,status,course_count,manual,initial,completion_notified_at
     FROM sync_runs WHERE run_id=? AND chat_id=?`
  ).bind(job.runId, job.chatId).first<any>();
  if (!run) return;
  if (run.status === "completed") {
    await notifyCompletedSyncRun(env, run);
    return;
  }
  if (run.status !== "running") return;
  const unfinished = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM sync_run_courses WHERE run_id=? AND status<>'done'"
  ).bind(job.runId).first<{ count: number }>();
  if ((unfinished?.count ?? 0) > 0) throw new Error("VOLP sync already in progress");

  const account = await env.DB.prepare(
    "SELECT sync_enqueued_at FROM volp_accounts WHERE chat_id=?"
  ).bind(job.chatId).first<{ sync_enqueued_at: string | null }>();
  if (!account || account.sync_enqueued_at !== run.enqueued_at) {
    await env.DB.prepare(
      "UPDATE sync_runs SET status='cancelled',completed_at=? WHERE run_id=?"
    ).bind(new Date().toISOString(), job.runId).run();
    return;
  }

  const staged = await env.DB.prepare(
    `SELECT assignment_key,title,course,assignment_type,due_at,submitted
     FROM sync_run_assignments WHERE run_id=?`
  ).bind(job.runId).all<any>();
  const existing = await env.DB.prepare(
    `SELECT assignment_key,title,course,assignment_type,due_at,submitted,updated_at
     FROM assignments WHERE chat_id=?`
  ).bind(job.chatId).all<any>();
  const existingByKey = new Map(existing.results.map((item) => [item.assignment_key, item]));
  const incomingKeys = new Set(staged.results.map((item) => item.assignment_key));
  const now = new Date().toISOString();
  const writes = staged.results.flatMap((item) => {
    const previous = existingByKey.get(item.assignment_key) as any;
    if (previous &&
        previous.title === item.title &&
        previous.course === item.course &&
        previous.assignment_type === item.assignment_type &&
        previous.due_at === item.due_at &&
        previous.submitted === item.submitted) {
      return [env.DB.prepare(
        "UPDATE assignments SET updated_at=? WHERE chat_id=? AND assignment_key=?"
      ).bind(now, job.chatId, item.assignment_key)];
    }
    return [env.DB.prepare(
      `INSERT INTO assignments(chat_id,assignment_key,title,course,assignment_type,due_at,submitted,updated_at)
       VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(chat_id,assignment_key) DO UPDATE SET
       title=excluded.title,course=excluded.course,assignment_type=excluded.assignment_type,
       due_at=excluded.due_at,submitted=excluded.submitted,updated_at=excluded.updated_at`
    ).bind(
      job.chatId,
      item.assignment_key,
      item.title,
      item.course,
      item.assignment_type,
      item.due_at,
      item.submitted,
      now
    )];
  });
  for (const previous of existing.results) {
    if (!incomingKeys.has(previous.assignment_key)) {
      const previousDue = new Date(previous.due_at).getTime();
      const missed =
        !previous.submitted &&
        previousDue <= Date.now() &&
        previousDue >= Date.now() - MISSED_ASSIGNMENT_RETENTION_MS;
      const recentlySeen = new Date(previous.updated_at).getTime() >= Date.now() - MISSING_ASSIGNMENT_GRACE_MS;
      if (!missed && !(previousDue > Date.now() && recentlySeen)) {
        writes.push(
          env.DB.prepare("DELETE FROM assignments WHERE chat_id=? AND assignment_key=?")
            .bind(job.chatId, previous.assignment_key)
        );
      }
    }
  }
  writes.push(
    env.DB.prepare(
      `DELETE FROM assignments
       WHERE rowid IN (
         SELECT rowid FROM (
           SELECT rowid,
             ROW_NUMBER() OVER (
               PARTITION BY chat_id,title,course,assignment_type,due_at
               ORDER BY updated_at DESC,rowid DESC
             ) AS duplicate_number
           FROM assignments
           WHERE chat_id=?
         )
         WHERE duplicate_number > 1
       )`
    ).bind(job.chatId),
    env.DB.prepare(
      `DELETE FROM sent_notifications
       WHERE chat_id=? AND NOT EXISTS(
         SELECT 1 FROM assignments a
         WHERE a.chat_id=sent_notifications.chat_id
           AND a.assignment_key=sent_notifications.assignment_key
       )`
    ).bind(job.chatId),
    env.DB.prepare(
      `DELETE FROM new_assignment_notifications
       WHERE chat_id=? AND NOT EXISTS(
         SELECT 1 FROM assignments a
         WHERE a.chat_id=new_assignment_notifications.chat_id
           AND a.assignment_key=new_assignment_notifications.assignment_key
       )`
    ).bind(job.chatId),
    env.DB.prepare(
      `UPDATE volp_accounts
       SET last_sync_at=?,last_error=NULL,sync_enqueued_at=NULL
       WHERE chat_id=? AND sync_enqueued_at=?`
    ).bind(now, job.chatId, run.enqueued_at),
    env.DB.prepare(
      "UPDATE sync_runs SET status='completed',completed_at=? WHERE run_id=? AND status='running'"
    ).bind(now, job.runId)
  );
  const results = await env.DB.batch(writes);
  const accountResult = results[results.length - 2];
  if (accountResult.meta.changes !== 1) throw new Error("VOLP account changed during sync");
  await notifyCompletedSyncRun(env, { ...run, status: "completed" });
}

async function sendDueReminders(env: Env, chatId: number, threshold: number) {
  const rows = await env.DB.prepare(
    "SELECT assignment_key,title,course,assignment_type,due_at,submitted FROM assignments WHERE chat_id=? AND due_at>?"
  ).bind(chatId, new Date().toISOString()).all<any>();
  for (const item of rows.results) {
    const remaining = Math.floor((new Date(item.due_at).getTime() - Date.now()) / 60_000);
    if (remaining > threshold) continue;
    const marked = await env.DB.prepare(
      "INSERT OR IGNORE INTO sent_notifications(chat_id,assignment_key,threshold_minutes,sent_at) VALUES(?,?,?,?)"
    ).bind(chatId, item.assignment_key, threshold, new Date().toISOString()).run();
    if (marked.meta.changes !== 1) continue;
    const hours = threshold / 60;
    const label = `${hours} hour${hours === 1 ? "" : "s"}`;
    await send(env, chatId,
      `⏰ <b>Assignment due in ${label}</b>\n\n<b>${escapeHtml(truncate(item.title, 1_000))}</b>\n${escapeHtml(truncate(item.course, 160))} · ${escapeHtml(item.assignment_type)}\nDue: ${new Date(item.due_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}\nStatus: ${item.submitted ? "✅ Submitted" : "🟠 Not submitted"}`);
  }
}

async function sendConfiguredReminders(env: Env, chatId: number, selectedHours: number) {
  await sendDueReminders(env, chatId, selectedHours * 60);
  if (selectedHours !== 1) {
    await sendDueReminders(env, chatId, 60);
  }
}

type ScheduledAccount = {
  chat_id: number;
  reminder_hours: number;
  auto_relogin: number;
  last_error: string | null;
  last_sync_at: string | null;
};

async function processScheduledAccount(env: Env, account: ScheduledAccount) {
  if (!(await acquireSyncLock(env, account.chat_id))) return;
  try {
    const lastSync = account.last_sync_at ? new Date(account.last_sync_at).getTime() : 0;
    const syncIsDue = Date.now() - lastSync >= SYNC_INTERVAL_MS - SYNC_DISPATCH_GRACE_MS;
    const requiresManualReconnect =
      account.last_error?.includes("session expired") && !account.auto_relogin;
    if (syncIsDue && !requiresManualReconnect) {
      return;
    }
    await sendConfiguredReminders(env, account.chat_id, account.reminder_hours);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const authenticationFailed =
      message.includes("session expired") || message.includes("automatic re-login failed");
    if (authenticationFailed && !account.last_error) {
      try {
        await send(env, account.chat_id, "⚠️ Your VOLP session expired. Use /connect to reconnect and resume automatic checks.");
      } catch {
        // A blocked or deleted Telegram chat must not stop other users.
      }
    }
  } finally {
    await releaseSyncLock(env, account.chat_id);
  }
}

async function runScheduled(env: Env) {
  const dueBefore = new Date(Date.now() - (SYNC_INTERVAL_MS - SYNC_DISPATCH_GRACE_MS)).toISOString();
  const redispatchBefore = new Date(Date.now() - 30 * 60_000).toISOString();
  const istNow = istDateAndHour();
  const accounts = await env.DB.prepare(
    `SELECT a.chat_id, a.last_sync_at, a.last_error, a.auto_relogin,
            COALESCE(u.reminder_hours, ?) AS reminder_hours
     FROM volp_accounts a LEFT JOIN users u ON u.chat_id=a.chat_id`
  ).bind(DEFAULT_REMINDER_HOURS).all<ScheduledAccount & { sync_enqueued_at: string | null }>();

  if (!isVolpMaintenanceWindow()) {
    const due = await env.DB.prepare(
      `SELECT chat_id FROM volp_accounts
       WHERE (last_sync_at IS NULL OR last_sync_at<?)
         AND (sync_enqueued_at IS NULL OR sync_enqueued_at<?)
         AND NOT (auto_relogin=0 AND last_error LIKE '%session expired%')
       LIMIT 100`
    ).bind(dueBefore, redispatchBefore).all<{ chat_id: number }>();
    if (due.results.length) {
      const enqueuedAt = new Date().toISOString();
      await env.DB.batch(due.results.map((account) =>
        env.DB.prepare("UPDATE volp_accounts SET sync_enqueued_at=? WHERE chat_id=?")
          .bind(enqueuedAt, account.chat_id)
      ));
      try {
        await env.SYNC_QUEUE.sendBatch(due.results.map((account) => ({
          body: { chatId: account.chat_id, enqueuedAt }
        })));
      } catch (error) {
        await env.DB.batch(due.results.map((account) =>
          env.DB.prepare(
            "UPDATE volp_accounts SET sync_enqueued_at=NULL WHERE chat_id=? AND sync_enqueued_at=?"
          ).bind(account.chat_id, enqueuedAt)
        ));
        throw error;
      }
    }
  }

  for (const account of accounts.results) {
    try {
      await sendConfiguredReminders(env, account.chat_id, account.reminder_hours);
    } catch {
      // One unavailable Telegram chat must not stop reminders for other users.
    }
    if (istNow.hour === 8) {
      try {
        await sendDailyDigest(env, account.chat_id, istNow.date);
      } catch {
        // The next cron invocation within the hour can retry this user's digest.
      }
    }
  }
  const now = new Date().toISOString();
  const updateCutoff = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
  const digestCutoff = new Date(Date.now() - 45 * 24 * 60 * 60_000).toISOString().slice(0, 10);
  const assignmentCutoff = new Date(Date.now() - MISSED_ASSIGNMENT_RETENTION_MS).toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM setup_tokens WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM sync_locks WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM telegram_updates WHERE received_at < ?").bind(updateCutoff),
    env.DB.prepare("DELETE FROM sync_runs WHERE status<>'running' AND completed_at < ?").bind(updateCutoff),
    env.DB.prepare("DELETE FROM daily_digest_log WHERE digest_date < ?").bind(digestCutoff),
    env.DB.prepare("DELETE FROM assignments WHERE due_at < ?").bind(assignmentCutoff),
    env.DB.prepare("DELETE FROM assignments WHERE due_at < ? AND submitted=1").bind(now),
    env.DB.prepare(
      `DELETE FROM sent_notifications
       WHERE NOT EXISTS (
         SELECT 1 FROM assignments a
         WHERE a.chat_id=sent_notifications.chat_id
           AND a.assignment_key=sent_notifications.assignment_key
       )`
    ),
    env.DB.prepare(
      `DELETE FROM new_assignment_notifications
       WHERE NOT EXISTS (
         SELECT 1 FROM assignments a
         WHERE a.chat_id=new_assignment_notifications.chat_id
           AND a.assignment_key=new_assignment_notifications.assignment_key
       )`
    )
  ]);
}

async function connectGet(env: Env, token: string) {
  const row = await env.DB.prepare("SELECT token FROM setup_tokens WHERE token=? AND expires_at>?").bind(token, new Date().toISOString()).first();
  if (!row) return html(page(`<section class="state-card"><div class="state-icon" aria-hidden="true">⌛</div><h1>Link expired</h1><p class="lede">Return to Telegram and send <b>/connect</b> to create a fresh secure link.</p></section>`), 410);
  return html(page(`<p class="signin-title">SIGN <span>IN</span></p>
    <form id="connect-form">
      <input type="hidden" id="setup-token" value="${escapeHtml(token)}">
      <div class="field-row"><span class="field-icon material-icons" aria-hidden="true">person</span><label for="username"><span class="sr-only">VOLP username</span><input id="username" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="VOLP username" required maxlength="160"></label><span></span></div>
      <div class="field-row"><span class="field-icon material-icons" aria-hidden="true">lock</span><label for="password"><span class="sr-only">VOLP password</span><input id="password" type="password" name="password" autocomplete="current-password" placeholder="VOLP password" required maxlength="300"></label><button class="eye-toggle" type="button" aria-label="Show password" aria-pressed="false"><span class="material-icons visibility-on" aria-hidden="true">visibility</span><span class="material-icons visibility-off" aria-hidden="true">visibility_off</span></button></div>
      <button class="submit-button" type="submit">SIGN IN</button>
    </form>
    <p id="status" class="status note" role="status" aria-live="polite"></p>
    <a class="forgot" href="https://classroom.volp.in/login" target="_blank" rel="noopener noreferrer">Forgot Password?</a>
    <div class="support-copy"><p>FOR ANY QUERY PLEASE FILL THE FORM LINK</p><p class="cache-note">Note: If page / button is not responding, press Ctrl + Shift + R to clear the web cache</p></div>
    <script>
    const form = document.getElementById("connect-form");
    const status = document.getElementById("status");
    const password = document.getElementById("password");
    const eyeToggle = form.querySelector(".eye-toggle");
    const telegramApp = window.Telegram?.WebApp;
    if (telegramApp?.initData) {
      telegramApp.ready();
      telegramApp.expand();
      const externalUrl = window.location.href;
      if (telegramApp.openLink) {
        setTimeout(() => {
          try {
            telegramApp.openLink(externalUrl);
          } catch (_) {
            // Some Telegram clients may block automatic external navigation.
          }
        }, 150);
      }
    }
    eyeToggle.addEventListener("click", () => {
      const showing = password.type === "text";
      password.type = showing ? "password" : "text";
      eyeToggle.setAttribute("aria-label", showing ? "Show password" : "Hide password");
      eyeToggle.setAttribute("aria-pressed", String(!showing));
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      button.textContent = "SIGNING IN…";
      status.textContent = "";
      const data = new FormData(form);
      try {
        const login = await fetch("https://admin.volp.in/login/process", {
          method: "POST",
          headers: {
            "Accept": "application/json, text/plain, */*",
            "Content-Type": "application/json;charset=utf-8",
            "organization-code": "null",
            "device": "Web",
            "router-path": "/",
            "latitude": "NA",
            "longitude": "NA"
          },
          body: JSON.stringify({ username: data.get("username"), pwd: data.get("password") })
        });
        const auth = await login.json();
        if (auth.flag !== "YES" || !auth.token) throw new Error("VOLP rejected the login");
        const saved = await fetch("/connect-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            setupToken: document.getElementById("setup-token").value,
            username: data.get("username"),
            uid: auth.uid || data.get("username"),
            volpToken: auth.token,
            password: data.get("password")
          })
        });
        if (!saved.ok) throw new Error("Could not save the VOLP session");
        document.getElementById("page-content").innerHTML =
          '<section class="state-card success"><div class="state-icon" aria-hidden="true">✓</div><h1>VOLP connected</h1><p class="lede">You can return to Telegram now. The bot is loading your assignments and automatic re-login is enabled.</p><p class="note">Send <b>/disconnect</b> anytime to erase your saved credentials and assignment data.</p></section>';
      } catch (error) {
        status.textContent = "Login failed or VOLP is unavailable. Please try again later.";
        status.className = "status error";
        button.disabled = false;
        button.textContent = "SIGN IN";
      }
    });
    </script>`));
}

async function connectSession(request: Request, env: Env) {
  const body = await request.json<any>();
  const token = String(body.setupToken ?? "");
  const username = String(body.username ?? "").trim();
  const uid = String(body.uid ?? "").trim();
  const volpToken = String(body.volpToken ?? "");
  const password = String(body.password ?? "");
  const setup = await env.DB.prepare("SELECT chat_id FROM setup_tokens WHERE token=? AND expires_at>?").bind(token, new Date().toISOString()).first<{ chat_id: number }>();
  if (
    !setup || !username || !uid || !volpToken ||
    username.length > 160 || uid.length > 300 || volpToken.length > 10_000 ||
    !password || password.length > 300
  ) {
    return json({ error: "Invalid or expired setup" }, 400);
  }
  if (!(await hasConnectionCapacity(env, setup.chat_id))) {
    return json({ error: "Bot capacity reached; new connections are temporarily closed" }, 503);
  }
  try {
    const candidateSession = { token: volpToken, uid };
    const validation = await postVolp(
      "https://learner.volp.in/learnerCourseDashboard/learnerCourseList",
      {},
      candidateSession,
      "/learner/my-courses"
    );
    if (!Array.isArray(validation.col_list)) throw new Error("Invalid VOLP session");
    const claimedSetup = await env.DB.prepare(
      "DELETE FROM setup_tokens WHERE token=? AND expires_at>? RETURNING chat_id"
    ).bind(token, new Date().toISOString()).first<{ chat_id: number }>();
    if (!claimedSetup) return json({ error: "Setup link was already used or expired" }, 409);

    const existing = await env.DB.prepare(
      "SELECT uid FROM volp_accounts WHERE chat_id=?"
    ).bind(claimedSetup.chat_id).first<{ uid: string }>();
    const duplicateAccounts = await env.DB.prepare(
      "SELECT chat_id FROM volp_accounts WHERE lower(uid)=lower(?) AND chat_id<>?"
    ).bind(uid, claimedSetup.chat_id).all<{ chat_id: number }>();
    const accountChanged = Boolean(existing && existing.uid.toLowerCase() !== uid.toLowerCase());
    const encrypted = await encryptSecret(candidateSession.token, env.CREDENTIAL_KEY);
    const encryptedPassword = await encryptSecret(password, env.CREDENTIAL_KEY);
    const writes = [];
    if (accountChanged) {
      writes.push(
        env.DB.prepare("DELETE FROM sent_notifications WHERE chat_id=?").bind(claimedSetup.chat_id),
        env.DB.prepare("DELETE FROM new_assignment_notifications WHERE chat_id=?").bind(claimedSetup.chat_id),
        env.DB.prepare("DELETE FROM daily_digest_log WHERE chat_id=?").bind(claimedSetup.chat_id),
        env.DB.prepare("DELETE FROM assignments WHERE chat_id=?").bind(claimedSetup.chat_id),
        env.DB.prepare("DELETE FROM sync_runs WHERE chat_id=?").bind(claimedSetup.chat_id)
      );
    }
    for (const duplicateAccount of duplicateAccounts.results) {
      writes.push(
        env.DB.prepare("DELETE FROM sent_notifications WHERE chat_id=?").bind(duplicateAccount.chat_id),
        env.DB.prepare("DELETE FROM new_assignment_notifications WHERE chat_id=?").bind(duplicateAccount.chat_id),
        env.DB.prepare("DELETE FROM daily_digest_log WHERE chat_id=?").bind(duplicateAccount.chat_id),
        env.DB.prepare("DELETE FROM assignments WHERE chat_id=?").bind(duplicateAccount.chat_id),
        env.DB.prepare("DELETE FROM sync_runs WHERE chat_id=?").bind(duplicateAccount.chat_id),
        env.DB.prepare("DELETE FROM volp_accounts WHERE chat_id=?").bind(duplicateAccount.chat_id),
        env.DB.prepare("DELETE FROM setup_tokens WHERE chat_id=?").bind(duplicateAccount.chat_id),
        env.DB.prepare("DELETE FROM sync_locks WHERE chat_id=?").bind(duplicateAccount.chat_id)
      );
    }
    writes.push(env.DB.prepare(
      `INSERT INTO volp_accounts(
         chat_id,username,uid,encrypted_token,encrypted_password,auto_relogin,connected_at
       )
       VALUES(?,?,?,?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET
       username=excluded.username,uid=excluded.uid,encrypted_token=excluded.encrypted_token,
       encrypted_password=excluded.encrypted_password,auto_relogin=excluded.auto_relogin,
       connected_at=excluded.connected_at,last_reauth_at=NULL,last_sync_at=NULL,last_error=NULL`
    ).bind(
      claimedSetup.chat_id,
      username,
      uid,
      encrypted,
      encryptedPassword,
      1,
      new Date().toISOString()
    ));
    await env.DB.batch(writes);
    for (const duplicateAccount of duplicateAccounts.results) {
      try {
        await send(
          env,
          duplicateAccount.chat_id,
          "⚠️ This VOLP account was connected to another Telegram chat, so it was disconnected here. VOLP allows only one active session for this account."
        );
      } catch {
        // The previous Telegram chat may no longer be reachable.
      }
    }
    const enqueuedAt = new Date().toISOString();
    await env.DB.prepare(
      "UPDATE volp_accounts SET sync_enqueued_at=? WHERE chat_id=?"
    ).bind(enqueuedAt, claimedSetup.chat_id).run();
    let initialSyncQueued = true;
    try {
      await env.SYNC_QUEUE.send({
        chatId: claimedSetup.chat_id,
        initial: true,
        enqueuedAt
      });
    } catch {
      initialSyncQueued = false;
      await env.DB.prepare(
        "UPDATE volp_accounts SET sync_enqueued_at=NULL WHERE chat_id=? AND sync_enqueued_at=?"
      ).bind(claimedSetup.chat_id, enqueuedAt).run();
    }
    await send(
      env,
      claimedSetup.chat_id,
      `${accountChanged ? "🔄 VOLP account switched." : "✅ VOLP connected."} Automatic re-login is enabled with encrypted password storage.\n\n${initialSyncQueued
        ? "I’ve queued your first assignment sync and will message you when it finishes. After that, I’ll check every 3 hours."
        : "I couldn’t queue your first assignment sync. Please send /sync in Telegram."}\n\n⏰ <b>Choose an additional reminder time below</b> (1–10 hours before the deadline). Everyone also receives the standard 1-hour reminder. Choosing 1h sends only one alert.`,
      reminderKeyboard(DEFAULT_REMINDER_HOURS)
    );
    return json({ ok: true });
  } catch (error) {
    if (error instanceof Error && error.message.includes("BOT_CAPACITY_REACHED")) {
      return json({ error: "Bot capacity reached; new connections are temporarily closed" }, 503);
    }
    return json({ error: "VOLP session validation failed" }, 401);
  }
}

async function processTelegramUpdate(env: Env, update: any, origin: string) {
  let status = "done";
  try {
    const chat = update.message?.chat ?? update.callback_query?.message?.chat;
    if (chat && chat.type !== "private") {
      await send(env, chat.id, "🔒 For privacy, VOLP connections and assignments only work in a private chat with this bot.");
      return;
    }
    if (update.message?.text) {
      await handleCommand(env, update.message.chat.id, update.message.text, origin);
    } else if (update.callback_query) {
      await handleCallback(env, update.callback_query);
    }
  } catch (error) {
    status = "failed";
    console.error("Telegram update failed", error instanceof Error ? error.message : "unknown error");
    const chatId = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
    if (chatId) {
      try {
        await send(env, chatId, "⚠️ Something went wrong while processing that request. Please try again.");
      } catch {
        // The user may have blocked the bot; the webhook still remains healthy.
      }
    }
  } finally {
    await env.DB.prepare(
      "UPDATE telegram_updates SET status=?,processed_at=? WHERE update_id=?"
    ).bind(status, new Date().toISOString(), update.update_id).run();
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return Response.redirect(`${url.origin}/bot`, 302);
    }
    if (request.method === "GET" && url.pathname === "/health") return json({ ok: true });
    if (request.method === "GET" && url.pathname === "/bot") {
      await configureTelegram(env, url.origin);
      const info: any = await telegram(env, "getMe", {});
      return Response.redirect(`https://t.me/${info.result.username}`, 302);
    }
    if (request.method === "POST" && url.pathname === "/telemetry/v1") {
      if (url.origin !== TELEMETRY_ORIGIN) return new Response("Not found", { status: 404 });
      return collectUsageTelemetry(request, env);
    }
    const shortConnect = request.method === "GET" ? url.pathname.match(/^\/c\/([A-Za-z0-9_-]{22})$/) : null;
    if (shortConnect) return connectGet(env, shortConnect[1]);
    // Keep already-issued setup links working until their 15-minute expiry.
    if (url.pathname === "/connect" && request.method === "GET") return connectGet(env, url.searchParams.get("token") ?? "");
    if (url.pathname === "/connect-session" && request.method === "POST") return connectSession(request, env);
    if (request.method !== "POST" || url.pathname !== `/webhook/${env.WEBHOOK_SECRET}`) return new Response("Not found", { status: 404 });
    if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) return new Response("Forbidden", { status: 403 });
    const update: any = await request.json();
    if (!Number.isInteger(update.update_id)) return new Response("Bad Request", { status: 400 });
    const claimed = await env.DB.prepare(
      "INSERT OR IGNORE INTO telegram_updates(update_id,status,received_at) VALUES(?,'processing',?)"
    ).bind(update.update_id, new Date().toISOString()).run();
    if (claimed.meta.changes === 1) {
      ctx.waitUntil(processTelegramUpdate(env, update, url.origin));
    }
    return new Response("ok");
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(env));
    ctx.waitUntil(sendUsageTelemetry(env).catch((error) => {
      console.error("Anonymous usage telemetry failed", error instanceof Error ? error.message : "unknown error");
    }));
  },

  async queue(batch: MessageBatch<SyncJob>, env: Env) {
    for (const message of batch.messages) {
      if (message.body.kind === "sync-result") {
        try {
          await deliverSyncResult(env, message.body.chatId, message.body.initial === true);
          message.ack();
        } catch (error) {
          const detail = error instanceof Error ? error.message : "unknown error";
          console.error(
            "Sync result delivery failed",
            `attempt=${message.attempts}`,
            detail
          );
          if (message.attempts >= 3) {
            message.ack();
          } else {
            message.retry({ delaySeconds: 60 });
          }
        }
        continue;
      }
      if (message.body.kind === "sync-course" || message.body.kind === "sync-finalize") {
        try {
          if (message.body.kind === "sync-course") {
            await processSyncCourseJob(env, message.body);
          } else {
            await processSyncFinalizeJob(env, message.body);
          }
          message.ack();
        } catch (error) {
          const detail = error instanceof Error ? error.message : "";
          const coolingDown = detail.includes("automatic re-login is cooling down");
          if (coolingDown) {
            const account = await env.DB.prepare(
              "SELECT last_reauth_at FROM volp_accounts WHERE chat_id=?"
            ).bind(message.body.chatId).first<{ last_reauth_at: string | null }>();
            const retryAt = account?.last_reauth_at
              ? new Date(account.last_reauth_at).getTime() + 15 * 60_000
              : Date.now() + 60_000;
            const retryDelaySeconds = Math.max(
              60,
              Math.min(15 * 60, Math.ceil((retryAt - Date.now()) / 1000) + 5)
            );
            message.retry({ delaySeconds: retryDelaySeconds });
            continue;
          }
          const permanent =
            detail.includes("session expired") ||
            detail.includes("automatic re-login failed") ||
            detail.includes("VOLP account is not connected") ||
            detail.includes("VOLP account changed during sync");
          const exhausted = message.attempts >= 3;
          if (permanent || exhausted) {
            await env.DB.prepare(
              "UPDATE sync_runs SET status='failed',completed_at=? WHERE run_id=? AND status='running'"
            ).bind(new Date().toISOString(), message.body.runId).run();
            await clearSyncEnqueued(env, message.body);
            message.ack();
            if (message.body.manual || message.body.initial) {
              try {
                await send(
                  env,
                  message.body.chatId,
                  permanent
                    ? "âš ï¸ Your VOLP session is no longer valid. Use /connect to reconnect."
                    : "âš ï¸ VOLP did not finish syncing after several attempts. Please try /sync again later."
                );
              } catch {
                // The user may have blocked the bot.
              }
            }
          } else {
            message.retry({ delaySeconds: detail.includes("already in progress") ? 60 : 300 });
          }
        }
        continue;
      }
      if (isVolpMaintenanceWindow()) {
        if (message.body.initial) {
          try {
            const now = new Date();
            const istMinutes = (now.getUTCHours() * 60 + now.getUTCMinutes() + 330) % (24 * 60);
            const delaySeconds = Math.max(60, (VOLP_MAINTENANCE_END_MINUTE_IST - istMinutes) * 60 + 30);
            await env.SYNC_QUEUE.send(message.body, { delaySeconds });
            message.ack();
            try {
              await send(env, message.body.chatId, VOLP_MAINTENANCE_MESSAGE);
            } catch {
              // The user may have blocked the bot.
            }
          } catch {
            message.retry({ delaySeconds: 300 });
          }
          continue;
        }
        await clearSyncEnqueued(env, message.body);
        message.ack();
        if (message.body.manual) {
          try {
            await send(env, message.body.chatId, VOLP_MAINTENANCE_MESSAGE);
          } catch {
            // A blocked or deleted Telegram chat must not delay the queue.
          }
        }
        continue;
      }
      try {
        const userRequestedResult = message.body.manual === true || message.body.initial === true;
        const forceSync = userRequestedResult || message.body.assignmentRefresh === true;
        const started = await startChunkedSync(env, message.body, forceSync);
        if (!started) await clearSyncEnqueued(env, message.body);
        message.ack();
      } catch (error) {
        const detail = error instanceof Error ? error.message : "";
        const coolingDown = detail.includes("automatic re-login is cooling down");
        if (coolingDown) {
          const account = await env.DB.prepare(
            "SELECT last_reauth_at FROM volp_accounts WHERE chat_id=?"
          ).bind(message.body.chatId).first<{ last_reauth_at: string | null }>();
          const retryAt = account?.last_reauth_at
            ? new Date(account.last_reauth_at).getTime() + 15 * 60_000
            : Date.now() + 60_000;
          const retryDelaySeconds = Math.max(
            60,
            Math.min(15 * 60, Math.ceil((retryAt - Date.now()) / 1000) + 5)
          );
          if ((message.body.manual || message.body.initial || message.body.assignmentRefresh) && message.attempts === 1) {
            try {
              await send(
                env,
                message.body.chatId,
                `🔐 Your VOLP session expired. Automatic login is cooling down, so I’ll retry in about ${Math.ceil(retryDelaySeconds / 60)} minute${retryDelaySeconds > 60 ? "s" : ""}.`
              );
            } catch {
              // The user may have blocked the bot.
            }
          }
          message.retry({ delaySeconds: retryDelaySeconds });
          continue;
        }
        const permanent =
          detail.includes("session expired") ||
          detail.includes("automatic re-login failed") ||
          detail.includes("VOLP account is not connected");
        const exhausted = message.attempts >= 3;
        if (permanent || exhausted) {
          await clearSyncEnqueued(env, message.body);
          message.ack();
          if (message.body.manual || message.body.initial || message.body.assignmentRefresh) {
            try {
              await send(
                env,
                message.body.chatId,
                permanent
                  ? "⚠️ Your VOLP session is no longer valid. Use /connect to reconnect."
                  : "⚠️ VOLP did not finish syncing after several attempts. Please try /sync again later."
              );
            } catch {
              // The user may have blocked the bot.
            }
          }
        } else {
          message.retry({ delaySeconds: detail.includes("already in progress") ? 60 : 300 });
        }
      }
    }
  }
};
