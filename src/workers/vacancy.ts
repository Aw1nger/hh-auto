/** Воркеры поиска и rule-based анализа вакансий. */
import { analyzeVacancy } from "../scoring";
import type { AppContext } from "../context";
import { log } from "../logger";
import { randomDelay, withTimeout } from "../utils/async";

export async function syncAppliedFromHH(ctx: AppContext): Promise<number> {
  try {
    const ids = await withTimeout(
      ctx.oauth.getAppliedVacancyIds(),
      ctx.config.captchaTimeoutSec * ctx.config.captchaMaxAttempts * 1000 + 120_000,
      "sync applied",
    );
    if (ids.length === 0) return 0;
    const marked = ctx.db.markAppliedByExternalIds("hh", ids);
    if (marked > 0) {
      log.info("sync_applied_complete", { marked, fetched: ids.length });
    }
    return marked;
  } catch (error) {
    log.warn("sync_applied_skip", {
      error: error instanceof Error ? error.message : error,
    });
    return 0;
  }
}

export async function runVacancySearch(ctx: AppContext): Promise<number> {
  log.info("vacancy_search_started");
  let totalNew = 0;

  for (const query of ctx.config.searchQueries) {
    try {
      // remote=false — ищем всё: удалёнку, гибрид и офис.
      const vacancies = await ctx.parser.searchVacancies(query, { remote: false });
      const saved = ctx.db.insertVacancies(vacancies);
      totalNew += saved;
      log.info("search_batch_done", { query, found: vacancies.length, new: saved });
      await randomDelay(5, 15);
    } catch (error) {
      log.error("search_query_error", {
        query,
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  log.info("vacancy_search_complete", { totalNew });
  if (totalNew > 0) {
    await ctx.notifier.vlog(`🔍 <b>Поиск</b>: найдено новых вакансий — ${totalNew}`);
  }
  return totalNew;
}

export async function runVacancyAnalysis(ctx: AppContext): Promise<number> {
  log.info("vacancy_analysis_started");
  const vacancies = ctx.db.getUnanalyzed(300);
  let analyzed = 0;
  const scored: Array<{ title: string; score: number }> = [];

  for (const vacancy of vacancies) {
    try {
      const analysis = analyzeVacancy(
        {
          title: vacancy.title,
          description: vacancy.description ?? "",
          skills: vacancy.skills ?? "",
          salaryFrom: vacancy.salaryFrom,
          salaryTo: vacancy.salaryTo,
          isRemote: vacancy.isRemote,
          salaryCurrency: vacancy.salaryCurrency ?? "",
          desiredSalaryMin: ctx.config.desiredSalaryMin,
          desiredSalaryMax: ctx.config.desiredSalaryMax,
        },
        ctx.config,
      );

      const text = `${vacancy.title} ${vacancy.description ?? ""}`.toLowerCase();
      const workFormat: "remote" | "hybrid" | "office" =
        vacancy.isRemote || /удалён|удален|remote/.test(text)
          ? "remote"
          : /гибрид|hybrid/.test(text)
            ? "hybrid"
            : "office";

      ctx.db.saveAnalysis(vacancy.id, analysis.score, analysis.reason, workFormat);
      analyzed += 1;
      scored.push({ title: vacancy.title, score: analysis.score });
    } catch (error) {
      log.error("vacancy_analysis_error", {
        vacancyId: vacancy.id,
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  log.info("vacancy_analysis_complete", { analyzed });
  if (analyzed > 0) {
    const lines = [`🧠 <b>Анализ</b>: оценено вакансий — ${analyzed}`];
    for (const item of scored.sort((a, b) => b.score - a.score).slice(0, 8)) {
      lines.push(`  • ${item.score} — ${item.title.slice(0, 55)}`);
    }
    await ctx.notifier.vlog(lines.join("\n"));
  }
  return analyzed;
}
