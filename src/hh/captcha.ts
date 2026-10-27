/**
 * Решение капчи hh.ru.
 *
 * hh.ru при 403 отдаёт `captcha_required` и ссылку на страницу капчи.
 * Схема (проверена на живом hh.ru и повторяет поведение Android-приложения):
 *
 *   1. GET  /account/captcha?state=...&backurl=hh://...   (получаем _xsrf)
 *   2. POST /captcha?lang=RU                              (получаем key)
 *   3. GET  /captcha/picture?key=...                      (картинка)
 *   4. пользователь вводит текст в Telegram
 *   5. POST /account/captcha?captchaText=...              (отправляем ответ)
 *   6. повторяем исходный запрос к API hh
 *
 * Если ответ неверный — hh снова попросит капчу, и мы покажем новую картинку.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Logger } from "../logger";
import type { CaptchaErrorInfo } from "../models";
import { sleep } from "../utils/async";
import { CookieJar } from "../utils/cookies";
import { escapeHtml } from "../utils/text";
import {
  ANDROID_WEBVIEW_UA,
  CAPTCHA_SUCCESS_BACKURL,
  DESKTOP_UA,
  HH_ACCEPT_LANGUAGE,
} from "./constants";

const log = new Logger("hh:captcha");

const ACCEPT_HTML = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const ACCEPT_IMAGE =
  "image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5";
const XHR_HEADERS: Record<string, string> = {
  Accept: "application/json",
  "X-Requested-With": "XMLHttpRequest",
  "X-Hhtmsource": "account_captcha",
  "X-Hhtmfrom": "",
};

export interface CaptchaPromptLike {
  image: Uint8Array;
  caption: string;
  url: string;
}

export type AskCaptcha = (prompt: CaptchaPromptLike) => Promise<string | null>;

export interface CaptchaSolverOptions {
  ask: AskCaptcha;
  cookiePath?: string;
  lang?: string;
  submitDelayMs?: number;
  maxAttempts?: number;
  cooldownMs?: number;
  proxyUrl?: string;
  userAgent?: string;
}

export interface CaptchaSolveResult {
  solved: boolean;
  reason?: string;
  attempts: number;
}

interface CaptchaPage {
  finalUrl: string;
  state: string;
  xsrf: string;
  origin: string;
}

interface FetchResult {
  response: Response;
  finalUrl: string;
}

function withProxy(init: RequestInit, proxyUrl?: string): RequestInit {
  if (!proxyUrl) return init;
  return { ...init, proxy: proxyUrl } as RequestInit;
}

async function readBodySnippet(response: Response, limit = 300): Promise<string> {
  try {
    const text = await response.clone().text();
    return text.slice(0, limit);
  } catch {
    return "";
  }
}

/** Достать `state` из ссылки на капчу. */
export function parseCaptchaState(url: string): string | null {
  try {
    return new URL(url).searchParams.get("state");
  } catch {
    return null;
  }
}

/** Является ли страница страницей капчи hh.ru. */
export function isHHCaptchaPage(url: string, html = ""): boolean {
  if (/\/account\/captcha/i.test(url)) return true;
  const lower = html.toLowerCase();
  return (
    lower.includes('data-qa="account-captcha-picture"') ||
    lower.includes("подтвердите, что вы не робот") ||
    lower.includes("captcha-picture")
  );
}

/**
 * Разобрать тело ответа hh API и достать ссылку на капчу.
 * Экспортируется отдельно — удобно тестировать без сети.
 */
export function extractCaptchaError(body: string): CaptchaErrorInfo | null {
  if (!body) return null;
  const trimmed = body.trim();

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const data = JSON.parse(trimmed) as unknown;
      const found = findCaptchaUrl(data);
      if (found) return found;
    } catch {
      // Ниже попробуем регуляркой.
    }
  }

  const match = /https:\/\/hh\.ru\/account\/captcha\?[^"'\s\\]+/i.exec(body);
  if (match) return { url: match[0].replaceAll("&amp;", "&") };
  return null;
}

