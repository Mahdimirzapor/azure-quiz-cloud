import type { Env, Member, Question } from "./types";

export function tehranNow(): string {
  // UTC+3:30
  const d = new Date(Date.now() + 3.5 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

export function normNid(v: unknown): string {
  let s = String(v ?? "").trim();
  if (s.endsWith(".0") && /^\d+\.0$/.test(s)) s = s.slice(0, -2);
  return s;
}

export function normPhone(v: unknown): string {
  let s = String(v ?? "").trim().replace(/[\s-]/g, "");
  if (s.endsWith(".0") && /^\d+\.0$/.test(s)) s = s.slice(0, -2);
  return s;
}

export async function findMember(db: D1Database, nid: string): Promise<Member | null> {
  return db
    .prepare(
      "SELECT national_id, first_name, last_name, phone FROM members WHERE national_id = ?"
    )
    .bind(nid)
    .first<Member>();
}

export async function listMembers(db: D1Database): Promise<Member[]> {
  const r = await db
    .prepare(
      "SELECT national_id, first_name, last_name, phone FROM members ORDER BY last_name, first_name"
    )
    .all<Member>();
  return r.results || [];
}

export async function listLessons(db: D1Database): Promise<string[]> {
  const r = await db
    .prepare("SELECT DISTINCT lesson FROM questions ORDER BY lesson")
    .all<{ lesson: string }>();
  return (r.results || []).map((x) => x.lesson);
}

export async function lessonsWithCounts(db: D1Database) {
  const r = await db
    .prepare(
      "SELECT lesson, COUNT(*) as count FROM questions GROUP BY lesson ORDER BY lesson"
    )
    .all<{ lesson: string; count: number }>();
  return r.results || [];
}

export async function questionsForLesson(db: D1Database, lesson: string): Promise<Question[]> {
  const r = await db
    .prepare(
      "SELECT id, lesson, question, option1, option2, option3, option4, correct FROM questions WHERE lesson = ?"
    )
    .bind(lesson)
    .all<Question>();
  return r.results || [];
}

export async function questionCount(db: D1Database): Promise<number> {
  const r = await db.prepare("SELECT COUNT(*) as c FROM questions").first<{ c: number }>();
  return r?.c || 0;
}

export async function listResults(db: D1Database, limit = 100) {
  const r = await db
    .prepare(
      `SELECT national_id, first_name, last_name, phone, lesson,
              correct_count as correct, wrong_count as wrong, percent, started_at as datetime
       FROM results ORDER BY id DESC LIMIT ?`
    )
    .bind(limit)
    .all();
  return r.results || [];
}

export async function resultsForMember(db: D1Database, nid: string, limit = 30) {
  const r = await db
    .prepare(
      `SELECT lesson, correct_count as correct, wrong_count as wrong, percent, started_at as datetime
       FROM results WHERE national_id = ? ORDER BY id DESC LIMIT ?`
    )
    .bind(nid, limit)
    .all();
  return r.results || [];
}

export async function completionReport(db: D1Database) {
  const lessons = await listLessons(db);
  const members = await listMembers(db);
  const allRes = await listResults(db, 10000);
  const latest: Record<string, Record<string, any>> = {};
  for (const row of allRes) {
    const nid = String((row as any).national_id);
    const lesson = String((row as any).lesson);
    if (!latest[nid]) latest[nid] = {};
    if (!latest[nid][lesson]) latest[nid][lesson] = row;
  }
  const complete: any[] = [];
  const incomplete: any[] = [];
  for (const m of members) {
    const taken = new Set(Object.keys(latest[m.national_id] || {}));
    const missing = lessons.filter((L) => !taken.has(L));
    if (lessons.length && missing.length === 0) {
      complete.push({
        national_id: m.national_id,
        first_name: m.first_name,
        last_name: m.last_name,
        phone: m.phone,
        results: lessons.map((L) => {
          const r = latest[m.national_id][L];
          return {
            lesson: L,
            percent: r.percent,
            datetime: r.datetime,
            correct: r.correct,
            wrong: r.wrong,
          };
        }),
      });
    } else {
      incomplete.push({
        national_id: m.national_id,
        first_name: m.first_name,
        last_name: m.last_name,
        phone: m.phone,
        missing_lessons: missing,
      });
    }
  }
  return { lessons, complete, incomplete };
}
