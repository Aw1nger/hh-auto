/**
 * Планировщик фоновых задач. Заменяет APScheduler из Python-версии:
 * обычные setInterval/setTimeout с защитой от параллельного запуска.
 */
import type { AppContext } from "./context";
import { log } from "./logger";
import type { IncomingMessage } from "./workers/messages";
import { checkAllMessages, formatMessageNotification } from "./workers/messages";
import { runAutoApply } from "./workers/apply";
import { runVacancyAnalysis, runVacancySearch } from "./workers/vacancy";
import {
  formatMoscowTime,
  getMoscowParts,
  isQuietHours,
  moscowHourKey,
  startOfMoscowDayUtcIso,
} from "./utils/time";

const REJECT_PATTERNS = ["отказ", "не подош", "отклонил", "решил остановить"];
const NOISE_PATTERNS = [
  "резюме отправлено",
  "отклик отправлен",
  "отклик доставлен",
  "не просмотрено",
  "просмотрено",
  "новый",
  "ожидании",
  "ожидает",
  "думают",
  "думает",
];
const NOTIFY_STATUS_PATTERNS = [
  "пригласил",
  "приглаш",
  "интервью",
  "собеседован",
  "оффер",
  "офер",
  "звонок",
  "позвон",
  "созвон",
  "тестовое",
  "задание",
  "получен ответ",
  "ответ работодателя",
  "написал",
  "сообщение от",
  "новое сообщение",
];

const SUMMARY_HOURS = [10, 12, 14, 16, 18, 20, 22];
const PLATFORM_LABEL = "hh.ru";

export class WorkerScheduler {
  private readonly intervals: Array<ReturnType<typeof setInterval>> = [];
  private readonly timeouts: Array<ReturnType<typeof setTimeout>> = [];
  private readonly busy = new Set<string>();
  private readonly inflight = new Set<Promise<unknown>>();
  private lastSummaryKey = "";
  private started = false;

  constructor(private readonly ctx: AppContext) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    const intervalMs = this.ctx.config.checkIntervalSec * 1000;

    this.scheduleEvery("vacancy_search", intervalMs, () => this.jobSearch(), 10_000);
    this.scheduleEvery("vacancy_analysis", intervalMs + 60_000, () => this.jobAnalyze(), 30_000);
    this.scheduleEvery("message_check", intervalMs, () => this.jobMessages(), 90_000);
    this.scheduleEvery("auto_apply", intervalMs, () => this.jobApply(), 60_000);
    this.scheduleEvery("bump_resume", 4 * 60 * 60 * 1000, () => this.jobBumpResume(), 5 * 60_000);
    this.scheduleEvery(
      "login_health",
      30 * 60_000,
      () => this.jobLoginHealth(),
      10 * 60_000,
    );
    this.scheduleEvery("apply_summary_check", 60_000, () => this.jobSummaryCheck(), 15_000);

