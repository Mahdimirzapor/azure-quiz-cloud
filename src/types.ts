export type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_NATIONAL_IDS: string;
  SECRET_KEY?: string;
};

export type Member = {
  national_id: string;
  first_name: string;
  last_name: string;
  phone: string;
};

export type Question = {
  id: number;
  lesson: string;
  question: string;
  option1: string;
  option2: string;
  option3: string;
  option4: string;
  correct: number;
};

export type SessionData = {
  national_id: string;
  first_name: string;
  last_name: string;
  phone: string;
  is_admin: boolean;
  quiz?: {
    token: string;
    lesson: string;
    answer_key: number[];
    options: string[][];
    answers: number[];
    started_at: string;
  } | null;
};
