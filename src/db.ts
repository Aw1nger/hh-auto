/**
 * SQLite-слой на bun:sqlite.
 *
 * Схема совместима с прежней Python-версией (SQLAlchemy): те же имена таблиц
 * и колонок. При старте выполняется лёгкая миграция статусов/таймстампов,
 * чтобы можно было открыть старую базу.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Logger } from "./logger";
import type {
  Application,
  ApplicationStatus,
  NegotiationStatus,
  ParsedVacancy,
  RecruiterMessage,
  Stats,
  Vacancy,
  VacancyStatus,
} from "./models";
import { startOfMoscowDayUtcIso } from "./utils/time";

const log = new Logger("db");

function nowIso(): string {
  return new Date().toISOString();
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

interface VacancyRow {
  id: number;
  platform: string;
  external_id: string;
  url: string;
  title: string;
  description: string | null;
  salary_from: number | null;
  salary_to: number | null;
  salary_currency: string | null;
  location: string | null;
  is_remote: number | boolean | null;
  work_format: string | null;
  experience: string | null;
  employment_type: string | null;
  skills: string | null;
  company_id: number | null;
  company_name?: string | null;
  status: string;
  ai_score: number | null;
  ai_reason: string | null;
  created_at: string;
  updated_at: string;
}

function mapVacancy(row: VacancyRow): Vacancy {
  const format = row.work_format;
  return {
    id: Number(row.id),
    platform: String(row.platform),
    externalId: String(row.external_id),
    url: String(row.url),
    title: String(row.title),
    description: asString(row.description),
    salaryFrom: asNumber(row.salary_from),
    salaryTo: asNumber(row.salary_to),
    salaryCurrency: asString(row.salary_currency),
    location: asString(row.location),
    isRemote: Boolean(row.is_remote),
    workFormat:
      format === "remote" || format === "hybrid" || format === "office"
        ? format
        : null,
    experience: asString(row.experience),
    employmentType: asString(row.employment_type),
    skills: asString(row.skills),
    companyId: row.company_id === null ? null : Number(row.company_id),
    companyName: asString(row.company_name),
    status: String(row.status) as VacancyStatus,
    score: asNumber(row.ai_score),
    reason: asString(row.ai_reason),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

interface ApplicationRow {
  id: number;
  vacancy_id: number;
  platform: string;
  cover_letter: string | null;
  status: string;
  error_message: string | null;
  attempt_count: number;
  created_at: string;
  updated_at: string;
  vacancy_title?: string | null;
  vacancy_url?: string | null;
}

function mapApplication(row: ApplicationRow): Application {
  return {
    id: Number(row.id),
    vacancyId: Number(row.vacancy_id),
    platform: String(row.platform),
    coverLetter: asString(row.cover_letter),
    status: String(row.status) as ApplicationStatus,
    errorMessage: asString(row.error_message),
    attemptCount: Number(row.attempt_count ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    vacancyTitle: asString(row.vacancy_title),
    vacancyUrl: asString(row.vacancy_url),
  };
}

interface MessageRow {
  id: number;
  vacancy_id: number | null;
  platform: string;
  sender_name: string | null;
  sender_company: string | null;
  text: string;
  is_read: number | boolean;
  external_thread_id: string | null;
  created_at: string;
}

function mapMessage(row: MessageRow): RecruiterMessage {
  return {
    id: Number(row.id),
    vacancyId: row.vacancy_id === null ? null : Number(row.vacancy_id),
    platform: String(row.platform),
    senderName: asString(row.sender_name),
    senderCompany: asString(row.sender_company),
    text: String(row.text),
    isRead: Boolean(row.is_read),
    externalThreadId: asString(row.external_thread_id),
    createdAt: String(row.created_at),
  };
}

export interface StatsByPlatform {
  platform: string;
  vacancies: number;
  sentToday: number;
  sentTotal: number;
  messages: number;
}

export class Store {
  private readonly db: Database;

  constructor(public readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.createSchema();
    this.migrateLegacyData();
    log.info("database_ready", { path });
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS companies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        url TEXT,
        platform TEXT NOT NULL DEFAULT 'hh',
        platform_id TEXT,
        description TEXT,
        is_blacklisted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- ai_score/ai_reason — исторические имена из Python-версии.
      -- Сейчас это обычный rule-based score (см. src/scoring.ts).
      CREATE TABLE IF NOT EXISTS vacancies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,
        external_id TEXT NOT NULL,
        url TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        salary_from INTEGER,
        salary_to INTEGER,
        salary_currency TEXT,
        location TEXT,
        is_remote INTEGER NOT NULL DEFAULT 0,
        work_format TEXT,
        experience TEXT,
        employment_type TEXT,
        skills TEXT,
        company_id INTEGER REFERENCES companies(id),
        status TEXT NOT NULL DEFAULT 'new',
        ai_score REAL,
        ai_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (platform, external_id)
      );

      CREATE TABLE IF NOT EXISTS applications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        vacancy_id INTEGER NOT NULL REFERENCES vacancies(id),
        platform TEXT NOT NULL,
        cover_letter TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        error_message TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS recruiter_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        vacancy_id INTEGER REFERENCES vacancies(id),
        platform TEXT NOT NULL,
        sender_name TEXT,
        sender_company TEXT,
        text TEXT NOT NULL,
        is_read INTEGER NOT NULL DEFAULT 0,
        is_forwarded INTEGER NOT NULL DEFAULT 0,
        external_thread_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS blacklist (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_type TEXT NOT NULL,
        value TEXT NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_vacancies_platform_ext
        ON vacancies (platform, external_id);
      CREATE INDEX IF NOT EXISTS idx_vacancies_status ON vacancies (status);
      CREATE INDEX IF NOT EXISTS idx_applications_status ON applications (status);
      CREATE INDEX IF NOT EXISTS idx_applications_created ON applications (created_at);
      CREATE INDEX IF NOT EXISTS idx_applications_vacancy ON applications (vacancy_id);
      CREATE INDEX IF NOT EXISTS idx_messages_unread ON recruiter_messages (is_read);
      CREATE INDEX IF NOT EXISTS idx_messages_thread ON recruiter_messages (external_thread_id);
      CREATE INDEX IF NOT EXISTS idx_blacklist_value ON blacklist (value);
      CREATE INDEX IF NOT EXISTS idx_companies_name ON companies (name);
    `);
  }

  /** Превращает старую базу Python-версии в совместимый вид. */
  private migrateLegacyData(): void {
    try {
      const status = this.db
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name='vacancies'")
        .get();
      if (!status) return;

      // SQLAlchemy Enum хранил ИМЕНА enum-ов: NEW, APPROVED, SENT...
      this.db.exec("UPDATE vacancies SET status = lower(status) WHERE status <> lower(status)");
      this.db.exec("UPDATE applications SET status = lower(status) WHERE status <> lower(status)");

      // Python-таймстампы: "2026-10-27 17:05:46" (naive UTC). Приводим к ISO.
      for (const table of ["vacancies", "applications", "recruiter_messages", "blacklist"]) {
        try {
          this.db.exec(
            `UPDATE ${table}
             SET created_at = replace(created_at, ' ', 'T') || CASE
               WHEN created_at LIKE '%Z' OR created_at LIKE '%+%' THEN ''
               ELSE 'Z' END
             WHERE created_at IS NOT NULL AND created_at NOT LIKE '%T%'`,
          );
          this.db.exec(
            `UPDATE ${table}
             SET updated_at = replace(updated_at, ' ', 'T') || CASE
               WHEN updated_at LIKE '%Z' OR updated_at LIKE '%+%' THEN ''
               ELSE 'Z' END
             WHERE updated_at IS NOT NULL AND updated_at NOT LIKE '%T%'`,
          );
        } catch {
          // Таблицы может не быть в старой схеме — не критично.
        }
      }
      log.info("legacy_data_migrated");
    } catch (error) {
      log.warn("legacy_migration_skipped", {
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  // ── Blacklist ──────────────────────────────────────────────────────────

  getBlacklist(): { company: Set<string>; keyword: Set<string>; vacancy: Set<string> } {
    const rows = this.db
      .query("SELECT entry_type, value FROM blacklist")
      .all() as Array<{ entry_type: string; value: string }>;
    const result = {
      company: new Set<string>(),
      keyword: new Set<string>(),
      vacancy: new Set<string>(),
    };
    for (const row of rows) {
      const value = String(row.value).toLowerCase();
      if (row.entry_type === "company") result.company.add(value);
      else if (row.entry_type === "vacancy") result.vacancy.add(value);
      else result.keyword.add(value);
    }
    return result;
  }

  addBlacklist(entryType: string, value: string, reason = ""): void {
    const now = nowIso();
    this.db
      .query(
        "INSERT INTO blacklist (entry_type, value, reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(entryType, value, reason || null, now, now);
  }

  listBlacklist(limit = 20): Array<{ id: number; entryType: string; value: string }> {
    const rows = this.db
      .query("SELECT id, entry_type, value FROM blacklist ORDER BY id DESC LIMIT ?")
      .all(limit) as Array<{ id: number; entry_type: string; value: string }>;
    return rows.map((row) => ({
      id: Number(row.id),
      entryType: String(row.entry_type),
      value: String(row.value),
    }));
  }

  // ── Vacancies ──────────────────────────────────────────────────────────

  insertVacancies(parsed: ParsedVacancy[]): number {
    const blacklist = this.getBlacklist();
    const insert = this.db.query(
      `INSERT OR IGNORE INTO vacancies
       (platform, external_id, url, title, description, salary_from, salary_to,
        salary_currency, location, is_remote, work_format, experience,
        employment_type, skills, company_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)`,
    );
    const findCompany = this.db.query(
      "SELECT id, is_blacklisted FROM companies WHERE name = ? AND platform = ? LIMIT 1",
    );
    const insertCompany = this.db.query(
      "INSERT INTO companies (name, url, platform, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    );

    let saved = 0;
    const tx = this.db.transaction(() => {
      for (const vacancy of parsed) {
        const title = (vacancy.title ?? "").trim();
        const externalId = String(vacancy.externalId ?? "").trim();
        const url = (vacancy.url ?? "").trim();
        if (!title || !externalId || !url) continue;

        const titleLower = title.toLowerCase();
        const companyLower = (vacancy.companyName ?? "").toLowerCase();
        if (companyLower && blacklist.company.has(companyLower)) continue;
        if (blacklist.vacancy.has(externalId)) continue;
        if ([...blacklist.keyword].some((keyword) => titleLower.includes(keyword))) continue;

        let companyId: number | null = null;
        if (vacancy.companyName) {
          const existing = findCompany.get(vacancy.companyName, vacancy.platform) as
            | { id: number; is_blacklisted: number }
            | undefined;
          if (existing) {
            if (Boolean(existing.is_blacklisted)) continue;
            companyId = Number(existing.id);
          } else {
            const now = nowIso();
            const result = insertCompany.run(
              vacancy.companyName,
              vacancy.companyUrl ?? null,
              vacancy.platform,
              now,
              now,
            );
            companyId = Number(result.lastInsertRowid);
          }
        }

        const now = nowIso();
        const result = insert.run(
          vacancy.platform,
          externalId,
          url,
          title,
          vacancy.description ?? null,
          vacancy.salaryFrom ?? null,
          vacancy.salaryTo ?? null,
          vacancy.salaryCurrency ?? null,
          vacancy.location ?? null,
          vacancy.isRemote ? 1 : 0,
          null,
          vacancy.experience ?? null,
          vacancy.employmentType ?? null,
          vacancy.skills?.length ? JSON.stringify(vacancy.skills) : null,
          companyId,
          now,
          now,
        );
        if (Number(result.changes) > 0) saved += 1;
      }
    });
    tx();
    return saved;
  }

  getUnanalyzed(limit = 300): Vacancy[] {
    const rows = this.db
      .query(
        "SELECT * FROM vacancies WHERE status = 'new' ORDER BY created_at DESC LIMIT ?",
      )
      .all(limit) as VacancyRow[];
    return rows.map(mapVacancy);
  }

  saveAnalysis(
    id: number,
    score: number,
    reason: string,
    workFormat: "remote" | "hybrid" | "office",
  ): void {
    this.db
      .query(
        `UPDATE vacancies
         SET ai_score = ?, ai_reason = ?, work_format = ?, status = 'approved', updated_at = ?
         WHERE id = ?`,
      )
      .run(score, reason, workFormat, nowIso(), id);
  }

  getApplyCandidates(platform: string, limit: number, minScore: number): Vacancy[] {
    if (limit <= 0) return [];
    const rows = this.db
      .query(
        `SELECT v.*, c.name AS company_name
         FROM vacancies v
         LEFT JOIN companies c ON c.id = v.company_id
         WHERE v.platform = ?
           AND v.status = 'approved'
           AND COALESCE(v.ai_score, 0) >= ?
           AND v.id NOT IN (
             SELECT vacancy_id FROM applications
             WHERE status = 'failed'
             GROUP BY vacancy_id
             HAVING COUNT(*) >= 3
           )
         ORDER BY CASE v.work_format
                    WHEN 'remote' THEN 0
                    WHEN 'hybrid' THEN 1
                    ELSE 2
                  END,
                  v.ai_score DESC,
                  v.created_at DESC
         LIMIT ?`,
      )
      .all(platform, minScore, limit) as VacancyRow[];
    return rows.map(mapVacancy);
  }

  getVacancy(id: number): Vacancy | null {
    const row = this.db
      .query(
        `SELECT v.*, c.name AS company_name
         FROM vacancies v LEFT JOIN companies c ON c.id = v.company_id
         WHERE v.id = ?`,
      )
      .get(id) as VacancyRow | undefined;
    return row ? mapVacancy(row) : null;
  }

  getVacancyPage(
    offset: number,
    limit: number,
    topOnly = false,
  ): { items: Vacancy[]; total: number } {
    const where = topOnly
      ? "v.status IN ('new','analyzed','approved') AND v.ai_score >= 60"
      : "v.status IN ('new','analyzed','approved')";
    const totalRow = this.db
      .query(`SELECT COUNT(*) AS cnt FROM vacancies v WHERE ${where}`)
      .get() as { cnt: number };
    const rows = this.db
      .query(
        `SELECT v.*, c.name AS company_name
         FROM vacancies v LEFT JOIN companies c ON c.id = v.company_id
         WHERE ${where}
         ORDER BY v.ai_score DESC NULLS LAST, v.created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as VacancyRow[];
    return { items: rows.map(mapVacancy), total: Number(totalRow.cnt) };
  }

  setVacancyStatus(id: number, status: VacancyStatus): void {
    this.db
      .query("UPDATE vacancies SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, nowIso(), id);
  }

  markAppliedByExternalIds(platform: string, externalIds: Iterable<string>): number {
    const ids = [...new Set([...externalIds].filter(Boolean))];
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => "?").join(",");
    const result = this.db
      .query(
        `UPDATE vacancies
         SET status = 'applied', updated_at = ?
         WHERE platform = ? AND external_id IN (${placeholders}) AND status <> 'applied'`,
      )
      .run(nowIso(), platform, ...ids);
    return Number(result.changes);
  }

  // ── Applications ───────────────────────────────────────────────────────

  addApplication(input: {
    vacancyId: number;
    platform: string;
    coverLetter?: string | null;
    status: ApplicationStatus;
    errorMessage?: string | null;
  }): number {
    const now = nowIso();
    const result = this.db
      .query(
        `INSERT INTO applications
         (vacancy_id, platform, cover_letter, status, error_message, attempt_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        input.vacancyId,
        input.platform,
        input.coverLetter ?? null,
        input.status,
        input.errorMessage ?? null,
        now,
        now,
      );
    return Number(result.lastInsertRowid);
  }

  countSentToday(platform: string, sinceIso = startOfMoscowDayUtcIso()): number {
    const row = this.db
      .query(
        "SELECT COUNT(*) AS cnt FROM applications WHERE platform = ? AND status = 'sent' AND created_at >= ?",
      )
      .get(platform, sinceIso) as { cnt: number };
    return Number(row.cnt);
  }

  countSentTotalToday(sinceIso = startOfMoscowDayUtcIso()): number {
    const row = this.db
      .query("SELECT COUNT(*) AS cnt FROM applications WHERE status = 'sent' AND created_at >= ?")
      .get(sinceIso) as { cnt: number };
    return Number(row.cnt);
  }

  countFailedToday(sinceIso = startOfMoscowDayUtcIso()): number {
    const row = this.db
      .query("SELECT COUNT(*) AS cnt FROM applications WHERE status = 'failed' AND created_at >= ?")
      .get(sinceIso) as { cnt: number };
    return Number(row.cnt);
  }

  getRecentApplications(limit = 10): Application[] {
    const rows = this.db
      .query(
        `SELECT a.*, v.title AS vacancy_title, v.url AS vacancy_url
         FROM applications a
         LEFT JOIN vacancies v ON v.id = a.vacancy_id
         ORDER BY a.created_at DESC
         LIMIT ?`,
      )
      .all(limit) as ApplicationRow[];
    return rows.map(mapApplication);
  }

  hadRecentApplicationForTitle(title: string, sinceIso: string): boolean {
    if (!title) return false;
    const row = this.db
      .query(
        `SELECT a.id FROM applications a
         JOIN vacancies v ON v.id = a.vacancy_id
         WHERE a.status = 'sent' AND a.created_at >= ? AND v.title LIKE ?
         LIMIT 1`,
      )
      .get(sinceIso, `%${title}%`) as { id: number } | undefined;
    return Boolean(row);
  }

  // ── Messages ───────────────────────────────────────────────────────────

  addMessageIfNew(input: {
    platform: string;
    title?: string;
    company?: string;
    sender?: string;
    text?: string;
    threadId?: string;
  }): RecruiterMessage | null {
    const platform = input.platform || "hh";
    const text = input.text || input.title || "";
    if (!text) return null;

    if (input.threadId) {
      const existing = this.db
        .query("SELECT id FROM recruiter_messages WHERE external_thread_id = ? LIMIT 1")
        .get(input.threadId) as { id: number } | undefined;
      if (existing) return null;
    } else {
      const existing = this.db
        .query(
          `SELECT id FROM recruiter_messages
           WHERE platform = ? AND COALESCE(sender_company, '') = ? AND text = ? LIMIT 1`,
        )
        .get(platform, input.company ?? "", text) as { id: number } | undefined;
      if (existing) return null;
    }

    let vacancyId: number | null = null;
    if (input.title) {
      const vacancy = this.db
        .query("SELECT id FROM vacancies WHERE title LIKE ? LIMIT 1")
        .get(`%${input.title.slice(0, 50)}%`) as { id: number } | undefined;
      if (vacancy) vacancyId = Number(vacancy.id);
    }

    const now = nowIso();
    const result = this.db
      .query(
        `INSERT INTO recruiter_messages
         (vacancy_id, platform, sender_name, sender_company, text, external_thread_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        vacancyId,
        platform,
        input.sender ?? input.company ?? null,
        input.company ?? null,
        text,
        input.threadId ?? null,
        now,
        now,
      );
    const id = Number(result.lastInsertRowid);
    const row = this.db.query("SELECT * FROM recruiter_messages WHERE id = ?").get(id) as MessageRow;
    return mapMessage(row);
  }

  getMessage(id: number): RecruiterMessage | null {
    const row = this.db
      .query("SELECT * FROM recruiter_messages WHERE id = ?")
      .get(id) as MessageRow | undefined;
    return row ? mapMessage(row) : null;
  }

  markMessageRead(id: number): void {
    this.db
      .query("UPDATE recruiter_messages SET is_read = 1, updated_at = ? WHERE id = ?")
      .run(nowIso(), id);
  }

  // ── Stats / summaries ──────────────────────────────────────────────────

  getStats(): Stats {
    const totalVacancies = Number(
      (this.db.query("SELECT COUNT(*) AS cnt FROM vacancies").get() as { cnt: number }).cnt,
    );
    const newVacancies = Number(
      (
        this.db.query("SELECT COUNT(*) AS cnt FROM vacancies WHERE status = 'new'").get() as {
          cnt: number;
        }
      ).cnt,
    );
    const analyzedVacancies = Number(
      (
        this.db.query("SELECT COUNT(*) AS cnt FROM vacancies WHERE status = 'analyzed'").get() as {
          cnt: number;
        }
      ).cnt,
    );
    const approvedVacancies = Number(
      (
        this.db.query("SELECT COUNT(*) AS cnt FROM vacancies WHERE status = 'approved'").get() as {
          cnt: number;
        }
      ).cnt,
    );
    const avgRow = this.db
      .query("SELECT AVG(ai_score) AS avg FROM vacancies WHERE ai_score IS NOT NULL")
      .get() as { avg: number | null };
    const sentToday = this.countSentTotalToday();
    const failedToday = this.countFailedToday();
    const sentTotal = Number(
      (
        this.db.query("SELECT COUNT(*) AS cnt FROM applications WHERE status = 'sent'").get() as {
          cnt: number;
        }
      ).cnt,
    );
    const messages = Number(
      (this.db.query("SELECT COUNT(*) AS cnt FROM recruiter_messages").get() as { cnt: number })
        .cnt,
    );

    const vacancyRows = this.db
      .query("SELECT platform, COUNT(*) AS cnt FROM vacancies GROUP BY platform")
      .all() as Array<{ platform: string; cnt: number }>;
    const todayRows = this.db
      .query(
        "SELECT platform, COUNT(*) AS cnt FROM applications WHERE status = 'sent' AND created_at >= ? GROUP BY platform",
      )
      .all(startOfMoscowDayUtcIso()) as Array<{ platform: string; cnt: number }>;
    const totalRows = this.db
      .query(
        "SELECT platform, COUNT(*) AS cnt FROM applications WHERE status = 'sent' GROUP BY platform",
      )
      .all() as Array<{ platform: string; cnt: number }>;
    const messageRows = this.db
      .query("SELECT platform, COUNT(*) AS cnt FROM recruiter_messages GROUP BY platform")
      .all() as Array<{ platform: string; cnt: number }>;

    const platforms = new Set<string>([
      ...vacancyRows.map((row) => row.platform),
      ...todayRows.map((row) => row.platform),
      ...totalRows.map((row) => row.platform),
    ]);
    const byPlatform: StatsByPlatform[] = [...platforms].map((platform) => ({
      platform,
      vacancies: Number(vacancyRows.find((row) => row.platform === platform)?.cnt ?? 0),
      sentToday: Number(todayRows.find((row) => row.platform === platform)?.cnt ?? 0),
      sentTotal: Number(totalRows.find((row) => row.platform === platform)?.cnt ?? 0),
      messages: Number(messageRows.find((row) => row.platform === platform)?.cnt ?? 0),
    }));

    return {
      totalVacancies,
      newVacancies,
      analyzedVacancies,
      approvedVacancies,
      avgScore: avgRow.avg === null ? null : Number(avgRow.avg),
      sentToday,
      failedToday,
      sentTotal,
      messages,
      byPlatform,
    };
  }

  getWindowSummary(sinceIso: string): {
    sent: Array<{ platform: string; count: number }>;
    failed: Array<{ platform: string; count: number }>;
  } {
    const rows = this.db
      .query(
        `SELECT platform, status, COUNT(*) AS cnt
         FROM applications
         WHERE created_at >= ?
         GROUP BY platform, status`,
      )
      .all(sinceIso) as Array<{ platform: string; status: string; cnt: number }>;
    return {
      sent: rows
        .filter((row) => row.status === "sent")
        .map((row) => ({ platform: row.platform, count: Number(row.cnt) })),
      failed: rows
        .filter((row) => row.status === "failed")
        .map((row) => ({ platform: row.platform, count: Number(row.cnt) })),
    };
  }

  getTopApplied(
    sinceIso: string,
    limit = 5,
  ): Array<{ title: string; score: number | null; platform: string }> {
    const rows = this.db
      .query(
        `SELECT v.title, v.ai_score, a.platform
         FROM applications a
         JOIN vacancies v ON v.id = a.vacancy_id
         WHERE a.created_at >= ? AND a.status = 'sent'
         ORDER BY v.ai_score DESC NULLS LAST
         LIMIT ?`,
      )
      .all(sinceIso, limit) as Array<{ title: string; ai_score: number | null; platform: string }>;
    return rows.map((row) => ({
      title: String(row.title),
      score: asNumber(row.ai_score),
      platform: String(row.platform),
    }));
  }

  getErrorGroups(
    sinceIso: string,
    limit = 3,
  ): Array<{ message: string; count: number }> {
    const rows = this.db
      .query(
        `SELECT error_message, COUNT(*) AS cnt
         FROM applications
         WHERE created_at >= ? AND status = 'failed' AND error_message IS NOT NULL
         GROUP BY error_message
         ORDER BY cnt DESC
         LIMIT ?`,
      )
      .all(sinceIso, limit) as Array<{ error_message: string; cnt: number }>;
    return rows.map((row) => ({
      message: String(row.error_message),
      count: Number(row.cnt),
    }));
  }

  getNegotiationVacancyIds(platform = "hh", limit = 2000): string[] {
    const rows = this.db
      .query(
        "SELECT external_id FROM vacancies WHERE platform = ? ORDER BY created_at DESC LIMIT ?",
      )
      .all(platform, limit) as Array<{ external_id: string }>;
    return rows.map((row) => String(row.external_id));
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // ignore
    }
  }
}

export type { NegotiationStatus };
