interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  CREDENTIAL_KEY: string;
}

type VolpSession = { token: string; uid: string };
type Assignment = {
  key: string;
  title: string;
  course: string;
  type: string;
  dueAt: Date;
  submitted: boolean;
};
type ReminderMinutes = 60 | 90 | 120;

const BASE_HEADERS: Record<string, string> = {
  Accept: "application/json, text/plain, */*",
  "Content-Type": "application/json;charset=utf-8",
  "organization-code": "null",
  device: "Web",
  Origin: "https://classroom.volp.in",
  Referer: "https://classroom.volp.in/"
};
const DEFAULT_REMINDER_MINUTES: ReminderMinutes = 90;
const REMINDER_OPTIONS: ReminderMinutes[] = [60, 90, 120];
const REPOSITORY_URL = "https://github.com/nemesis0007/volp-telegram-reminder-bot";

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

function html(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self' https://admin.volp.in; form-action 'self'; base-uri 'none'"
    }
  });
}

function page(content: string) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Connect VOLP</title><style>
  body{font:16px system-ui;background:#f4f6fb;color:#172033;margin:0;padding:24px}
  main{max-width:430px;margin:8vh auto;background:white;padding:28px;border-radius:18px;box-shadow:0 12px 40px #17203318}
  h1{margin-top:0}label{display:block;font-weight:650;margin-top:16px}input{box-sizing:border-box;width:100%;padding:12px;margin-top:6px;border:1px solid #cbd2df;border-radius:10px;font:inherit}
  button{width:100%;padding:13px;margin-top:22px;border:0;border-radius:10px;background:#2864dc;color:white;font:inherit;font-weight:700}
  p{line-height:1.5}.note{font-size:13px;color:#596579}.error{color:#b42318}
  </style></head><body><main>${content}</main></body></html>`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
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

function parseDueDate(value: unknown): Date | null {
  if (!value) return null;
  const raw = String(value).trim();
  const direct = new Date(raw);
  if (!Number.isNaN(direct.getTime())) return direct;
  const match = raw.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?/i);
  if (!match) return null;
  let hour = Number(match[4] ?? 23);
  const marker = match[7]?.toUpperCase();
  if (marker === "PM" && hour < 12) hour += 12;
  if (marker === "AM" && hour === 12) hour = 0;
  // VOLP dates are interpreted as IST.
  return new Date(Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1]), hour - 5, Number(match[5] ?? 59) - 30, Number(match[6] ?? 0)));
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
      if (response.ok) return response.json<any>();
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
        { command: "sync", description: "Check VOLP now" },
        { command: "settings", description: "Choose reminder timing" },
        { command: "about", description: "About this bot and its privacy" },
        { command: "disconnect", description: "Delete your VOLP connection and data" }
      ]
    }),
    telegram(env, "setMyDescription", {
      description: "Checks VOLP every hour for upcoming assignments and sends private deadline reminders at the time you choose."
    }),
    telegram(env, "setMyShortDescription", {
      short_description: "Hourly VOLP assignment checks with personal deadline reminders."
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
  const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  const expires = new Date(Date.now() + 15 * 60_000).toISOString();
  await env.DB.prepare("DELETE FROM setup_tokens WHERE chat_id=? OR expires_at < ?").bind(chatId, new Date().toISOString()).run();
  await env.DB.prepare("INSERT INTO setup_tokens(token,chat_id,expires_at) VALUES(?,?,?)").bind(token, chatId, expires).run();
  return `${origin}/connect?token=${token}`;
}

function reminderKeyboard(current?: number) {
  return {
    inline_keyboard: [
      REMINDER_OPTIONS.map((minutes) => ({
        text: `${minutes === 90 ? "1.5" : minutes / 60} hour${minutes === 60 ? "" : "s"}${current === minutes ? " ✓" : ""}`,
        callback_data: `reminder:${minutes}`
      }))
    ]
  };
}

async function showSettings(env: Env, chatId: number) {
  const user = await env.DB.prepare("SELECT reminder_minutes FROM users WHERE chat_id=?").bind(chatId).first<{ reminder_minutes: number }>();
  const current = user?.reminder_minutes ?? DEFAULT_REMINDER_MINUTES;
  return send(
    env,
    chatId,
    `⚙️ <b>Reminder timing</b>\n\nCurrent setting: <b>${current === 90 ? "1.5" : current / 60} hour${current === 60 ? "" : "s"} before the deadline</b>.\n\nChoose when you want your reminder:`,
    reminderKeyboard(current)
  );
}

async function handleCallback(env: Env, callback: any) {
  const chatId = callback.message?.chat?.id;
  const match = String(callback.data ?? "").match(/^reminder:(60|90|120)$/);
  if (!chatId || !match) {
    return telegram(env, "answerCallbackQuery", { callback_query_id: callback.id });
  }
  const minutes = Number(match[1]) as ReminderMinutes;
  await env.DB.prepare(
    `INSERT INTO users(chat_id,created_at,reminder_minutes) VALUES(?,?,?)
     ON CONFLICT(chat_id) DO UPDATE SET reminder_minutes=excluded.reminder_minutes`
  ).bind(chatId, new Date().toISOString(), minutes).run();
  await telegram(env, "answerCallbackQuery", {
    callback_query_id: callback.id,
    text: `Reminder set to ${minutes === 90 ? "1.5" : minutes / 60} hour${minutes === 60 ? "" : "s"} before`
  });
  return showSettings(env, chatId);
}

async function sendAssignments(env: Env, chatId: number) {
  const rows = await env.DB.prepare(
    "SELECT title,course,assignment_type,due_at FROM assignments WHERE chat_id=? AND submitted=0 AND due_at>? ORDER BY due_at LIMIT 15"
  ).bind(chatId, new Date().toISOString()).all<any>();
  if (!rows.results.length) {
    return send(env, chatId, "No upcoming assignments found. Use /sync to check VOLP now.");
  }
  const lines = rows.results.map(
    (assignment) =>
      `• <b>${escapeHtml(assignment.title)}</b>\n  ${escapeHtml(assignment.course)} · ${new Date(assignment.due_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`
  );
  return send(env, chatId, `📚 <b>Upcoming assignments</b>\n\n${lines.join("\n\n")}`);
}

async function handleCommand(env: Env, chatId: number, text: string, origin: string) {
  const command = text.trim().split(/\s+/)[0].split("@")[0].toLowerCase();
  if (command === "/start" || command === "/connect") {
    if (command === "/start") await configureTelegram(env, origin);
    await env.DB.prepare(
      "INSERT OR IGNORE INTO users(chat_id,created_at,reminder_minutes) VALUES(?,?,?)"
    ).bind(chatId, new Date().toISOString(), DEFAULT_REMINDER_MINUTES).run();
    const link = await makeSetupLink(env, chatId, origin);
    return send(env, chatId,
      `👋 <b>VOLP Assignment Reminder</b>\n\nConnect your VOLP account using the private link below. It expires in 15 minutes.\n\nYour password goes directly from your browser to VOLP. This bot never receives or stores it.`,
      { inline_keyboard: [[{ text: "Connect VOLP 🔐", url: link }], [{ text: "Choose reminder time", callback_data: "reminder:90" }]] });
  }
  if (command === "/assignments") {
    const account = await env.DB.prepare(
      "SELECT last_sync_at FROM volp_accounts WHERE chat_id=?"
    ).bind(chatId).first<{ last_sync_at: string | null }>();
    if (account && !account.last_sync_at) {
      return send(env, chatId, "⏳ Your first VOLP sync is still loading assignments. I’ll send them automatically when it finishes.");
    }
    return sendAssignments(env, chatId);
  }
  if (command === "/sync") {
    if (!(await acquireSyncLock(env, chatId))) {
      return send(env, chatId, "⏳ I’m already checking VOLP for you. Please wait for the result.");
    }
    await send(env, chatId, "Checking VOLP…");
    try {
      await syncUser(env, chatId);
      return sendAssignments(env, chatId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("session expired") || message.includes("not connected")) {
        const link = await makeSetupLink(env, chatId, origin);
        return send(
          env,
          chatId,
          "⚠️ Your VOLP session is no longer valid. Reconnect using the private link below.",
          { inline_keyboard: [[{ text: "Reconnect VOLP 🔐", url: link }]] }
        );
      }
      return send(env, chatId, "⚠️ VOLP is unavailable or the sync failed. Please try /sync again later.");
    } finally {
      await releaseSyncLock(env, chatId);
    }
  }
  if (command === "/settings" || command === "/reminder") {
    return showSettings(env, chatId);
  }
  if (command === "/about") {
    return send(
      env,
      chatId,
      `ℹ️ <b>About VOLP Assignment Reminder</b>\n\nI check VOLP every hour, list upcoming hands-on and subjective assignments, and remind each user at their chosen time.\n\nPasswords go directly from the browser to VOLP and are never received or stored by this bot. VOLP session tokens are encrypted.\n\nOpen-source and unaffiliated with VOLP or VIT.\n\n<a href="${REPOSITORY_URL}">View source code on GitHub</a>`
    );
  }
  if (command === "/disconnect") {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM volp_accounts WHERE chat_id=?").bind(chatId),
      env.DB.prepare("DELETE FROM assignments WHERE chat_id=?").bind(chatId),
      env.DB.prepare("DELETE FROM setup_tokens WHERE chat_id=?").bind(chatId)
    ]);
    return send(env, chatId, "Your stored VOLP credentials and assignment data were deleted.");
  }
  return send(env, chatId, "Commands: /connect, /assignments, /sync, /settings, /about, /disconnect");
}

function collectHandsOn(
  found: Assignment[],
  items: any[],
  courseName: string,
  fallbackId: string | number
) {
  for (const item of items) {
    const dueAt = parseDueDate(item.duedate);
    if (!dueAt || dueAt.getTime() <= Date.now()) continue;
    const title = stripHtml(item.assignment_text) || "Hands-on assignment";
    found.push({
      key: `hands:${item.ass_id ?? item.id ?? `${fallbackId}:${title.slice(0, 80)}`}`,
      title,
      course: courseName,
      type: "Hands-on",
      dueAt,
      submitted: Boolean(item.filePath || item.isevaluated)
    });
  }
}

async function fetchAssignments(session: VolpSession): Promise<Assignment[]> {
  const courseData = await postVolp(
    "https://learner.volp.in/learnerCourseDashboard/learnerCourseList", {}, session, "/learner/my-courses"
  );
  if (!Array.isArray(courseData.col_list)) {
    throw new Error("VOLP session expired. Use /connect to reconnect.");
  }
  // VOLP reports some newly registered/current courses with a falsy
  // course_status even though they are available to the learner.
  const courses = (courseData.col_list ?? []).filter((course: any) => !course.is_archived);
  const found: Assignment[] = [];
  for (const course of courses) {
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
    for (const unit of content.unit_level ?? []) {
      if (!(unit.assigns?.hands ?? []).length) continue;
      const data = await postVolp(
        "https://learner.volp.in/HandOnAssignment/getHandsOnDetails",
        { course_offering_learner_id: course.colid, outline: unit.unit_id, type: "content" },
        session, "/learner-handson-assignment"
      );
      collectHandsOn(found, data.ass_list ?? [], courseName, unit.unit_id);
    }
    if (!courseId || (content.course_level?.assigns?.proj?.length ?? 0) === 0) continue;
    const subjective = await postVolp(
      "https://learner.volp.in/SubjectiveAssignment/getSubjectiveAssignment_new",
      { course_offering_learner_id: course.colid, courseId, type: "content" },
      session, "/learner-subjective-assignment"
    );
    for (const item of subjective.question_list ?? []) {
      const dueAt = parseDueDate(item.due_date);
      if (!dueAt || dueAt.getTime() <= Date.now()) continue;
      found.push({
        key: `subjective:${item.question_id ?? item.id ?? `${courseId}:${stripHtml(item.question).slice(0, 80)}`}`,
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

async function syncUser(env: Env, chatId: number) {
  const account = await env.DB.prepare("SELECT uid,encrypted_token FROM volp_accounts WHERE chat_id=?").bind(chatId).first<any>();
  if (!account) throw new Error("VOLP account is not connected");
  try {
    const token = await decryptSecret(account.encrypted_token, env.CREDENTIAL_KEY);
    const session = { token, uid: account.uid };
    const assignments = await fetchAssignments(session);
    const now = new Date().toISOString();
    const writes = assignments.map((item) =>
      env.DB.prepare(
        `INSERT INTO assignments(chat_id,assignment_key,title,course,assignment_type,due_at,submitted,updated_at)
         VALUES(?,?,?,?,?,?,?,?)
         ON CONFLICT(chat_id,assignment_key) DO UPDATE SET
         title=excluded.title,course=excluded.course,assignment_type=excluded.assignment_type,
         due_at=excluded.due_at,submitted=excluded.submitted,updated_at=excluded.updated_at`
      ).bind(chatId, item.key, item.title, item.course, item.type, item.dueAt.toISOString(), item.submitted ? 1 : 0, now)
    );
    if (writes.length) await env.DB.batch(writes);
    await env.DB.prepare(
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
    ).bind(chatId).run();
    await env.DB.prepare("UPDATE volp_accounts SET last_sync_at=?,last_error=NULL WHERE chat_id=?").bind(now, chatId).run();
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 200) : "Sync failed";
    await env.DB.prepare("UPDATE volp_accounts SET last_error=? WHERE chat_id=?").bind(message, chatId).run();
    throw error;
  }
}

async function sendDueReminders(env: Env, chatId: number, threshold: number) {
  const rows = await env.DB.prepare(
    "SELECT assignment_key,title,course,assignment_type,due_at FROM assignments WHERE chat_id=? AND submitted=0 AND due_at>?"
  ).bind(chatId, new Date().toISOString()).all<any>();
  for (const item of rows.results) {
    const remaining = Math.floor((new Date(item.due_at).getTime() - Date.now()) / 60_000);
    if (remaining > threshold) continue;
    const marked = await env.DB.prepare(
      "INSERT OR IGNORE INTO sent_notifications(chat_id,assignment_key,threshold_minutes,sent_at) VALUES(?,?,?,?)"
    ).bind(chatId, item.assignment_key, threshold, new Date().toISOString()).run();
    if (marked.meta.changes !== 1) continue;
    const label = threshold === 90 ? "1.5 hours" : `${threshold / 60} hour${threshold === 60 ? "" : "s"}`;
    await send(env, chatId,
      `⏰ <b>Assignment due in ${label}</b>\n\n<b>${escapeHtml(item.title)}</b>\n${escapeHtml(item.course)} · ${escapeHtml(item.assignment_type)}\nDue: ${new Date(item.due_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`);
  }
}

async function runScheduled(env: Env) {
  const accounts = await env.DB.prepare(
    `SELECT a.chat_id, COALESCE(u.reminder_minutes, ?) AS reminder_minutes
     FROM volp_accounts a LEFT JOIN users u ON u.chat_id=a.chat_id`
  ).bind(DEFAULT_REMINDER_MINUTES).all<{ chat_id: number; reminder_minutes: number }>();
  for (const account of accounts.results) {
    if (!(await acquireSyncLock(env, account.chat_id))) continue;
    try {
      await syncUser(env, account.chat_id);
      await sendDueReminders(env, account.chat_id, account.reminder_minutes);
    } catch {
      // Error is stored per account; one unavailable account must not stop others.
    } finally {
      await releaseSyncLock(env, account.chat_id);
    }
  }
  const now = new Date().toISOString();
  const updateCutoff = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM setup_tokens WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM sync_locks WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM telegram_updates WHERE received_at < ?").bind(updateCutoff),
    env.DB.prepare("DELETE FROM assignments WHERE due_at < ?").bind(now),
    env.DB.prepare(
      `DELETE FROM sent_notifications
       WHERE NOT EXISTS (
         SELECT 1 FROM assignments a
         WHERE a.chat_id=sent_notifications.chat_id
           AND a.assignment_key=sent_notifications.assignment_key
       )`
    )
  ]);
}

async function connectGet(env: Env, token: string) {
  const row = await env.DB.prepare("SELECT token FROM setup_tokens WHERE token=? AND expires_at>?").bind(token, new Date().toISOString()).first();
  if (!row) return html(page("<h1>Link expired</h1><p>Return to Telegram and send <b>/connect</b> for a new link.</p>"), 410);
  return html(page(`<h1>Connect through VOLP</h1>
    <p>Your password is sent <b>directly to VOLP</b>. This bot receives only VOLP's temporary session token.</p>
    <form id="connect-form">
      <input type="hidden" id="setup-token" value="${escapeHtml(token)}">
      <label>VOLP username<input name="username" autocomplete="username" required maxlength="160"></label>
      <label>VOLP password<input type="password" name="password" autocomplete="current-password" required maxlength="300"></label>
      <button type="submit">Sign in directly with VOLP</button>
    </form>
    <p id="status" class="note">The password never passes through this bot's server. You can disconnect anytime with /disconnect.</p>
    <script>
    const form = document.getElementById("connect-form");
    const status = document.getElementById("status");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = form.querySelector("button");
      button.disabled = true;
      status.textContent = "Contacting VOLP…";
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
            volpToken: auth.token
          })
        });
        if (!saved.ok) throw new Error("Could not save the VOLP session");
        document.querySelector("main").innerHTML = "<h1>Connected ✅</h1><p>Your password was never shared with the bot. You can close this page and return to Telegram.</p>";
      } catch (error) {
        status.textContent = "Login failed or VOLP is unavailable. Please try again later.";
        status.className = "error";
        button.disabled = false;
      }
    });
    </script>`));
}

async function runInitialSync(env: Env, chatId: number) {
  if (!(await acquireSyncLock(env, chatId))) return;
  try {
    await syncUser(env, chatId);
    await sendAssignments(env, chatId);
  } catch {
    await send(env, chatId, "⚠️ Your VOLP account connected, but the first assignment sync failed. Please try /sync.");
  } finally {
    await releaseSyncLock(env, chatId);
  }
}

async function connectSession(request: Request, env: Env, ctx: ExecutionContext) {
  const body = await request.json<any>();
  const token = String(body.setupToken ?? "");
  const username = String(body.username ?? "").trim();
  const uid = String(body.uid ?? "").trim();
  const volpToken = String(body.volpToken ?? "");
  const setup = await env.DB.prepare("SELECT chat_id FROM setup_tokens WHERE token=? AND expires_at>?").bind(token, new Date().toISOString()).first<{ chat_id: number }>();
  if (!setup || !username || !uid || !volpToken) return json({ error: "Invalid or expired setup" }, 400);
  try {
    const validation = await postVolp(
      "https://learner.volp.in/learnerCourseDashboard/learnerCourseList",
      {},
      { token: volpToken, uid },
      "/learner/my-courses"
    );
    if (!Array.isArray(validation.col_list)) throw new Error("Invalid VOLP session");
    const encrypted = await encryptSecret(volpToken, env.CREDENTIAL_KEY);
    await env.DB.prepare(
      `INSERT INTO volp_accounts(chat_id,username,uid,encrypted_token,connected_at)
       VALUES(?,?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET
       username=excluded.username,uid=excluded.uid,encrypted_token=excluded.encrypted_token,
       connected_at=excluded.connected_at,last_sync_at=NULL,last_error=NULL`
    ).bind(setup.chat_id, username, uid, encrypted, new Date().toISOString()).run();
    await env.DB.prepare("DELETE FROM setup_tokens WHERE token=?").bind(token).run();
    await send(
      env,
      setup.chat_id,
      "✅ VOLP connected without storing your password. I’m loading your assignments now and will send them automatically.\n\nAfter that, I’ll check every hour. Use /assignments, /sync, or /settings anytime.",
      reminderKeyboard(DEFAULT_REMINDER_MINUTES)
    );
    ctx.waitUntil(runInitialSync(env, setup.chat_id));
    return json({ ok: true });
  } catch {
    return json({ error: "VOLP session validation failed" }, 401);
  }
}

async function processTelegramUpdate(env: Env, update: any, origin: string) {
  let status = "done";
  try {
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
    if (request.method === "GET" && url.pathname === "/health") return json({ ok: true });
    if (request.method === "GET" && url.pathname === "/bot") {
      await configureTelegram(env, url.origin);
      const info: any = await telegram(env, "getMe", {});
      return Response.redirect(`https://t.me/${info.result.username}`, 302);
    }
    if (url.pathname === "/connect" && request.method === "GET") return connectGet(env, url.searchParams.get("token") ?? "");
    if (url.pathname === "/connect-session" && request.method === "POST") return connectSession(request, env, ctx);
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
  }
};