function findCaptchaUrl(value: unknown): CaptchaErrorInfo | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findCaptchaUrl(item);
      if (found) return found;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  const errors = record.errors;
  if (Array.isArray(errors)) {
    for (const item of errors) {
      if (!item || typeof item !== "object") continue;
      const error = item as Record<string, unknown>;
      const errorValue = String(error.value ?? error.type ?? "");
      if (errorValue === "captcha_required" && typeof error.captcha_url === "string") {
        return {
          url: error.captcha_url,
          requestId: typeof record.request_id === "string" ? record.request_id : undefined,
        };
      }
    }
  }
  if (typeof record.captcha_url === "string") {
    return {
      url: record.captcha_url,
      requestId: typeof record.request_id === "string" ? record.request_id : undefined,
    };
  }
  return null;
}

export class HHCaptchaSolver {
  private readonly ask: AskCaptcha;
  private readonly cookiePath?: string;
  private readonly lang: string;
  private readonly submitDelayMs: number;
  private readonly maxAttempts: number;
  private readonly cooldownMs: number;
  private readonly proxyUrl?: string;
  private readonly userAgent: string;
  private jar: CookieJar;
  private lastSolvedAt = 0;

  constructor(options: CaptchaSolverOptions) {
    this.ask = options.ask;
    this.cookiePath = options.cookiePath;
    this.lang = (options.lang ?? "RU").toUpperCase();
    this.submitDelayMs = options.submitDelayMs ?? 8_000;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.cooldownMs = Math.max(0, options.cooldownMs ?? 0);
    this.proxyUrl = options.proxyUrl;
    this.userAgent = options.userAgent ?? ANDROID_WEBVIEW_UA;
    this.jar = this.loadJar();
  }

  wasRecentlySolved(withinMs = 60_000): boolean {
    return this.lastSolvedAt > 0 && Date.now() - this.lastSolvedAt <= withinMs;
  }

  /** Отметить капчу решённой (в т.ч. если её решил браузерный solver). */
  markSolved(): void {
    this.lastSolvedAt = Date.now();
  }

  /**
   * Пройти капчу. Возвращает solved=true, если ответ отправлен (hh мог его
   * не принять — это выяснится при повторном запросе к API).
   */
  async solve(captchaUrl: string, reason: string): Promise<CaptchaSolveResult> {
    if (!captchaUrl) return { solved: false, reason: "no_captcha_url", attempts: 0 };

    let attempts = 0;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      attempts = attempt;
      try {
        const page = await this.openPage(captchaUrl);
        const key = await this.requestKey(page);
        const image = await this.fetchImage(page, key);
        const caption =
          "🔐 <b>hh.ru просит капчу</b>\n\n" +
          `Контекст: ${escapeHtml(reason)}\n` +
          `Попытка ${attempt}/${this.maxAttempts}.\n\n` +
          "Введи текст с картинки <b>одним сообщением</b>.\n" +
          "Отмена: /cancel_captcha";

        const answer = await this.ask({ image, caption, url: captchaUrl });
        if (!answer) {
          this.saveJar();
          return { solved: false, reason: "cancelled_or_timeout", attempts };
        }

        // hh не любит мгновенную отправку — небольшая пауза, как в приложении.
        if (this.submitDelayMs > 0) await sleep(this.submitDelayMs);

        const accepted = await this.submit(page, key, answer.trim());
        this.saveJar();
        if (accepted) {
          this.lastSolvedAt = Date.now();
          log.info("captcha_submitted", { attempt, reason });
          return { solved: true, attempts };
        }
        log.warn("captcha_rejected", { attempt, reason });
        if (this.cooldownMs > 0) await sleep(this.cooldownMs);
      } catch (error) {
        this.saveJar();
        log.warn("captcha_solve_error", {
          attempt,
          error: error instanceof Error ? error.message : error,
        });
        if (attempt === this.maxAttempts) {
          return {
            solved: false,
            reason: error instanceof Error ? error.message : String(error),
            attempts,
          };
        }
        await sleep(1500);
      }
    }

