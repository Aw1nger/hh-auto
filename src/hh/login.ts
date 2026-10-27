/**
 * Вход на hh.ru по одноразовому коду (телефон → SMS/почта → код).
 *
 * Открываем OAuth-форму hh как мобильное приложение, вводим телефон, hh
 * присылает код. Пользователь присылает код в Telegram, мы перехватываем
 * redirect `hhandroid://...?code=...`, меняем на токен и сохраняем cookies.
 *
 * Если hh показывает капчу — она уходит в Telegram тем же механизмом,
 * что и капча при откликах.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { chromium, devices, type Browser, type BrowserContext, type Page } from "playwright";

import type { Config } from "../config";
import { Logger } from "../logger";
import type { Notifier } from "../notifier";
import { withTimeout } from "../utils/async";
import { escapeHtml } from "../utils/text";
import {
  ANDROID_UA,
  CLIENT_ID,
  CLIENT_SECRET,
  HH_BASE,
  REDIRECT_URI,
} from "./constants";

const log = new Logger("hh:login");

const AUTHORIZE_URL =
  `${HH_BASE}/oauth/authorize?response_type=code` +
  `&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=bot`;

const SEL_LOGIN = 'input[data-qa="login-input-username"]';
const SEL_CODE_CONTAINER = 'div[data-qa="account-login-code-input"]';
const SEL_PIN = 'input[data-qa="magritte-pincode-input-field"]';
const SEL_CAPTCHA = 'img[data-qa="account-captcha-picture"]';

interface StoredToken {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

export class OTPLoginSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private resolveCode: ((code: string | null) => void) | null = null;
  private codePromise: Promise<string | null> | null = null;
  private capturedCode: string | null = null;

  constructor(
    private readonly config: Config,
    private readonly notifier: Notifier,
  ) {}

  async start(phone: string): Promise<{
    status: "code_sent" | "captcha" | "ok" | "error";
    error?: string;
  }> {
    try {
      this.browser = await chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      });
      const device = devices["Galaxy A55"] ?? {};
      this.context = await this.browser.newContext(device);
      this.page = await this.context.newPage();
      this.codePromise = new Promise<string | null>((resolve) => {
        this.resolveCode = resolve;
      });

      const capture = (url: string): void => {
        if (!url || !url.startsWith("hhandroid://") || !this.resolveCode) return;
        const match = /[?&]code=([^&\s]+)/.exec(url);
        this.capturedCode = match?.[1] ? decodeURIComponent(match[1]) : null;
        this.resolveCode(this.capturedCode);
        this.resolveCode = null;
      };
      this.page.on("request", (request) => capture(request.url()));
      this.page.on("response", (response) => capture(response.url()));
      this.page.on("framenavigated", (frame) => capture(frame.url()));

      try {
        await this.page.goto(AUTHORIZE_URL, { waitUntil: "domcontentloaded", timeout: 40_000 });
      } catch {
        // hhandroid:// navigation может "упасть" — это нормально.
      }
      await this.page.waitForTimeout(1500);

      await this.page.waitForSelector(SEL_LOGIN, { timeout: 20_000 });
      await this.page.fill(SEL_LOGIN, phone);
      await this.page.press(SEL_LOGIN, "Enter");
      await this.page.waitForTimeout(2500);

      if (await this.hasCaptcha()) {
        const solved = await this.solveCaptcha("вход на hh.ru по коду");
        if (!solved) {
          await this.cancel();
          return { status: "captcha", error: "captcha_not_solved" };
        }
        await this.page.waitForTimeout(1500);
      }

      if (this.resolveCode === null) {
        // Уже доверенное устройство — hh сразу отдал OAuth-код,
        // экран ввода кода может не появиться.
        const token = this.capturedCode ? await this.exchange(this.capturedCode) : null;
        if (token) {
          try {
            mkdirSync(dirname(this.config.hhStatePath), { recursive: true });
            await this.context?.storageState({ path: this.config.hhStatePath });
          } catch {
            // некритично
          }
          mkdirSync(dirname(this.config.hhTokenPath), { recursive: true });
          writeFileSync(this.config.hhTokenPath, JSON.stringify(token, null, 2), {
            encoding: "utf8",
            mode: 0o600,
          });
          log.info("otp_login_success_trusted_device");
          await this.cancel();
          return { status: "ok" };
        }
        return { status: "error", error: "empty_oauth_code" };
      }

      await this.page.waitForSelector(`${SEL_CODE_CONTAINER}, ${SEL_PIN}`, {
        timeout: 20_000,
      });
      return { status: "code_sent" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.cancel();
      return { status: "error", error: message };
    }
  }

  async submitCode(code: string): Promise<{ status: "ok" | "error"; error?: string }> {
    if (!this.page || !this.codePromise) return { status: "error", error: "no_session" };
    try {
      const pin = this.page.locator(`${SEL_PIN}, input[autocomplete="one-time-code"]`).first();
      if ((await pin.count()) === 0) return { status: "error", error: "no_code_input" };
      await pin.fill(code);
      await pin.press("Enter");

      const authCode = await withTimeout(this.codePromise, 30_000, "hh oauth code");
      if (!authCode) return { status: "error", error: "empty_oauth_code" };

      try {
        const statePath = this.config.hhStatePath;
        mkdirSync(dirname(statePath), { recursive: true });
        await this.context?.storageState({ path: statePath });
      } catch (error) {
        log.warn("otp_save_cookies_failed", {
          error: error instanceof Error ? error.message : error,
        });
      }

      const token = await this.exchange(authCode);
      if (!token) return { status: "error", error: "token_exchange_failed" };
      mkdirSync(dirname(this.config.hhTokenPath), { recursive: true });
      writeFileSync(this.config.hhTokenPath, JSON.stringify(token, null, 2), {
        encoding: "utf8",
        mode: 0o600,
      });
      log.info("otp_login_success");
      await this.cancel();
      return { status: "ok" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.cancel();
      return { status: "error", error: message };
    }
  }

  private async hasCaptcha(): Promise<boolean> {
    if (!this.page) return false;
    if ((await this.page.locator(SEL_CAPTCHA).count()) > 0) return true;
    return /\/account\/captcha/i.test(this.page.url());
  }

  private async solveCaptcha(context: string): Promise<boolean> {
    if (!this.page) return false;
    for (let attempt = 1; attempt <= this.config.captchaMaxAttempts; attempt += 1) {
      if (!(await this.hasCaptcha())) return true;
      const picture = this.page.locator(SEL_CAPTCHA).first();
      const buffer =
        (await picture.count()) > 0
          ? await picture.screenshot()
          : await this.page.screenshot({ fullPage: false });
      const answer = await this.notifier.askCaptcha(
        {
          image: new Uint8Array(buffer),
          url: this.page.url(),
          caption:
            "🔐 <b>hh.ru просит капчу при входе</b>\n\n" +
            `Контекст: ${escapeHtml(context)}\n` +
            `Попытка ${attempt}/${this.config.captchaMaxAttempts}.\n\n` +
            "Введи текст с картинки <b>одним сообщением</b>.\n" +
            "Отмена: /cancel_captcha",
        },
        this.config.captchaTimeoutSec * 1000,
      );
      if (!answer) return false;

      const input = this.page
        .locator('[data-qa="account-captcha-input"], input[name="captchaText"], input[type="text"]')
        .first();
      if ((await input.count()) === 0) return false;
      await input.fill(answer);
      const submit = this.page
        .locator(
          '[data-qa="account-captcha-submit"], button:has-text("Отправить"), button[type="submit"]',
        )
        .first();
      if ((await submit.count()) > 0) await submit.click();
      else await this.page.keyboard.press("Enter");
      await this.page.waitForTimeout(3000);
      if (!(await this.hasCaptcha())) return true;
    }
    return false;
  }

  private async exchange(code: string): Promise<StoredToken | null> {
    try {
      const response = await fetch(`${HH_BASE}/oauth/token`, {
        method: "POST",
        headers: {
          "User-Agent": ANDROID_UA,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          redirect_uri: REDIRECT_URI,
          code,
        }),
      });
      const body = await response.text();
      if (response.status !== 200) {
        log.error("otp_token_exchange_failed", {
          status: response.status,
          body: body.slice(0, 200),
        });
        return null;
      }
      const data = JSON.parse(body) as Record<string, unknown>;
      return {
        access_token: String(data.access_token),
        refresh_token: String(data.refresh_token ?? ""),
        expires_at: Date.now() / 1000 + Number(data.expires_in ?? 1_209_599),
      };
    } catch (error) {
      log.error("otp_exchange_error", {
        error: error instanceof Error ? error.message : error,
      });
      return null;
    }
  }

  async cancel(): Promise<void> {
    for (const object of [this.page, this.context, this.browser]) {
      try {
        await object?.close();
      } catch {
        // ignore
      }
    }
    this.page = null;
    this.context = null;
    this.browser = null;
    this.codePromise = null;
    this.resolveCode = null;
    this.capturedCode = null;
  }
}

// Одна активная сессия входа на пользователя Telegram.
const sessions = new Map<number, OTPLoginSession>();

export function getLoginSession(uid: number): OTPLoginSession | undefined {
  return sessions.get(uid);
}

export function setLoginSession(uid: number, session: OTPLoginSession): void {
  sessions.set(uid, session);
}

export async function dropLoginSession(uid: number): Promise<void> {
  const session = sessions.get(uid);
  sessions.delete(uid);
  if (session) await session.cancel();
}

/** Закрыть все активные сессии входа (при остановке приложения). */
export async function dropAllLoginSessions(): Promise<void> {
  const active = [...sessions.values()];
  sessions.clear();
  await Promise.allSettled(active.map((session) => session.cancel()));
}
