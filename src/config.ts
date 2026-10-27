/**
 * Конфигурация приложения.
 *
 * Все настройки читаются из переменных окружения (Bun автоматически
 * подхватывает `.env`). Имена переменных совместимы с прежней Python-версией,
 * чтобы существующий `.env` продолжал работать.
 */
import { basename, dirname, join, resolve } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Config {
  // Telegram
  tgBotToken: string;
  tgAdminChatId: string;
  tgApiServer: string;
  tgProxy: string;

  // hh.ru
  hhLogin: string;
  hhPassword: string;
  hhResumeId: string;

  // Профиль
  desiredPosition: string;
  desiredSalaryMin: number;
  desiredSalaryMax: number;

  // Поиск
  searchQueriesRaw: string;
  searchQueries: string[];
  searchPages: number;
  searchPerPage: number;

  // Скоринг
  targetKeywords: string[];
  negativeKeywords: string[];
  stackKeywords: string[];
  salaryFloor: number;

  // Письмо
  coverLetter: string;

  // Темп / антибан
  checkIntervalSec: number;
  browserHeadless: boolean;
  browserChannel: string;
  proxyUrl: string;
  applyDelayMin: number;
  applyDelayMax: number;
  maxAppliesPerDay: number;
  applyMinScoreDay: number;
  applyMinScoreNight: number;
  dayStartHour: number;
  dayEndHour: number;

  // Капча
  captchaEnabled: boolean;
  captchaTimeoutSec: number;
  captchaMaxAttempts: number;
  captchaLang: string;
  captchaSubmitDelaySec: number;
  captchaCooldownSec: number;

  // База и файлы
  dataDir: string;
  databasePath: string;
  hhTokenPath: string;
  hhStatePath: string;
  schedulerStatePath: string;
  captchaCookiePath: string;

  // Уведомления
  notifyHourStart: number;
  notifyHourEnd: number;
  logLevel: LogLevel;
  dryRun: boolean;
}

function env(envMap: NodeJS.ProcessEnv, name: string, fallback = ""): string {
  const value = envMap[name];
  return value === undefined || value === null ? fallback : String(value).trim();
}

function intEnv(envMap: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env(envMap, name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolEnv(envMap: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env(envMap, name).toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "y", "on", "да"].includes(raw)) return true;
  if (["0", "false", "no", "n", "off", "нет"].includes(raw)) return false;
  return fallback;
}

