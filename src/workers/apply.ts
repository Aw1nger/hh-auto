/** Воркер автооткликов: OAuth API + fallback Playwright для анкет. */
import type { AppContext } from "../context";
import { log } from "../logger";
import type { ApplyOutcome, ApplyResult, Vacancy } from "../models";
import { randomDelay, withTimeout } from "../utils/async";
import { escapeHtml, renderLetter, truncate } from "../utils/text";
import { isDaytime } from "../utils/time";
import { syncAppliedFromHH } from "./vacancy";

const PLATFORM = "hh";

const GLOBAL_ERRORS = new Set([
  "daily_limit",
  "auth_required",
  "auth_expired",
  "no_oauth_token",
  "no_resume_id",
  "captcha_failed",
]);

interface StepOutcome {
  result: ApplyResult;
  error?: string;
  skipRecord: boolean;
  globalError: boolean;
  viaPlaywright: boolean;
}

function mapPlaywrightResult(result: ApplyResult): StepOutcome {
  if (result === true) {
    return { result, skipRecord: false, globalError: false, viaPlaywright: true };
  }
  if (result === "already") {
    return { result, skipRecord: false, globalError: false, viaPlaywright: true };
  }
  return {
    result: false,
    error: "playwright_failed",
    skipRecord: false,
    globalError: false,
    viaPlaywright: true,
  };
}

async function applyOne(
  ctx: AppContext,
  vacancy: Vacancy,
  letter: string,
  passTests: boolean,
): Promise<StepOutcome> {
  let outcome: ApplyOutcome;
  const captchaBudget =
    ctx.config.captchaTimeoutSec * Math.max(1, ctx.config.captchaMaxAttempts) * 1000 + 180_000;
  try {
    outcome = await withTimeout(
      ctx.oauth.apply(vacancy.externalId, letter),
      captchaBudget,
      "hh apply",
    );
  } catch (error) {
    return {
      result: false,
      error: `timeout_or_http: ${error instanceof Error ? error.message : String(error)}`,
      skipRecord: false,
      globalError: false,
      viaPlaywright: false,
    };
  }

  if (outcome.result === false && outcome.error === "needs_test") {
    if (!passTests) {
      return {
        result: false,
        error: "needs_test_disabled",
        skipRecord: true,
        globalError: false,
        viaPlaywright: false,
      };
    }
    if (!ctx.browser.isAvailable()) {
      return {
        result: false,
        error: "needs_test_no_browser",
        skipRecord: true,
        globalError: false,
        viaPlaywright: false,
      };
    }

    try {
      const result = await withTimeout(
        ctx.playwright.applyToVacancy(vacancy.url, letter, {
          vacancyTitle: vacancy.title,
          vacancyDescription: vacancy.description ?? undefined,
        }),
        300_000,
        "playwright apply",
      );
      return mapPlaywrightResult(result);
    } catch (error) {
      return {
        result: false,
        error: `playwright: ${error instanceof Error ? error.message : String(error)}`,
        skipRecord: false,
        globalError: false,
        viaPlaywright: true,
      };
    }
  }

  const error = (outcome.error ?? "").toLowerCase();
  if (outcome.result === false && GLOBAL_ERRORS.has(error)) {
    return {
      result: false,
      error,
      skipRecord: true,
      globalError: true,
      viaPlaywright: false,
    };
  }

  return {
    result: outcome.result,
    error: outcome.error,
    skipRecord: false,
    globalError: false,
    viaPlaywright: false,
  };
}

function recordOutcome(
  ctx: AppContext,
  vacancy: Vacancy,
  letter: string,
  step: StepOutcome,
): void {
  if (step.result === "already") {
    ctx.db.setVacancyStatus(vacancy.id, "applied");
    return;
  }
  if (step.result === true) {
    ctx.db.addApplication({
      vacancyId: vacancy.id,
      platform: vacancy.platform,
      coverLetter: letter,
      status: "sent",
    });
    ctx.db.setVacancyStatus(vacancy.id, "applied");
    return;
  }
  if (step.skipRecord) return;
  ctx.db.addApplication({
    vacancyId: vacancy.id,
    platform: vacancy.platform,
    coverLetter: letter,
    status: "failed",
    errorMessage: step.error ?? "unknown",
  });
}