    log.info("scheduler_started", { intervalSec: this.ctx.config.checkIntervalSec });
  }

  private scheduleEvery(
    name: string,
    intervalMs: number,
    run: () => Promise<unknown>,
    initialDelayMs: number,
  ): void {
    const first = setTimeout(() => {
      void this.runJob(name, run);
      const interval = setInterval(() => {
        void this.runJob(name, run);
      }, intervalMs);
      this.intervals.push(interval);
    }, initialDelayMs);
    this.timeouts.push(first);
  }

  private runJob(name: string, run: () => Promise<unknown>): Promise<void> {
    if (this.busy.has(name)) {
      log.debug("job_skip_busy", { job: name });
      return Promise.resolve();
    }
    this.busy.add(name);
    const promise = (async () => {
      try {
        await run();
      } catch (error) {
        log.error("job_error", {
          job: name,
          error: error instanceof Error ? error.message : error,
        });
      }
    })();
    this.inflight.add(promise);
    void promise.finally(() => {
      this.busy.delete(name);
      this.inflight.delete(promise);
    });
    return promise;
  }

  async stop(): Promise<void> {
    for (const timer of this.intervals) clearInterval(timer);
    for (const timer of this.timeouts) clearTimeout(timer);
    this.intervals.length = 0;
    this.timeouts.length = 0;
    await Promise.race([
      Promise.allSettled([...this.inflight]),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5000);
        timer.unref?.();
      }),
    ]);
    this.started = false;
    log.info("scheduler_stopped");
  }

  // ── Управление ─────────────────────────────────────────────────────────

  get isPaused(): boolean {
    return this.ctx.state.isPaused;
  }

  get autoApply(): boolean {
    return this.ctx.state.autoApply;
  }

  pause(): void {
    this.ctx.state.setPaused(true);
    log.info("scheduler_paused");
  }

  resume(): void {
    this.ctx.state.setPaused(false);
    log.info("scheduler_resumed");
  }

  setAutoApply(enabled: boolean): void {
    this.ctx.state.setAutoApply(enabled);
    log.info("auto_apply_set", { enabled });
  }

  getFlags(): Record<string, boolean> {
    return this.ctx.state.flags;
  }

  setFlag(name: string, value: boolean): void {
    this.ctx.state.setFlag(name, value);
  }

  async forceSearch(): Promise<number> {
    return this.runExclusive("vacancy_search", () => runVacancySearch(this.ctx));
  }

  async forceApply(): Promise<number> {
    return this.runExclusive("auto_apply", () => runAutoApply(this.ctx));
  }

  private async runExclusive<T>(name: string, fn: () => Promise<T>): Promise<T> {
    if (this.busy.has(name)) {
      throw new Error("Задача уже выполняется");
    }
    this.busy.add(name);
    try {
      return await fn();
    } finally {
      this.busy.delete(name);
    }
  }

  // ── Задачи ─────────────────────────────────────────────────────────────

  private async jobSearch(): Promise<void> {
    if (this.ctx.state.isPaused) return;
    await runVacancySearch(this.ctx);
  }

  private async jobAnalyze(): Promise<void> {
    if (this.ctx.state.isPaused) return;
    await runVacancyAnalysis(this.ctx);
  }

  private async jobApply(): Promise<void> {
    if (this.ctx.state.isPaused || !this.ctx.state.autoApply) return;
    await runAutoApply(this.ctx);
  }

  private async jobMessages(): Promise<void> {
    if (this.ctx.state.isPaused || !this.ctx.state.notifyMessages) return;
    const messages = await checkAllMessages(this.ctx);
    if (messages.length === 0) return;

    const echoCutoff = new Date(Date.now() - 45 * 60_000).toISOString();
    for (const message of messages) {
      try {
        await this.handleMessage(message, echoCutoff);
      } catch (error) {
        log.warn("message_notify_error", {
          error: error instanceof Error ? error.message : error,
        });
      }
    }
  }

  private async handleMessage(message: IncomingMessage, echoCutoff: string): Promise<void> {
    const status = message.text.toLowerCase();
    const combined = `${status} ${message.text.toLowerCase()}`;

    if (REJECT_PATTERNS.some((pattern) => combined.includes(pattern))) {
      log.info("msg_skip_rejection", { title: message.title?.slice(0, 50) });
      return;
    }

    const isSignal = NOTIFY_STATUS_PATTERNS.some((pattern) => combined.includes(pattern));
    const isEcho =
      Boolean(message.title) &&
      this.ctx.db.hadRecentApplicationForTitle(message.title ?? "", echoCutoff);
    if (isEcho && !isSignal) {
      log.info("msg_skip_apply_echo", { title: message.title?.slice(0, 50) });
      return;
    }

    const isNoise = !status || NOISE_PATTERNS.some((pattern) => status.includes(pattern));
    if (isNoise && !isSignal) {
      log.info("msg_skip_noise", { status: message.text.slice(0, 40) });
      return;
    }

    if (isQuietHours(this.ctx.config)) return;
    await this.ctx.notifier.send(formatMessageNotification(message));
  }

  private async jobBumpResume(): Promise<void> {
    if (this.ctx.state.isPaused || !this.ctx.state.bumpResume) return;
    const result = await this.ctx.oauth.bumpResumes();
    if (result.error) {
      log.warn("bump_resume_error", { error: result.error });
      return;
    }
    if (result.bumped > 0) {
      if (!isQuietHours(this.ctx.config)) {
        await this.ctx.notifier.send(
          `⬆️ Поднято резюме: ${result.bumped}` +
            (result.titles.length > 0 ? `\n${result.titles.map((t) => `• ${t}`).join("\n")}` : ""),
        );
      }
    } else if (result.blocked > 0) {
      log.info("bump_resume_blocked", { blocked: result.blocked });
    }
  }

  private async jobLoginHealth(): Promise<void> {
    try {
      const me = await this.ctx.oauth.getMe();
      const ok = me.ok;
      const wasPaused = this.ctx.state.pausedPlatforms.has("hh");
      let changed = false;
      let newlyBroken = false;
      let recovered = false;

      if (!ok && !wasPaused) {
        this.ctx.state.markPlatformPaused("hh");
        newlyBroken = true;
        changed = true;
        log.warn("login_health_hh_expired");
      } else if (ok && wasPaused) {
        this.ctx.state.markPlatformHealthy("hh");
        recovered = true;
        changed = true;
        log.info("login_health_hh_recovered");
      }

      const now = Date.now();
      const alertCooldownMs = 12 * 60 * 60 * 1000;
      const persistentDead =
        this.ctx.state.pausedPlatforms.has("hh") && !ok;
      let needRemind = false;
      if (persistentDead) {
        const last = this.ctx.state.lastLoginAlert.hh;
        if (!last) needRemind = true;
        else {
          const lastTime = Date.parse(last);
          if (!Number.isFinite(lastTime) || now - lastTime >= alertCooldownMs) needRemind = true;
        }
      }

      if ((newlyBroken || needRemind) && !isQuietHours(this.ctx.config)) {
        await this.ctx.notifier.send(
          "⚠️ <b>Нужен перелогин hh.ru</b>\n\n" +
            "Сессия слетела. Отправь /login (вход по коду) или запусти " +
            "<code>bun run login</code>.",
        );
        this.ctx.state.setLastLoginAlert("hh", new Date().toISOString());
        changed = true;
      }

      if (recovered) {
        await this.ctx.notifier.send("✅ <b>Сессия hh.ru восстановлена</b>");
        this.ctx.state.setLastLoginAlert("hh", null);
        changed = true;
      }

      if (!changed) log.info("login_health_ok", { status: me.status });
    } catch (error) {
      log.error("job_login_health_error", {
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  private async jobSummaryCheck(): Promise<void> {
    const parts = getMoscowParts();
    if (parts.minute > 4) return;
    if (!SUMMARY_HOURS.includes(parts.hour)) return;
    const key = moscowHourKey();
    if (key === this.lastSummaryKey) return;
    this.lastSummaryKey = key;
    await this.runJob("apply_summary", () => this.jobApplySummary());
  }

  async jobApplySummary(): Promise<void> {
    try {
      const now = new Date();
      let windowStart = this.ctx.state.lastApplySummaryAt
        ? new Date(this.ctx.state.lastApplySummaryAt)
        : new Date(startOfMoscowDayUtcIso(now));
      if (!Number.isFinite(windowStart.getTime())) {
        windowStart = new Date(startOfMoscowDayUtcIso(now));
      }
      const windowStartIso = windowStart.toISOString();

      const summary = this.ctx.db.getWindowSummary(windowStartIso);
      const totalSent = summary.sent.reduce((sum, item) => sum + item.count, 0);
      const totalFailed = summary.failed.reduce((sum, item) => sum + item.count, 0);
      const todaySent = this.ctx.db.countSentTotalToday();

      if (totalSent === 0 && totalFailed === 0) {
        await this.ctx.notifier.send(
          `📊 <b>Сводка откликов ${formatMoscowTime(windowStart)}–${formatMoscowTime(now)}</b>\n\n` +
            "За окно откликов не было.\n" +
            `🗓 За сегодня всего: <b>${todaySent}</b>`,
        );
        this.ctx.state.setLastApplySummaryAt(now.toISOString());
        return;
      }

      const lines = [
        `📊 <b>Сводка откликов ${formatMoscowTime(windowStart)}–${formatMoscowTime(now)}</b>`,
        "",
      ];
      if (totalSent > 0) {
        lines.push(`✅ Отправлено: <b>${totalSent}</b>`);
        for (const item of summary.sent.sort((a, b) => b.count - a.count)) {
          lines.push(`  • ${PLATFORM_LABEL}: ${item.count}`);
        }
      }
      if (totalFailed > 0) {
        lines.push(`⚠️ Ошибок: <b>${totalFailed}</b>`);
        for (const item of summary.failed.sort((a, b) => b.count - a.count)) {
          lines.push(`  • ${PLATFORM_LABEL}: ${item.count}`);
        }
        const errors = this.ctx.db.getErrorGroups(windowStartIso, 3);
        if (errors.length > 0) {
          lines.push("  Топ причин:");
          for (const error of errors) {
            lines.push(`    – ${error.message.slice(0, 70)} ×${error.count}`);
          }
        }
      }

      const top = this.ctx.db.getTopApplied(windowStartIso, 5);
      if (top.length > 0) {
        lines.push("", "🎯 <b>Лучшие отклики:</b>");
        for (const item of top) {
          const score = item.score === null ? "" : ` ${Math.round(item.score)}%`;
          lines.push(`  • [${PLATFORM_LABEL}]${score} ${item.title.slice(0, 60)}`);
        }
      }
      lines.push("", `🗓 За сегодня всего: <b>${todaySent}</b>`);

      await this.ctx.notifier.send(lines.join("\n"));
      this.ctx.state.setLastApplySummaryAt(now.toISOString());
      log.info("apply_summary_sent", { sent: totalSent, failed: totalFailed });
    } catch (error) {
      log.error("job_apply_summary_error", {
        error: error instanceof Error ? error.message : error,
      });
    }
  }
}
