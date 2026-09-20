CREATE TABLE IF NOT EXISTS members (
  national_id TEXT PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lesson TEXT NOT NULL,
  question TEXT NOT NULL,
  option1 TEXT NOT NULL,
  option2 TEXT NOT NULL,
  option3 TEXT NOT NULL,
  option4 TEXT NOT NULL,
  correct INTEGER NOT NULL CHECK (correct >= 1 AND correct <= 4)
);

CREATE INDEX IF NOT EXISTS idx_questions_lesson ON questions(lesson);

CREATE TABLE IF NOT EXISTS results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  national_id TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  lesson TEXT NOT NULL,
  correct_count INTEGER NOT NULL,
  wrong_count INTEGER NOT NULL,
  percent REAL NOT NULL,
  started_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_results_nid ON results(national_id);
CREATE INDEX IF NOT EXISTS idx_results_lesson ON results(lesson);