async function notifyResult(
  ctx: AppContext,
  vacancy: Vacancy,
  step: StepOutcome,
  viaTest = false,
): Promise<void> {
  const label = "hh.ru";
  const score = vacancy.score === null ? "—" : `${Math.round(vacancy.score)}%`;
  let emoji = "❌";
  let word = "Не удалось откликнуться";
  if (step.result === true) {
    emoji = "✅";
    word = "Отклик отправлен";
  } else if (step.result === "already") {
    emoji = "↩️";
    word = "Уже откликались";
  }
  const extra = step.error ? `\n<i>${escapeHtml(step.error)}</i>` : "";
  const prefix = viaTest ? "🧪 " : "";
  await ctx.notifier.vlog(
    `${prefix}${emoji} <b>${word}</b> · ${label} · score ${score}\n` +
      `${escapeHtml(truncate(vacancy.title ?? "", 90))}\n` +
      `${vacancy.url}${extra}`,
  );
}

function notifyGlobalError(ctx: AppContext, error: string, vacancy: Vacancy): void {
  const messages: Record<string, string> = {
    daily_limit:
      "📵 <b>Дневной лимит hh.ru достигнут.</b>\nСледующий цикл откликов — после полуночи или после сброса лимита на hh.",
    auth_required:
      "🔐 <b>Сессия hh.ru слетела.</b>\nОтправь /login, чтобы войти по коду, или запусти <code>bun run login</code>.",
    auth_expired:
      "🔐 <b>Токен hh.ru истёк.</b>\nОтправь /login или запусти <code>bun run login</code>.",
    no_oauth_token:
      "🔐 <b>Нет OAuth-токена hh.ru.</b>\nОтправь /login или запусти <code>bun run login</code>.",
    no_resume_id:
      "📄 <b>В аккаунте hh.ru не найдено резюме.</b>\nОпубликуй резюме на hh.ru и повтори.",
    captcha_failed:
      "🔐 <b>Капча hh.ru не решена.</b>\nЦикл откликов остановлен, чтобы не долбить hh. " +
      "Проверь, что бот может присылать капчу в Telegram, и попробуй снова.",
  };
  const text = messages[error];
  if (text) {
    void ctx.notifier.send(`${text}\n\nВакансия: ${escapeHtml(truncate(vacancy.title, 70))}`);
  }
}

/** Ручной отклик из карточки вакансии (кнопка «Откликнуться»). */
let applyRunning = false;

export async function manualApply(
  ctx: AppContext,
  vacancy: Vacancy,
): Promise<{ result: ApplyResult; error?: string }> {
  if (applyRunning) return { result: false, error: "busy" };
  applyRunning = true;
  try {
    const letter = renderLetter(ctx.config.coverLetter, vacancy.title, vacancy.companyName ?? "");
    const step = await applyOne(ctx, vacancy, letter, ctx.state.passTests);
    recordOutcome(ctx, vacancy, letter, step);
    await notifyResult(ctx, vacancy, step);
    return { result: step.result, error: step.error };
  } finally {
    applyRunning = false;
  }
}

export interface AutoApplyOptions {
  minScore?: number;
  passTests?: boolean;
}

export async function runAutoApply(
  ctx: AppContext,
  options: AutoApplyOptions = {},
): Promise<number> {
  if (applyRunning) {
    log.info("auto_apply_busy");
    return 0;
  }
  applyRunning = true;
  try {
    return await runAutoApplyInner(ctx, options);
  } finally {
    applyRunning = false;
  }
}

