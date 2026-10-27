/**
 * Единая точка уведомлений в Telegram + ожидание ответа на капчу.
 *
 * Воркеры зовут `notifier.vlog(...)` для подробного лога. Когда hh.ru просит
 * капчу, `askCaptcha(...)` отправляет картинку в Telegram и ждёт, пока
 * пользователь пришлёт текст. Ответ приходит через `resolveCaptcha(...)` из
 * обработчика сообщений бота.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Logger } from "./logger";
import { Mutex } from "./utils/async";

const log = new Logger("notifier");

export interface CaptchaImagePrompt {
  image: Uint8Array;
  caption: string;
  /** Ссылка на страницу капчи — на случай, если картинка не читается. */
  url: string;
}

export type SendText = (text: string) => Promise<unknown>;
export type SendCaptchaImage = (prompt: CaptchaImagePrompt) => Promise<unknown>;

interface PendingCaptcha {
  resolve: (answer: string | null) => void;
  timer: ReturnType<typeof setTimeout>;
  askedAt: number;
}

export class Notifier {
  private sendText: SendText | null = null;
  private sendCaptchaImage: SendCaptchaImage | null = null;
  private verbose = true;
  private pending: PendingCaptcha | null = null;
  private readonly captchaMutex = new Mutex();
  private fallbackDir = "data/captcha";

  configure(options: {
    sendText: SendText;
    sendCaptchaImage?: SendCaptchaImage;
    verbose?: boolean;
    fallbackDir?: string;
  }): void {
    this.sendText = options.sendText;
    if (options.sendCaptchaImage) this.sendCaptchaImage = options.sendCaptchaImage;
    if (options.verbose !== undefined) this.verbose = options.verbose;
    if (options.fallbackDir) this.fallbackDir = options.fallbackDir;
  }

  setVerbose(value: boolean): void {
    this.verbose = value;
  }

  isVerbose(): boolean {
    return this.verbose;
  }

  /** Безусловное сообщение (если Telegram настроен). */
  async send(text: string): Promise<void> {
    if (!this.sendText) return;
    try {
      await this.sendText(text);
    } catch (error) {
      log.warn("telegram_send_failed", { error: error instanceof Error ? error.message : error });
    }
  }

  /** Подробный лог действия — только в verbose-режиме. */
  async vlog(text: string): Promise<void> {
    if (!this.verbose) return;
    await this.send(text);
  }

  hasPendingCaptcha(): boolean {
    return this.pending !== null;
  }

  pendingCaptchaAgeSec(): number | null {
    if (!this.pending) return null;
    return Math.round((Date.now() - this.pending.askedAt) / 1000);
  }

  /**
   * Разрешить ожидающую капчу ответом пользователя.
   * Возвращает true, если ответ был принят.
   */
  resolveCaptcha(answer: string): boolean {
    const pending = this.pending;
    if (!pending) return false;
    const text = answer.trim();
    if (!text) return false;
    clearTimeout(pending.timer);
    this.pending = null;
    pending.resolve(text);
    return true;
  }

  /** Отменить ожидание (пользователь нажал /cancel_captcha). */
  cancelCaptcha(reason = "отменено пользователем"): boolean {
    const pending = this.pending;
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending = null;
    pending.resolve(null);
    void this.send(`🚫 Ввод капчи ${reason}.`);
    return true;
  }

  /**
   * Отправить капчу в Telegram и дождаться текста с картинки.
   * Возвращает null, если Telegram не настроен, пользователь отменил или
   * истёк таймаут.
   */
  askCaptcha(prompt: CaptchaImagePrompt, timeoutMs: number): Promise<string | null> {
    return this.captchaMutex.runExclusive(() => this.askCaptchaInner(prompt, timeoutMs));
  }

  private async askCaptchaInner(
    prompt: CaptchaImagePrompt,
    timeoutMs: number,
  ): Promise<string | null> {
    if (!this.sendCaptchaImage) {
      const savedPath = this.saveCaptchaLocally(prompt);
      log.warn("captcha_no_telegram", { path: savedPath, url: prompt.url });
      await this.send(
        "🔐 <b>hh.ru просит капчу</b>\n\n" +
          "Telegram-отправка не настроена. Картинка сохранена:\n" +
          `<code>${savedPath}</code>\n\n` +
          `Страница: ${prompt.url}`,
      );
      return null;
    }

    let resolveAnswer!: (value: string | null) => void;
    const answerPromise = new Promise<string | null>((resolve) => {
      resolveAnswer = resolve;
    });

    const timer = setTimeout(() => {
      if (this.pending) {
        this.pending = null;
        resolveAnswer(null);
        void this.send(
          "⌛ <b>Капча не решена</b> за отведённое время. " +
            "Пропускаю текущую попытку — бот попробует снова позже.",
        );
      }
    }, timeoutMs);

    this.pending = { resolve: resolveAnswer, timer, askedAt: Date.now() };

    try {
      await this.sendCaptchaImage(prompt);
    } catch (error) {
      clearTimeout(timer);
      this.pending = null;
      resolveAnswer(null);
      const savedPath = this.saveCaptchaLocally(prompt);
      log.error("captcha_send_failed", {
        error: error instanceof Error ? error.message : error,
        path: savedPath,
      });
      void this.send(
        "🔐 <b>Не удалось отправить капчу в Telegram</b>\n\n" +
          `Картинка сохранена: <code>${savedPath}</code>\n` +
          `Страница: ${prompt.url}`,
      );
      return null;
    }

    log.info("captcha_sent_to_telegram", { url: prompt.url });
    return answerPromise;
  }

  private saveCaptchaLocally(prompt: CaptchaImagePrompt): string {
    try {
      mkdirSync(this.fallbackDir, { recursive: true });
      const path = join(this.fallbackDir, `captcha-${Date.now()}.png`);
      writeFileSync(path, prompt.image);
      return path;
    } catch {
      return "(не удалось сохранить)";
    }
  }
}

export const notifier = new Notifier();