    return { solved: false, reason: "captcha_not_accepted", attempts };
  }

  // ── HTTP ───────────────────────────────────────────────────────────────

  private async openPage(captchaUrl: string): Promise<CaptchaPage> {
    const url = new URL(captchaUrl);
    url.searchParams.set("backurl", CAPTCHA_SUCCESS_BACKURL);

    let result = await this.fetchWithCookies(url.toString(), {
      headers: {
        "User-Agent": this.userAgent,
        Accept: ACCEPT_HTML,
        "Accept-Language": HH_ACCEPT_LANGUAGE,
      },
    });

    // Страница капчи отдаёт 404, если UA не похож на браузерный.
    if (result.response.status === 404) {
      result = await this.fetchWithCookies(url.toString(), {
        headers: {
          "User-Agent": DESKTOP_UA,
          Accept: ACCEPT_HTML,
          "Accept-Language": HH_ACCEPT_LANGUAGE,
        },
      });
    }

    if (!result.response.ok) {
      throw new Error(`captcha page HTTP ${result.response.status}`);
    }

    const html = await result.response.text();
    if (!isHHCaptchaPage(result.finalUrl, html) && !this.jar.get("_xsrf", result.finalUrl)) {
      throw new Error("страница капчи не распознана");
    }

    let state = parseCaptchaState(result.finalUrl);
    if (!state) state = parseCaptchaState(url.toString());
    if (!state) throw new Error("в ссылке на капчу нет state");

    let xsrf = this.jar.get("_xsrf", result.finalUrl) ?? "";
    if (!xsrf) {
      const match =
        /_xsrf["']?\s*[:=]\s*["']([A-Za-z0-9._-]+)["']/.exec(html) ??
        /name=["']_xsrf["'][^>]*value=["']([^"']+)["']/.exec(html);
      if (match?.[1]) xsrf = match[1];
    }
    if (!xsrf) throw new Error("hh не выдал _xsrf для капчи");

    return {
      finalUrl: result.finalUrl,
      state,
      xsrf,
      origin: new URL(result.finalUrl).origin,
    };
  }

  private async requestKey(page: CaptchaPage): Promise<string> {
    const url = `${page.origin}/captcha?lang=${encodeURIComponent(this.lang)}`;
    const response = await this.xhr(page, url, "POST");
    if (!response.ok) {
      throw new Error(`captcha key HTTP ${response.status}`);
    }
    const text = await response.text();
    let key = "";
    try {
      const data = JSON.parse(text) as { key?: unknown };
      if (typeof data.key === "string") key = data.key;
    } catch {
      const match = /"key"\s*:\s*"([^"]+)"/.exec(text);
      if (match?.[1]) key = match[1];
    }
    if (!key) throw new Error("hh не вернул ключ капчи");
    return key;
  }

  private async fetchImage(page: CaptchaPage, key: string): Promise<Uint8Array> {
    const url = `${page.origin}/captcha/picture?key=${encodeURIComponent(key)}`;
    const result = await this.fetchWithCookies(url, {
      headers: {
        "User-Agent": this.userAgent,
        Accept: ACCEPT_IMAGE,
        "Accept-Language": HH_ACCEPT_LANGUAGE,
        Referer: page.finalUrl,
      },
    });
    if (!result.response.ok) {
      throw new Error(`captcha image HTTP ${result.response.status}`);
    }
    const bytes = new Uint8Array(await result.response.arrayBuffer());
    if (bytes.length < 500) throw new Error("пустая картинка капчи");
    const isPng =
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
    const isGif = bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46;
    if (!isPng && !isJpeg && !isGif) {
      throw new Error("hh вернул не картинку капчи");
    }
    return bytes;
  }

  private async submit(page: CaptchaPage, key: string, answer: string): Promise<boolean> {
    const failUrl = `/account/captcha?state=${encodeURIComponent(page.state)}&backurl=${encodeURIComponent(CAPTCHA_SUCCESS_BACKURL)}`;
    const params = new URLSearchParams({
      captchaText: answer,
      captchaKey: key,
      captchaState: page.state,
      backurl: CAPTCHA_SUCCESS_BACKURL,
      failurl: failUrl,
    });
    const url = `${page.origin}/account/captcha?${params.toString()}`;
    const response = await this.xhr(page, url, "POST");
    const snippet = await readBodySnippet(response);
    // Успех — 203/302 с редиректом на hh://applicant/captchaSuccessBackUrl.
    // Иногда hh отдаёт 200/203 с текстом «Неверный текст» — это не успех.
    const explicitlyWrong = /неверный\s+текст|попробуйте\s+(ещ[её]|снова)|"isBot"\s*:\s*true/i.test(
      snippet,
    );
    const ok = response.status >= 200 && response.status < 400 && !explicitlyWrong;
    log.info("captcha_submit_result", {
      status: response.status,
      accepted: ok,
      body: ok ? undefined : snippet,
    });
    return ok;
  }

  private async xhr(page: CaptchaPage, url: string, method: string): Promise<Response> {
    const headers: Record<string, string> = {
      ...XHR_HEADERS,
      "User-Agent": this.userAgent,
      "Accept-Language": HH_ACCEPT_LANGUAGE,
      "X-XSRFToken": page.xsrf,
      Origin: page.origin,
      Referer: page.finalUrl,
    };
    const cookie = this.jar.header(url);
    if (cookie) headers.Cookie = cookie;

    const response = await fetch(
      url,
      withProxy(
        {
          method,
          headers,
          redirect: "manual",
        },
        this.proxyUrl,
      ),
    );
    this.jar.setFromHeaders(url, response.headers);
    return response;
  }

  private async fetchWithCookies(
    url: string,
    init: RequestInit,
    maxRedirects = 10,
  ): Promise<FetchResult> {
    let currentUrl = url;
    let method = init.method ?? "GET";
    let body = init.body;

    for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
      const headers: Record<string, string> = {
        ...(init.headers as Record<string, string> | undefined),
      };
      const cookie = this.jar.header(currentUrl);
      if (cookie) headers.Cookie = cookie;

      const response = await fetch(
        currentUrl,
        withProxy({ ...init, method, body, headers, redirect: "manual" }, this.proxyUrl),
      );
      this.jar.setFromHeaders(currentUrl, response.headers);

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) return { response, finalUrl: currentUrl };
        const nextUrl = new URL(location, currentUrl).toString();
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method !== "GET")) {
          method = "GET";
          body = undefined;
        }
        currentUrl = nextUrl;
        continue;
      }

      // Тело ответа уже прочитано? Нет — возвращаем как есть.
      return { response, finalUrl: currentUrl };
    }

    throw new Error("слишком много редиректов на странице капчи");
  }

  // ── Cookies ────────────────────────────────────────────────────────────

  private loadJar(): CookieJar {
    if (!this.cookiePath) return new CookieJar();
    try {
      const raw = readFileSync(this.cookiePath, "utf8");
      const cookies = JSON.parse(raw) as Parameters<typeof CookieJar.fromJSON>[0];
      return CookieJar.fromJSON(cookies);
    } catch {
      return new CookieJar();
    }
  }

  private saveJar(): void {
    if (!this.cookiePath) return;
    try {
      mkdirSync(dirname(this.cookiePath), { recursive: true });
      writeFileSync(this.cookiePath, JSON.stringify(this.jar.toJSON(), null, 2), {
        encoding: "utf8",
        mode: 0o600,
      });
    } catch {
      // некритично
    }
  }
}