async function runAutoApplyInner(
  ctx: AppContext,
  options: AutoApplyOptions = {},
): Promise<number> {
  log.info("auto_apply_started", { autoMode: true });

  if (ctx.state.pausedPlatforms.has(PLATFORM)) {
    log.info("apply_skip_paused_platform", { platform: PLATFORM });
    return 0;
  }

  if (ctx.config.dryRun) {
    log.warn("auto_apply_dry_run");
    return 0;
  }

  try {
    await syncAppliedFromHH(ctx);
  } catch (error) {
    log.warn("sync_applied_skip", {
      error: error instanceof Error ? error.message : error,
    });
  }

  const daytime = isDaytime(ctx.config);
  const minScore =
    options.minScore ??
    (daytime ? ctx.config.applyMinScoreDay : ctx.config.applyMinScoreNight);
  const passTests = options.passTests ?? ctx.state.passTests;

  const cap = ctx.config.maxAppliesPerDay;
  const done = ctx.db.countSentToday(PLATFORM);
  const remaining = Math.max(0, cap - done);
  if (remaining === 0) {
    log.info("daily_limit_reached", { done, cap });
    return 0;
  }

  const vacancies = ctx.db.getApplyCandidates(PLATFORM, remaining, minScore);
  log.info("apply_window", {
    daytime,
    minScore,
    remaining,
    candidates: vacancies.length,
  });

  if (vacancies.length === 0) {
    log.info("auto_apply_no_candidates");
    return 0;
  }

  await ctx.notifier.vlog(
    `🚀 <b>Цикл откликов</b>: в очереди ${vacancies.length} ` +
      `(порог score ≥ ${minScore})`,
  );

  let applied = 0;
  for (const vacancy of vacancies) {
    const letter = renderLetter(
      ctx.config.coverLetter,
      vacancy.title,
      vacancy.companyName ?? "",
    );
    const step = await applyOne(ctx, vacancy, letter, passTests);
    recordOutcome(ctx, vacancy, letter, step);
    await notifyResult(ctx, vacancy, step);

    if (step.result === true) applied += 1;

    if (step.globalError) {
      log.warn("apply_run_aborted", {
        reason: step.error,
        vacancyId: vacancy.id,
      });
      notifyGlobalError(ctx, step.error ?? "", vacancy);
      break;
    }

    await randomDelay(ctx.config.applyDelayMin, ctx.config.applyDelayMax);
  }

  log.info("auto_apply_complete", { applied });
  await ctx.notifier.vlog(`🏁 <b>Цикл откликов завершён</b>: отправлено ${applied}`);
  return applied;
}

export interface TestApplyStats {
  sent: number;
  already: number;
  failed: number;
  attempted: number;
}

/** /test_apply: N откликов с подробным логом (для проверки настройки). */
export async function runTestApply(
  ctx: AppContext,
  count = 10,
  minScore = 70,
): Promise<TestApplyStats> {
  if (applyRunning) {
    log.info("test_apply_busy");
    return { sent: 0, already: 0, failed: 0, attempted: 0 };
  }
  applyRunning = true;
  try {
    return await runTestApplyInner(ctx, count, minScore);
  } finally {
    applyRunning = false;
  }
}

async function runTestApplyInner(
  ctx: AppContext,
  count = 10,
  minScore = 70,
): Promise<TestApplyStats> {
  await syncAppliedFromHH(ctx);
  const vacancies = ctx.db.getApplyCandidates(PLATFORM, count, minScore);
  const stats: TestApplyStats = { sent: 0, already: 0, failed: 0, attempted: 0 };

  for (const vacancy of vacancies) {
    stats.attempted += 1;
    const letter = renderLetter(ctx.config.coverLetter, vacancy.title, vacancy.companyName ?? "");
    const step = await applyOne(ctx, vacancy, letter, ctx.state.passTests);
    recordOutcome(ctx, vacancy, letter, step);
    await notifyResult(ctx, vacancy, step, true);

    if (step.result === true) stats.sent += 1;
    else if (step.result === "already") stats.already += 1;
    else stats.failed += 1;

    if (step.globalError) {
      notifyGlobalError(ctx, step.error ?? "", vacancy);
      break;
    }
    if (stats.attempted < vacancies.length) {
      await randomDelay(ctx.config.applyDelayMin, ctx.config.applyDelayMax);
    }
  }

  return stats;
}