/** Разбить строку "a, b, c" в список (пустые элементы отбрасываются). */
export function splitList(value: string | undefined | null): string[] {
  return (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Достать путь к SQLite из DATABASE_URL или DATABASE_PATH.
 * Поддерживает форматы `sqlite+aiosqlite:///data/jobhunter.db` (Python)
 * и обычный путь.
 */
export function resolveDatabasePath(envMap: NodeJS.ProcessEnv, fallbackDir = "data"): string {
  const explicit = env(envMap, "DATABASE_PATH");
  if (explicit) return resolve(explicit);

  const url = env(envMap, "DATABASE_URL");
  if (url) {
    const match = /^sqlite(?:\+[a-z0-9_]+)?:\/\/(.*)$/i.exec(url);
    if (match) {
      const rest = match[1] ?? "";
      // sqlite:///relative.db  -> "relative.db"
      // sqlite:////abs/path.db -> "/abs/path.db"
      if (rest.startsWith("//")) return resolve(rest.slice(1));
      return resolve(rest.replace(/^\//, ""));
    }
  }
  return resolve(join(fallbackDir, "jobhunter.db"));
}

export function loadConfig(envMap: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = resolve(env(envMap, "DATA_DIR", "data"));
  const searchQueriesRaw = env(
    envMap,
    "SEARCH_QUERIES_RAW",
    "performance маркетолог, интернет-маркетолог, директолог",
  );
  const desiredPosition = env(envMap, "DESIRED_POSITION", "Performance-маркетолог");

  const parsedSearchQueries = splitList(searchQueriesRaw);

  const config: Config = {
    tgBotToken: env(envMap, "TG_BOT_TOKEN"),
    tgAdminChatId: env(envMap, "TG_ADMIN_CHAT_ID"),
    tgApiServer: env(envMap, "TG_API_SERVER"),
    tgProxy: env(envMap, "TG_PROXY"),

    hhLogin: env(envMap, "HH_LOGIN"),
    hhPassword: env(envMap, "HH_PASSWORD"),
    hhResumeId: env(envMap, "HH_RESUME_ID"),

    desiredPosition,
    desiredSalaryMin: intEnv(envMap, "DESIRED_SALARY_MIN", 150_000),
    desiredSalaryMax: intEnv(envMap, "DESIRED_SALARY_MAX", 400_000),

    searchQueriesRaw,
    searchQueries: parsedSearchQueries.length > 0 ? parsedSearchQueries : [desiredPosition],
    searchPages: Math.min(10, Math.max(1, intEnv(envMap, "SEARCH_PAGES", 3))),
    searchPerPage: Math.min(100, Math.max(1, intEnv(envMap, "SEARCH_PER_PAGE", 50))),

    targetKeywords: splitList(
      env(
        envMap,
        "TARGET_KEYWORDS_RAW",
        "маркетолог, marketing, performance, трафик, seo, smm, директолог, таргетолог, ppc, digital",
      ),
    ),
    negativeKeywords: splitList(
      env(
        envMap,
        "NEGATIVE_KEYWORDS_RAW",
        "junior, стажёр, стажер, intern, ассистент, помощник, продавец, менеджер по продажам",
      ),
    ),
    stackKeywords: splitList(
      env(
        envMap,
        "STACK_KEYWORDS_RAW",
        "performance, cpa, roi, drr, seo, smm, таргет, контекст, директ, google ads, аналитика, воронк, unit",
      ),
    ),
    salaryFloor: intEnv(envMap, "SALARY_FLOOR", 100_000),

    coverLetter: env(
      envMap,
      "COVER_LETTER",
      "Добрый день! Заинтересовала ваша вакансия, у меня релевантный опыт, буду рад пообщаться.",
    ),

    checkIntervalSec: Math.max(30, intEnv(envMap, "CHECK_INTERVAL_SEC", 300)),
    browserHeadless: boolEnv(envMap, "BROWSER_HEADLESS", true),
    browserChannel: env(envMap, "BROWSER_CHANNEL"),
    proxyUrl: env(envMap, "PROXY_URL"),
    applyDelayMin: intEnv(envMap, "APPLY_DELAY_MIN", 40),
    applyDelayMax: intEnv(envMap, "APPLY_DELAY_MAX", 68),
    maxAppliesPerDay: Math.min(200, Math.max(1, intEnv(envMap, "MAX_APPLIES_PER_DAY_HH", 200))),
    applyMinScoreDay: intEnv(envMap, "APPLY_MIN_SCORE_DAY", 1),
    applyMinScoreNight: intEnv(envMap, "APPLY_MIN_SCORE_NIGHT", 50),
    dayStartHour: intEnv(envMap, "DAY_START_HOUR", 9),
    dayEndHour: intEnv(envMap, "DAY_END_HOUR", 22),

    captchaEnabled: boolEnv(envMap, "CAPTCHA_ENABLED", true),
    captchaTimeoutSec: Math.max(30, intEnv(envMap, "CAPTCHA_TIMEOUT_SEC", 300)),
    captchaMaxAttempts: Math.max(1, intEnv(envMap, "CAPTCHA_MAX_ATTEMPTS", 3)),
    captchaLang: env(envMap, "CAPTCHA_LANG", "RU").toUpperCase(),
    captchaSubmitDelaySec: Math.max(0, intEnv(envMap, "CAPTCHA_SUBMIT_DELAY_SEC", 10)),
    captchaCooldownSec: Math.max(0, intEnv(envMap, "CAPTCHA_COOLDOWN_SEC", 30)),

    dataDir,
    databasePath: resolveDatabasePath(envMap, dataDir),
    hhTokenPath: resolve(env(envMap, "HH_TOKEN_PATH", join(dataDir, "hh_oauth_token.json"))),
    hhStatePath: resolve(
      env(envMap, "HH_STATE_PATH", join(dataDir, "browser_sessions", "hh_state.json")),
    ),
    schedulerStatePath: resolve(
      env(envMap, "SCHEDULER_STATE_PATH", join(dataDir, "scheduler_state.json")),
    ),
    captchaCookiePath: resolve(
      env(envMap, "CAPTCHA_COOKIE_PATH", join(dataDir, "captcha_cookies.json")),
    ),

    notifyHourStart: intEnv(envMap, "NOTIFY_HOUR_START", 9),
    notifyHourEnd: intEnv(envMap, "NOTIFY_HOUR_END", 22),
    logLevel: (env(envMap, "LOG_LEVEL", "info").toLowerCase() as LogLevel) || "info",
    dryRun: boolEnv(envMap, "DRY_RUN", false),
  };

  return config;
}

export function validateForBot(config: Config): string[] {
  const errors: string[] = [];
  if (!config.tgBotToken) errors.push("TG_BOT_TOKEN не задан");
  if (!config.tgAdminChatId) errors.push("TG_ADMIN_CHAT_ID не задан");
  return errors;
}

/** Краткая информация о конфиге для стартового сообщения (без секретов). */
export function describeConfig(config: Config): string {
  return [
    `Позиция: ${config.desiredPosition}`,
    `Зарплата: ${config.desiredSalaryMin.toLocaleString("ru-RU")}–${config.desiredSalaryMax.toLocaleString("ru-RU")} ₽`,
    `Интервал поиска: ${Math.round(config.checkIntervalSec / 60)} мин`,
    `Лимит: ${config.maxAppliesPerDay} откликов/день`,
    `База: ${basename(dirname(config.databasePath))}/${basename(config.databasePath)}`,
    `Капча в Telegram: ${config.captchaEnabled ? "вкл" : "выкл"}`,
    `Режим: ${config.dryRun ? "DRY-RUN" : "рабочий"}`,
  ].join("\n");
}
