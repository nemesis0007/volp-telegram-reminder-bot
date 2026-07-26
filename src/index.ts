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

const BASE_HEADERS: Record<string, string> = {
  Accept: "application/json, text/plain, */*",
  "Content-Type": "application/json;charset=utf-8",
  "organization-code": "null",
  device: "Web",
  Origin: "https://classroom.volp.in",
  Referer: "https://classroom.volp.in/"
};
const REMINDER_MINUTES = [2880, 1440, 360, 90];

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
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'"
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

function stripHtml(value: unknown) {
  return String(value ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
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
  const response = await fetch(url, {
    method: "POST",
    headers: volpHeaders(session, route),
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`VOLP request failed (${response.status})`);
  return response.json<any>();
}

async function loginVolp(username: string, password: string): Promise<VolpSession> {
  const data = await postVolp("https://admin.volp.in/login/process", { username, pwd: password });
  if (data.flag !== "YES" || !data.token) throw new Error("VOLP rejected those credentials");
  return { token: data.token, uid: data.uid || username };
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

async function encryptPassword(password: string, secret: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await credentialKey(secret), new TextEncoder().encode(password));
  return `${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(cipher))}`;
}

async function decryptPassword(value: string, secret: string) {
  const [iv, cipher] = value.split(".");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(iv) }, await credentialKey(secret), base64ToBytes(cipher));
  return new TextDecoder().decode(plain);
}

async function telegram(env: Env, method: string, body: Record<string, unknown>) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`Telegram ${method} failed (${response.status})`);
  return response.json();
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

async function handleCommand(env: Env, chatId: number, text: string, origin: string) {
  const command = text.trim().split(/\s+/)[0].split("@")[0].toLowerCase();
  if (command === "/start" || command === "/connect") {
    await env.DB.prepare("INSERT OR IGNORE INTO users(chat_id,created_at) VALUES(?,?)").bind(chatId, new Date().toISOString()).run();
    const link = await makeSetupLink(env, chatId, origin);
    return send(env, chatId,
      `👋 <b>VOLP Assignment Reminder</b>\n\nConnect your VOLP account using the private link below. It expires in 15 minutes.\n\nYour password is sent over HTTPS and encrypted before storage.`,
      { inline_keyboard: [[{ text: "Connect VOLP 🔐", url: link }]] });
  }
  if (command === "/assignments") {
    const rows = await env.DB.prepare(
      "SELECT title,course,assignment_type,due_at FROM assignments WHERE chat_id=? AND submitted=0 AND due_at>? ORDER BY due_at LIMIT 15"
    ).bind(chatId, new Date().toISOString()).all<any>();
    if (!rows.results.length) return send(env, chatId, "No upcoming assignments found. Use /sync to check VOLP now.");
    const lines = rows.results.map((a) => `• <b>${escapeHtml(a.title)}</b>\n  ${escapeHtml(a.course)} · ${new Date(a.due_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`);
    return send(env, chatId, `📚 <b>Upcoming assignments</b>\n\n${lines.join("\n\n")}`);
  }
  if (command === "/sync") {
    await send(env, chatId, "Checking VOLP…");
    await syncUser(env, chatId);
    return handleCommand(env, chatId, "/assignments", origin);
  }
  if (command === "/disconnect") {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM volp_accounts WHERE chat_id=?").bind(chatId),
      env.DB.prepare("DELETE FROM assignments WHERE chat_id=?").bind(chatId),
      env.DB.prepare("DELETE FROM setup_tokens WHERE chat_id=?").bind(chatId)
    ]);
    return send(env, chatId, "Your stored VOLP credentials and assignment data were deleted.");
  }
  return send(env, chatId, "Commands: /connect, /assignments, /sync, /disconnect");
}

