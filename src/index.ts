import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Env, SessionData } from "./types";
import {
  signSession,
  verifySession,
  adminSet,
} from "./auth";
import {
  findMember,
  listMembers,
  listLessons,
  lessonsWithCounts,
  questionsForLesson,
  questionCount,
  listResults,
  resultsForMember,
  completionReport,
  tehranNow,
  normNid,
  normPhone,
} from "./db";
import { sheetToRows, rowsToXlsx, xlsxResponse } from "./excel";

const QUESTIONS_PER_QUIZ = 10;
const MIN_Q = 10;

type Variables = { session: SessionData | null; secret: string };

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

function secretOf(env: Env): string {
  return env.SECRET_KEY || "azure-quiz-cf-dev-secret-change-me";
}

app.use("/api/*", async (c, next) => {
  const secret = secretOf(c.env);
  c.set("secret", secret);
  const token = getCookie(c, "aq_session");
  if (token) {
    c.set("session", await verifySession(token, secret));
  } else {
    c.set("session", null);
  }
  await next();
});

async function saveSession(c: any, data: SessionData) {
  const token = await signSession(data, c.get("secret"));
  setCookie(c, "aq_session", token, {
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: 60 * 60 * 24 * 7,
  });
}

function requireUser(c: any): SessionData | Response {
  const s = c.get("session");
  if (!s) return c.json({ ok: false, error: "ابتدا وارد شوید." }, 401);
  return s;
}

function requireAdmin(c: any): SessionData | Response {
  const s = requireUser(c);
  if (s instanceof Response) return s;
  if (!s.is_admin) return c.json({ ok: false, error: "دسترسی ادمین ندارید." }, 403);
  return s;
}

// ---------- auth ----------
app.post("/api/login", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const nid = normNid(body.national_id);
  if (!/^\d{8,10}$/.test(nid)) return c.json({ ok: false, error: "کد ملی معتبر نیست." });
  const member = await findMember(c.env.DB, nid);
  if (!member) return c.json({ ok: false, error: "این کد ملی در لیست اعضا نیست." });
  const is_admin = adminSet(c.env.ADMIN_NATIONAL_IDS || "").has(member.national_id);
  const session: SessionData = {
    national_id: member.national_id,
    first_name: member.first_name,
    last_name: member.last_name,
    phone: member.phone || "",
    is_admin,
    quiz: null,
  };
  await saveSession(c, session);
  return c.json({ ok: true, member: { ...member, is_admin } });
});

app.post("/api/logout", async (c) => {
  deleteCookie(c, "aq_session", { path: "/" });
  return c.json({ ok: true });
});

app.get("/api/me", async (c) => {
  const s = c.get("session");
  if (!s) return c.json({ ok: false, logged_in: false });
  return c.json({
    ok: true,
    logged_in: true,
    member: {
      national_id: s.national_id,
      first_name: s.first_name,
      last_name: s.last_name,
      phone: s.phone,
      is_admin: s.is_admin,
    },
  });
});

app.get("/api/lessons", async (c) => {
  const u = requireUser(c);
  if (u instanceof Response) return u;
  return c.json({ ok: true, lessons: await listLessons(c.env.DB) });
});

app.get("/api/my/history", async (c) => {
  const u = requireUser(c);
  if (u instanceof Response) return u;
  return c.json({ ok: true, history: await resultsForMember(c.env.DB, u.national_id) });
});

// ---------- quiz ----------
app.post("/api/quiz/start", async (c) => {
  const u = requireUser(c);
  if (u instanceof Response) return u;
  const body = await c.req.json().catch(() => ({}));
  const lesson = String(body.lesson || "").trim();
  if (!lesson) return c.json({ ok: false, error: "درس را انتخاب کنید." });
  const all = await questionsForLesson(c.env.DB, lesson);
  if (all.length < MIN_Q) {
    return c.json({
      ok: false,
      error: `برای این درس حداقل ${MIN_Q} سؤال لازم است (الان ${all.length}).`,
    });
  }
  // shuffle pick
  const shuffled = [...all].sort(() => Math.random() - 0.5).slice(0, QUESTIONS_PER_QUIZ);
  const publicQs: { qid: number; question: string; options: string[] }[] = [];
  const answer_key: number[] = [];
  const optionsList: string[][] = [];
  for (let i = 0; i < shuffled.length; i++) {
    const q = shuffled[i];
    const opts = [
      { i: 1, t: q.option1 },
      { i: 2, t: q.option2 },
      { i: 3, t: q.option3 },
      { i: 4, t: q.option4 },
    ].sort(() => Math.random() - 0.5);
    const options = opts.map((o) => o.t);
    const correct = opts.findIndex((o) => o.i === q.correct) + 1;
    answer_key.push(correct);
    optionsList.push(options);
    publicQs.push({ qid: i, question: q.question, options });
  }
  const token = crypto.randomUUID().replace(/-/g, "");
  const started_at = tehranNow();
  u.quiz = {
    token,
    lesson,
    answer_key,
    options: optionsList,
    answers: Array(QUESTIONS_PER_QUIZ).fill(0),
    started_at,
  };
  await saveSession(c, u);
  return c.json({ ok: true, token, lesson, total: publicQs.length, questions: publicQs, started_at });
});

