/**
 * Состояние планировщика. Хранится в JSON-файле с теми же ключами, что и
 * Python-версия, чтобы можно было продолжить работу со старым
 * `data/scheduler_state.json`.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { Logger } from "./logger";

const log = new Logger("state");

export interface SchedulerStateData {
  is_paused: boolean;
  auto_apply: boolean;
  pass_tests: boolean;
  notify_messages: boolean;
  thank_rejections: boolean;
  bump_resume: boolean;
  paused_platforms: string[];
  manual_paused_platforms: string[];
  last_login_alert: Record<string, string>;
  last_apply_summary_at?: string;
  /** Причина автоматической паузы автооткликов (например, captcha_failed). */
  auto_apply_paused_reason?: string;
  auto_apply_paused_at?: string;
}

const DEFAULTS: SchedulerStateData = {
  is_paused: false,
  auto_apply: false,
  pass_tests: true,
  notify_messages: true,
  thank_rejections: true,
  bump_resume: true,
  paused_platforms: [],
  manual_paused_platforms: [],
  last_login_alert: {},
};

export class SchedulerState {
  private data: SchedulerStateData;

  constructor(private readonly path: string) {
    this.data = this.load();
  }

  private load(): SchedulerStateData {
    if (!existsSync(this.path)) return { ...DEFAULTS };
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<SchedulerStateData>;
      return {
        ...DEFAULTS,
        ...raw,
        paused_platforms: Array.isArray(raw.paused_platforms) ? raw.paused_platforms : [],
        manual_paused_platforms: Array.isArray(raw.manual_paused_platforms)
          ? raw.manual_paused_platforms
          : [],
        last_login_alert:
          raw.last_login_alert && typeof raw.last_login_alert === "object"
            ? raw.last_login_alert
            : {},
      };
    } catch (error) {
      log.warn("state_load_error", {
        error: error instanceof Error ? error.message : error,
      });
      return { ...DEFAULTS };
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.tmp`;
      writeFileSync(temporary, JSON.stringify(this.data, null, 2), "utf8");
      renameSync(temporary, this.path);
    } catch (error) {
      log.warn("state_save_error", {
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  get isPaused(): boolean {
    return Boolean(this.data.is_paused);
  }

  setPaused(value: boolean): void {
    this.data.is_paused = value;
    this.save();
  }

  get autoApply(): boolean {
    return Boolean(this.data.auto_apply);
  }

  setAutoApply(value: boolean): void {
    this.data.auto_apply = value;
    // Ручное переключение автооткликов снимает автоматическую паузу.
    delete this.data.auto_apply_paused_reason;
    delete this.data.auto_apply_paused_at;
    this.save();
  }

  get autoApplyPaused(): boolean {
    return Boolean(this.data.auto_apply_paused_reason);
  }

  get autoApplyPausedReason(): string | undefined {
    return this.data.auto_apply_paused_reason;
  }

  /** Автоматически приостановить автоотклики (капча, ошибка и т.п.). */
  pauseAutoApply(reason: string): void {
    this.data.auto_apply_paused_reason = reason;
    this.data.auto_apply_paused_at = new Date().toISOString();
    this.save();
    log.warn("auto_apply_paused", { reason });
  }

  /** Снять автоматическую паузу и включить автоотклики. */
  resumeAutoApply(): void {
    this.data.auto_apply = true;
    delete this.data.auto_apply_paused_reason;
    delete this.data.auto_apply_paused_at;
    this.save();
    log.info("auto_apply_resumed");
  }

  get passTests(): boolean {
    return Boolean(this.data.pass_tests);
  }

  get notifyMessages(): boolean {
    return Boolean(this.data.notify_messages);
  }

  get thankRejections(): boolean {
    return Boolean(this.data.thank_rejections);
  }

  get bumpResume(): boolean {
    return Boolean(this.data.bump_resume);
  }

  get flags(): Record<string, boolean> {
    return {
      auto_apply: this.data.auto_apply,
      pass_tests: this.data.pass_tests,
      notify_messages: this.data.notify_messages,
      thank_rejections: this.data.thank_rejections,
      bump_resume: this.data.bump_resume,
    };
  }

  setFlag(name: string, value: boolean): void {
    if (!(name in this.flags)) return;
    (this.data as unknown as Record<string, boolean>)[name] = value;
    this.save();
    log.info("flag_set", { flag: name, value });
  }

  /** Платформы, которые сейчас на паузе (ручная + автоматическая). */
  get pausedPlatforms(): Set<string> {
    return new Set([...this.data.paused_platforms, ...this.data.manual_paused_platforms]);
  }

  markPlatformPaused(platform: string): void {
    if (!this.data.paused_platforms.includes(platform)) {
      this.data.paused_platforms.push(platform);
      this.save();
    }
  }

  markPlatformHealthy(platform: string): void {
    const index = this.data.paused_platforms.indexOf(platform);
    if (index >= 0) {
      this.data.paused_platforms.splice(index, 1);
      this.save();
    }
  }

  get lastLoginAlert(): Record<string, string> {
    return this.data.last_login_alert;
  }

  setLastLoginAlert(platform: string, iso: string | null): void {
    if (iso === null) delete this.data.last_login_alert[platform];
    else this.data.last_login_alert[platform] = iso;
    this.save();
  }

  get lastApplySummaryAt(): string | undefined {
    return this.data.last_apply_summary_at;
  }

  setLastApplySummaryAt(iso: string): void {
    this.data.last_apply_summary_at = iso;
    this.save();
  }

  toJSON(): SchedulerStateData {
    return this.data;
  }
}