async function fetchAssignments(session: VolpSession): Promise<Assignment[]> {
  const courseData = await postVolp(
    "https://learner.volp.in/learnerCourseDashboard/learnerCourseList", {}, session, "/learner/my-courses"
  );
  const courses = (courseData.col_list ?? []).filter((course: any) => course.course_status && !course.is_archived);
  const found: Assignment[] = [];
  for (const course of courses) {
    const courseName = stripHtml(course.course?.course_name) || "Course";
    const content = await postVolp(
      "https://learner.volp.in/learnerCourseContent/courseContentData",
      { colid: course.colid }, session, "/learner-course-content"
    );
    for (const unit of content.unit_level ?? []) {
      if (!(unit.assigns?.hands ?? []).length) continue;
      const data = await postVolp(
        "https://learner.volp.in/HandOnAssignment/getHandsOnDetails",
        { course_offering_learner_id: course.colid, outline: unit.unit_id, type: "content" },
        session, "/learner-handson-assignment"
      );
      for (const item of data.ass_list ?? []) {
        const dueAt = parseDueDate(item.duedate);
        if (!dueAt) continue;
        found.push({
          key: `hands:${course.colid}:${item.ass_id ?? item.id ?? unit.unit_id}:${dueAt.toISOString()}`,
          title: stripHtml(item.assignment_text) || "Hands-on assignment",
          course: courseName,
          type: "Hands-on",
          dueAt,
          submitted: Boolean(item.filePath || item.isevaluated)
        });
      }
    }
    const courseId = content.course_id || course.crsid;
    if (!courseId) continue;
    const subjective = await postVolp(
      "https://learner.volp.in/SubjectiveAssignment/getSubjectiveAssignment_new",
      { course_offering_learner_id: course.colid, courseId, type: "content" },
      session, "/learner-subjective-assignment"
    );
    for (const item of subjective.question_list ?? []) {
      const dueAt = parseDueDate(item.due_date);
      if (!dueAt) continue;
      found.push({
        key: `subjective:${course.colid}:${item.question_id ?? item.id ?? stripHtml(item.question).slice(0, 40)}:${dueAt.toISOString()}`,
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

async function syncUser(env: Env, chatId: number) {
  const account = await env.DB.prepare("SELECT username,encrypted_password FROM volp_accounts WHERE chat_id=?").bind(chatId).first<any>();
  if (!account) throw new Error("VOLP account is not connected");
  try {
    const password = await decryptPassword(account.encrypted_password, env.CREDENTIAL_KEY);
    const session = await loginVolp(account.username, password);
    const assignments = await fetchAssignments(session);
    const now = new Date().toISOString();
    for (const item of assignments) {
      await env.DB.prepare(
        `INSERT INTO assignments(chat_id,assignment_key,title,course,assignment_type,due_at,submitted,updated_at)
         VALUES(?,?,?,?,?,?,?,?)
         ON CONFLICT(chat_id,assignment_key) DO UPDATE SET
         title=excluded.title,course=excluded.course,assignment_type=excluded.assignment_type,
         due_at=excluded.due_at,submitted=excluded.submitted,updated_at=excluded.updated_at`
      ).bind(chatId, item.key, item.title, item.course, item.type, item.dueAt.toISOString(), item.submitted ? 1 : 0, now).run();
    }
    await env.DB.prepare("UPDATE volp_accounts SET last_sync_at=?,last_error=NULL WHERE chat_id=?").bind(now, chatId).run();
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 200) : "Sync failed";
    await env.DB.prepare("UPDATE volp_accounts SET last_error=? WHERE chat_id=?").bind(message, chatId).run();
    throw error;
  }
}

async function sendDueReminders(env: Env, chatId: number) {
  const rows = await env.DB.prepare(
    "SELECT assignment_key,title,course,assignment_type,due_at FROM assignments WHERE chat_id=? AND submitted=0 AND due_at>?"
  ).bind(chatId, new Date().toISOString()).all<any>();
  for (const item of rows.results) {
    const remaining = Math.floor((new Date(item.due_at).getTime() - Date.now()) / 60_000);
    for (const threshold of REMINDER_MINUTES) {
      if (remaining > threshold) continue;
      const marked = await env.DB.prepare(
        "INSERT OR IGNORE INTO sent_notifications(chat_id,assignment_key,threshold_minutes,sent_at) VALUES(?,?,?,?)"
      ).bind(chatId, item.assignment_key, threshold, new Date().toISOString()).run();
      if (marked.meta.changes !== 1) continue;
      const label = threshold >= 1440 ? `${threshold / 1440} day${threshold > 1440 ? "s" : ""}` : `${threshold / 60} hours`;
      await send(env, chatId,
        `⏰ <b>Assignment due in ${label}</b>\n\n<b>${escapeHtml(item.title)}</b>\n${escapeHtml(item.course)} · ${escapeHtml(item.assignment_type)}\nDue: ${new Date(item.due_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`);
    }
  }
}

async function runScheduled(env: Env) {
  const accounts = await env.DB.prepare("SELECT chat_id FROM volp_accounts").all<{ chat_id: number }>();
  for (const account of accounts.results) {
    try {
      await syncUser(env, account.chat_id);
      await sendDueReminders(env, account.chat_id);
    } catch {
      // Error is stored per account; one unavailable account must not stop others.
    }
  }
  await env.DB.prepare("DELETE FROM setup_tokens WHERE expires_at < ?").bind(new Date().toISOString()).run();
}

async function connectGet(env: Env, token: string) {
  const row = await env.DB.prepare("SELECT token FROM setup_tokens WHERE token=? AND expires_at>?").bind(token, new Date().toISOString()).first();
  if (!row) return html(page("<h1>Link expired</h1><p>Return to Telegram and send <b>/connect</b> for a new link.</p>"), 410);
  return html(page(`<h1>Connect VOLP</h1>
    <p>Enter the same credentials you use at classroom.volp.in.</p>
    <form method="post" action="/connect">
      <input type="hidden" name="token" value="${escapeHtml(token)}">
      <label>VOLP username<input name="username" autocomplete="username" required maxlength="160"></label>
      <label>VOLP password<input type="password" name="password" autocomplete="current-password" required maxlength="300"></label>
      <button type="submit">Connect securely</button>
    </form>
    <p class="note">Credentials are validated directly with VOLP and encrypted with AES-GCM before storage. You can delete them anytime with /disconnect.</p>`));
}

async function connectPost(request: Request, env: Env) {
  const form = await request.formData();
  const token = String(form.get("token") ?? "");
  const username = String(form.get("username") ?? "").trim();
  const password = String(form.get("password") ?? "");
  const setup = await env.DB.prepare("SELECT chat_id FROM setup_tokens WHERE token=? AND expires_at>?").bind(token, new Date().toISOString()).first<{ chat_id: number }>();
  if (!setup || !username || !password) return html(page("<h1>Connection failed</h1><p class=error>The link expired or the form was incomplete. Send /connect in Telegram and try again.</p>"), 400);
  try {
    await loginVolp(username, password);
    const encrypted = await encryptPassword(password, env.CREDENTIAL_KEY);
    await env.DB.prepare(
      `INSERT INTO volp_accounts(chat_id,username,encrypted_password,connected_at)
       VALUES(?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET
       username=excluded.username,encrypted_password=excluded.encrypted_password,
       connected_at=excluded.connected_at,last_error=NULL`
    ).bind(setup.chat_id, username, encrypted, new Date().toISOString()).run();
    await env.DB.prepare("DELETE FROM setup_tokens WHERE token=?").bind(token).run();
    await send(env, setup.chat_id, "✅ VOLP connected. I’ll check every 15 minutes.\n\nUse /assignments or /sync anytime.");
    return html(page("<h1>Connected ✅</h1><p>You can close this page and return to Telegram.</p>"));
  } catch {
    return html(page(`<h1>Connection failed</h1><p class="error">VOLP rejected the login or is temporarily unavailable.</p>
      <p>Return to Telegram, send <b>/connect</b>, and try again.</p>`), 401);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return json({ ok: true });
    if (url.pathname === "/connect" && request.method === "GET") return connectGet(env, url.searchParams.get("token") ?? "");
    if (url.pathname === "/connect" && request.method === "POST") return connectPost(request, env);
    if (request.method !== "POST" || url.pathname !== `/webhook/${env.WEBHOOK_SECRET}`) return new Response("Not found", { status: 404 });
    if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) return new Response("Forbidden", { status: 403 });
    const update: any = await request.json();
    if (update.message?.text) await handleCommand(env, update.message.chat.id, update.message.text, url.origin);
    return new Response("ok");
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(env));
  }
};