app.post("/api/quiz/answer", async (c) => {
  const u = requireUser(c);
  if (u instanceof Response) return u;
  const body = await c.req.json().catch(() => ({}));
  const quiz = u.quiz;
  if (!quiz || quiz.token !== body.token) {
    return c.json({ ok: false, error: "آزمون معتبر نیست. دوباره شروع کنید." });
  }
  const index = Number(body.index);
  const choice = Number(body.choice);
  if (!(index >= 0 && index < quiz.answer_key.length)) {
    return c.json({ ok: false, error: "شماره سؤال نامعتبر." });
  }
  if (![1, 2, 3, 4].includes(choice)) return c.json({ ok: false, error: "گزینه نامعتبر." });
  quiz.answers[index] = choice;
  const key = quiz.answer_key[index];
  const is_correct = choice === key;
  const correct_text = quiz.options[index]?.[key - 1] || "";
  u.quiz = quiz;
  await saveSession(c, u);
  return c.json({
    ok: true,
    correct: is_correct,
    correct_choice: key,
    correct_text,
    message: is_correct ? "✅ درست!" : `❌ نادرست — پاسخ صحیح: ${correct_text}`,
  });
});

app.post("/api/quiz/finish", async (c) => {
  const u = requireUser(c);
  if (u instanceof Response) return u;
  const body = await c.req.json().catch(() => ({}));
  const quiz = u.quiz;
  if (!quiz || quiz.token !== body.token) {
    return c.json({ ok: false, error: "آزمون معتبر نیست." });
  }
  let correct = 0;
  for (let i = 0; i < quiz.answer_key.length; i++) {
    if (quiz.answers[i] === quiz.answer_key[i]) correct++;
  }
  const total = quiz.answer_key.length || 1;
  const wrong = total - correct;
  const percent = Math.round((1000 * correct) / total) / 10;
  await c.env.DB.prepare(
    `INSERT INTO results (national_id, first_name, last_name, phone, lesson, correct_count, wrong_count, percent, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      u.national_id,
      u.first_name,
      u.last_name,
      u.phone || "",
      quiz.lesson,
      correct,
      wrong,
      percent,
      quiz.started_at
    )
    .run();
  u.quiz = null;
  await saveSession(c, u);
  return c.json({ ok: true, lesson: quiz.lesson, correct, wrong, percent, total, started_at: quiz.started_at });
});

// ---------- admin members ----------
app.get("/api/admin/stats", async (c) => {
  const a = requireAdmin(c);
  if (a instanceof Response) return a;
  const members_list = await listMembers(c.env.DB);
  const lessons_detail = await lessonsWithCounts(c.env.DB);
  const recent_results = await listResults(c.env.DB, 50);
  return c.json({
    ok: true,
    members: members_list.length,
    members_list,
    questions: await questionCount(c.env.DB),
    lessons: lessons_detail.map((x) => x.lesson),
    lessons_detail,
    recent_results,
  });
});

app.post("/api/admin/members", async (c) => {
  const a = requireAdmin(c);
  if (a instanceof Response) return a;
  const body = await c.req.json().catch(() => ({}));
  const nid = normNid(body.national_id);
  const first = String(body.first_name || "").trim();
  const last = String(body.last_name || "").trim();
  const phone = normPhone(body.phone);
  if (!/^\d{8,10}$/.test(nid)) return c.json({ ok: false, error: "کد ملی معتبر نیست." }, 400);
  if (!first || !last) return c.json({ ok: false, error: "نام و نام خانوادگی الزامی است." }, 400);
  if (await findMember(c.env.DB, nid)) {
    return c.json({ ok: false, error: "این کد ملی قبلاً ثبت شده است." }, 400);
  }
  await c.env.DB.prepare(
    "INSERT INTO members (national_id, first_name, last_name, phone) VALUES (?, ?, ?, ?)"
  )
    .bind(nid, first, last, phone)
    .run();
  return c.json({ ok: true, member: { national_id: nid, first_name: first, last_name: last, phone } });
});

app.put("/api/admin/members", async (c) => {
  const a = requireAdmin(c);
  if (a instanceof Response) return a;
  const body = await c.req.json().catch(() => ({}));
  const nid = normNid(body.national_id);
  const newNid = normNid(body.new_national_id || nid);
  const first = String(body.first_name || "").trim();
  const last = String(body.last_name || "").trim();
  const phone = normPhone(body.phone);
  if (!/^\d{8,10}$/.test(newNid)) return c.json({ ok: false, error: "کد ملی معتبر نیست." }, 400);
  if (!first || !last) return c.json({ ok: false, error: "نام و نام خانوادگی الزامی است." }, 400);
  if (newNid !== nid && (await findMember(c.env.DB, newNid))) {
    return c.json({ ok: false, error: "کد ملی جدید قبلاً ثبت شده است." }, 400);
  }
  const r = await c.env.DB.prepare(
    "UPDATE members SET national_id = ?, first_name = ?, last_name = ?, phone = ? WHERE national_id = ?"
  )
    .bind(newNid, first, last, phone, nid)
    .run();
  if (!r.meta.changes) return c.json({ ok: false, error: "عضو یافت نشد." }, 400);
  return c.json({ ok: true, member: { national_id: newNid, first_name: first, last_name: last, phone } });
});

app.delete("/api/admin/members", async (c) => {
  const a = requireAdmin(c);
  if (a instanceof Response) return a;
  const body = await c.req.json().catch(() => ({}));
  const nid = normNid(body.national_id);
  const r = await c.env.DB.prepare("DELETE FROM members WHERE national_id = ?").bind(nid).run();
  if (!r.meta.changes) return c.json({ ok: false, error: "عضو یافت نشد." }, 400);
  return c.json({ ok: true });
});

app.post("/api/admin/members/import", async (c) => {
  const a = requireAdmin(c);
  if (a instanceof Response) return a;
  const form = await c.req.parseBody();
  const file = form["file"];
  if (!file || typeof file === "string") {
    return c.json({ ok: false, error: "فایلی انتخاب نشده است." }, 400);
  }
  const name = (file as File).name || "";
  if (!name.toLowerCase().endsWith(".xlsx")) {
    return c.json({ ok: false, error: "فقط فایل .xlsx مجاز است." }, 400);
  }
  const buf = await (file as File).arrayBuffer();
  if (buf.byteLength > 5 * 1024 * 1024) {
    return c.json({ ok: false, error: "حجم فایل بیش از حد مجاز است." }, 400);
  }
  let rows: any[][];
  try {
    rows = sheetToRows(buf);
  } catch {
    return c.json({ ok: false, error: "فایل Excel قابل خواندن نیست." }, 400);
  }
  if (!rows.length) return c.json({ ok: false, error: "فایل خالی است." }, 400);
  const header = rows[0].map((x) => String(x).trim());
  const idx = (names: string[]) => {
    for (const n of names) {
      const i = header.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };
  const iN = idx(["کد ملی", "national_id"]);
  const iF = idx(["نام", "first_name"]);
  const iL = idx(["نام خانوادگی", "last_name"]);
  const iP = idx(["شماره همراه", "موبایل", "phone"]);
  if (iN < 0 || iF < 0 || iL < 0) {
    return c.json({
      ok: false,
      error: "هدر باید شامل کد ملی، نام، نام خانوادگی، شماره همراه باشد.",
    }, 400);
  }
  const existing = new Set((await listMembers(c.env.DB)).map((m) => m.national_id));
  const seen = new Set<string>();
  let added = 0,
    duplicates = 0,
    invalid = 0;
  const invalid_details: string[] = [];
  const stmts: D1PreparedStatement[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row.length) continue;
    const nid = normNid(row[iN]);
    const first = String(row[iF] ?? "").trim();
    const last = String(row[iL] ?? "").trim();
    const phone = iP >= 0 ? normPhone(row[iP]) : "";
    if (!/^\d{8,10}$/.test(nid)) {
      invalid++;
      invalid_details.push(`ردیف ${i + 1}: کد ملی نامعتبر`);
      continue;
    }
    if (!first || !last) {
      invalid++;
      invalid_details.push(`ردیف ${i + 1}: نام ناقص`);
      continue;
    }
    if (existing.has(nid) || seen.has(nid)) {
      duplicates++;
      continue;
    }
    seen.add(nid);
    stmts.push(
      c.env.DB.prepare(
        "INSERT OR IGNORE INTO members (national_id, first_name, last_name, phone) VALUES (?, ?, ?, ?)"
      ).bind(nid, first, last, phone)
    );
    added++;
  }
  if (stmts.length) {
    await c.env.DB.batch(stmts);
  }
  return c.json({
    ok: true,
    total: Math.max(0, rows.length - 1),
    added,
    duplicates,
    invalid,
    invalid_details: invalid_details.slice(0, 20),
  });
});

app.get("/api/admin/members/export", async (c) => {
  const a = requireAdmin(c);
  if (a instanceof Response) return a;
  const members = await listMembers(c.env.DB);
  const rows = members.map((m) => [m.first_name, m.last_name, m.national_id, m.phone]);
  const buf = rowsToXlsx(["نام", "نام خانوادگی", "کد ملی", "شماره همراه"], rows, "members");
  return xlsxResponse(buf, "members_export.xlsx");
});

// ---------- lessons / questions ----------
app.get("/api/admin/lessons", async (c) => {
  const a = requireAdmin(c);
  if (a instanceof Response) return a;
  return c.json({ ok: true, lessons: await lessonsWithCounts(c.env.DB) });
});

app.post("/api/admin/questions/import", async (c) => {
  const a = requireAdmin(c);
  if (a instanceof Response) return a;
  const form = await c.req.parseBody();
  const file = form["file"];
  if (!file || typeof file === "string") {
    return c.json({ ok: false, error: "فایلی انتخاب نشده است." }, 400);
  }
  if (!(file as File).name?.toLowerCase().endsWith(".xlsx")) {
    return c.json({ ok: false, error: "فقط فایل .xlsx مجاز است." }, 400);
  }
  const buf = await (file as File).arrayBuffer();
  if (buf.byteLength > 5 * 1024 * 1024) {
    return c.json({ ok: false, error: "حجم فایل بیش از حد مجاز است." }, 400);
  }
  let rows: any[][];
  try {
    rows = sheetToRows(buf);
  } catch {
    return c.json({ ok: false, error: "فایل Excel قابل خواندن نیست." }, 400);
  }
  if (!rows.length) return c.json({ ok: false, error: "فایل خالی است." }, 400);
  const header = rows[0].map((x) => String(x).trim());
  const need = ["درس", "سؤال", "گزینه ۱", "گزینه ۲", "گزینه ۳", "گزینه ۴", "پاسخ صحیح"];
  for (const h of need) {
    if (!header.includes(h)) {
      return c.json({ ok: false, error: `هدر ناقص است؛ ستون «${h}» یافت نشد.` }, 400);
    }
  }
  const ix = Object.fromEntries(need.map((h) => [h, header.indexOf(h)]));
  const lessons = new Set<string>();
  const parsed: {
    lesson: string;
    question: string;
    o1: string;
    o2: string;
    o3: string;
    o4: string;
    correct: number;
  }[] = [];
  let invalid = 0;
  const invalid_details: string[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const lesson = String(row[ix["درس"]] ?? "").trim();
    const question = String(row[ix["سؤال"]] ?? "").trim();
    const o1 = String(row[ix["گزینه ۱"]] ?? "").trim();
    const o2 = String(row[ix["گزینه ۲"]] ?? "").trim();
    const o3 = String(row[ix["گزینه ۳"]] ?? "").trim();
    const o4 = String(row[ix["گزینه ۴"]] ?? "").trim();
    const correct = Number(String(row[ix["پاسخ صحیح"]] ?? "").trim());
    if (!lesson && !question) continue;
    if (!lesson || !question || !o1 || !o2 || !o3 || !o4 || ![1, 2, 3, 4].includes(correct)) {
      invalid++;
      invalid_details.push(`ردیف ${i + 1}: داده نامعتبر`);
      continue;
    }
    lessons.add(lesson);
    parsed.push({ lesson, question, o1, o2, o3, o4, correct });
  }
  if (lessons.size === 0) return c.json({ ok: false, error: "هیچ سؤال معتبری نیست." }, 400);
  if (lessons.size > 1) {
    return c.json({
      ok: false,
      error: `فایل شامل چند درس است (${[...lessons].join("، ")}). هر فایل فقط یک درس.`,
    }, 400);
  }
  const lesson = [...lessons][0];
  const existing = await questionsForLesson(c.env.DB, lesson);
  const existText = new Set(existing.map((q) => q.question));
  let added = 0,
    duplicates = 0;
  const stmts: D1PreparedStatement[] = [];
  for (const p of parsed) {
    if (existText.has(p.question)) {
      duplicates++;
      continue;
    }
    existText.add(p.question);
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO questions (lesson, question, option1, option2, option3, option4, correct)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(p.lesson, p.question, p.o1, p.o2, p.o3, p.o4, p.correct)
    );
    added++;
  }
  if (stmts.length) await c.env.DB.batch(stmts);
  return c.json({
    ok: true,
    lesson,
    total: parsed.length + invalid,
    added,
    duplicates,
    invalid,
    invalid_details: invalid_details.slice(0, 20),
  });
});

app.get("/api/admin/lessons/:lesson/export", async (c) => {
  const a = requireAdmin(c);
  if (a instanceof Response) return a;
  const lesson = decodeURIComponent(c.req.param("lesson"));
  const qs = await questionsForLesson(c.env.DB, lesson);
  if (!qs.length) return c.json({ ok: false, error: "درس یافت نشد." }, 404);
  const rows = qs.map((q) => [
    q.lesson,
    q.question,
    q.option1,
    q.option2,
    q.option3,
    q.option4,
    String(q.correct),
  ]);
  const buf = rowsToXlsx(
    ["درس", "سؤال", "گزینه ۱", "گزینه ۲", "گزینه ۳", "گزینه ۴", "پاسخ صحیح"],
    rows,
    "questions"
  );
  const safe = lesson.replace(/[^\w\u0600-\u06FF-]+/g, "_") || "lesson";
  return xlsxResponse(buf, `${safe}_questions.xlsx`);
});

app.delete("/api/admin/lessons", async (c) => {
  const a = requireAdmin(c);
  if (a instanceof Response) return a;
  const body = await c.req.json().catch(() => ({}));
  const lesson = String(body.lesson || "").trim();
  if (!lesson) return c.json({ ok: false, error: "درس مشخص نیست." }, 400);
  const r = await c.env.DB.prepare("DELETE FROM questions WHERE lesson = ?").bind(lesson).run();
  if (!r.meta.changes) return c.json({ ok: false, error: "درس یافت نشد." }, 400);
  return c.json({ ok: true });
});

// ---------- results report ----------
app.get("/api/admin/results/report", async (c) => {
  const a = requireAdmin(c);
  if (a instanceof Response) return a;
  const report = await completionReport(c.env.DB);
  return c.json({
    ok: true,
    filter: c.req.query("filter") || "all",
    lessons: report.lessons,
    complete: report.complete,
    incomplete: report.incomplete,
    recent_results: await listResults(c.env.DB, 100),
  });
});

app.get("/api/admin/results/export-complete", async (c) => {
  const a = requireAdmin(c);
  if (a instanceof Response) return a;
  const report = await completionReport(c.env.DB);
  const rows: (string | number)[][] = [];
  for (const m of report.complete) {
    for (const r of m.results) {
      rows.push([
        m.first_name,
        m.last_name,
        m.national_id,
        m.phone,
        r.lesson,
        r.percent,
        r.datetime,
      ]);
    }
  }
  const buf = rowsToXlsx(
    ["نام", "نام خانوادگی", "کد ملی", "شماره همراه", "درس", "درصد", "زمان"],
    rows,
    "complete"
  );
  return xlsxResponse(buf, "complete_users.xlsx");
});

app.get("/api/admin/results/export-incomplete", async (c) => {
  const a = requireAdmin(c);
  if (a instanceof Response) return a;
  const report = await completionReport(c.env.DB);
  const rows = report.incomplete.map((m) => [
    m.first_name,
    m.last_name,
    m.national_id,
    m.phone,
    (m.missing_lessons || []).join("، "),
  ]);
  const buf = rowsToXlsx(
    ["نام", "نام خانوادگی", "کد ملی", "شماره همراه", "دروس امتحان‌نداده"],
    rows,
    "incomplete"
  );
  return xlsxResponse(buf, "incomplete_users.xlsx");
});

// static SPA fallback
app.all("*", async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
