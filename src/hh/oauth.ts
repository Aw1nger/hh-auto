/**
 * Клиент официального API hh.ru (OAuth).
 *
 * Отклики идут через `api.hh.ru` с Bearer-токеном Android-приложения — это
 * быстрее Playwright и не упирается в DDoS Guard. Если hh просит капчу,
 * `requestWithCaptcha()` передаёт её в Telegram и повторяет запрос.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Page } from "playwright";

import type { Config } from "../config";
import { Logger } from "../logger";
import type {
  ApplyOutcome,
  CaptchaErrorInfo,
  NegotiationStatus,
} from "../models";
import { sleep, withTimeout } from "../utils/async";
import {
  CLIENT_ID,
  CLIENT_SECRET,
  DESKTOP_UA,
  HH_API,
  HH_BASE,
  REDIRECT_URI,
} from "./constants";
import { HHCaptchaSolver, extractCaptchaError } from "./captcha";

const log = new Logger("hh:oauth");

interface StoredToken {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

interface RawNegotiation {
  id?: string | number;
  state?: { id?: string; name?: string };
  vacancy?: {
    id?: string | number;
    name?: string;
    employer?: { name?: string };
  };
  updated_at?: string;
  created_at?: string;
}

export interface BrowserGateway {
  isAvailable(): boolean;
  newPage(platform: string): Promise<Page>;
  saveContext(platform: string): Promise<void>;
  close?(): Promise<void>;
}

export interface BrowserCaptchaGateway {
  solveCaptchaUrl(url: string, reason: string): Promise<boolean>;
}

export interface HHOAuthOptions {
  config: Config;
  captcha: HHCaptchaSolver;
  browser: BrowserGateway;
  /** Playwright-решение капчи + запросы к API из браузера. */
  browserCaptcha?: BrowserCaptchaGateway;
  tokenPath?: string;
  fetchImpl?: typeof fetch;
}

interface RequestOptions {
  /** Человекочитаемый контекст для сообщения о капче. */
  context?: string;
  /** Переопределить User-Agent. */
  ua?: string;
}

export interface NegotiationItem {
  id: string;
  stateId: string;
  stateName: string;
  vacancyId: string;
  vacancyName: string;
  companyName: string;
  updatedAt: string;
  createdAt: string;
}

/**
 * Разбор ответа hh на отклик. Вынесено отдельно, чтобы покрыть тестами
 * все бизнес-ошибки hh (лимит, уже откликались, тест и т.д.).
 */
export function classifyApplyResponse(
  status: number,
  body: string,
): ApplyOutcome {
  const data = safeJson(body);
  const text = `${errorValue(data)} ${body}`.toLowerCase();

  const captcha = extractCaptchaError(body);
  if (captcha) {
    return {
      result: false,
      error: "captcha_failed",
      status,
      data,
      captcha: true,
    };
  }

  if (status >= 200 && status < 300) return { result: true, status, data };

  if (status === 401) return { result: false, error: "auth_expired", status, data };
  if (status === 404) return { result: "already", error: "not_found", status, data };

  if (status === 400 || status === 403 || status === 409 || status === 422) {
    if ((text.includes("limit") && !text.includes("applied")) || text.includes("limit_exceeded")) {
      return { result: false, error: "daily_limit", status, data };
    }
    if (text.includes("already") || text.includes("duplicate") || text.includes("applied")) {
      return { result: "already", status, data };
    }
    if (text.includes("test") || text.includes("questionnaire") || text.includes("задани")) {
      return { result: false, error: "needs_test", status, data };
    }
    if (
      text.includes("archived") ||
      text.includes("not_found") ||
      text.includes("vacancy_not_found") ||
      text.includes("unavailable") ||
      text.includes("hidden") ||
      text.includes("скрыт") ||
      text.includes("недоступ")
    ) {
      return { result: "already", error: "unavailable", status, data };
    }
    if (
      text.includes("application_denied") ||
      text.includes("can't respond") ||
      text.includes("cant respond") ||
      text.includes("respond to specified")
    ) {
      return { result: "already", error: "application_denied", status, data };
    }
    if (text.includes("token") || text.includes("unauthorized") || text.includes("auth")) {
      return { result: false, error: "auth_required", status, data };
    }
    return {
      result: false,
      error: errorValue(data) || "bad_request",
      status,
      data,
    };
  }

  if (status >= 500) {
    return { result: false, error: `server_error_${status}`, status, data };
  }

  return {
    result: false,
    error: errorValue(data) || `http_${status}`,
    status,
    data,
  };
}

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return { raw: body.slice(0, 500) };
  }
}

/**
 * Официальный формат UA Android-приложения hh.ru.
 * Важно: фиксированный «ru.hh.android/8.116 (Android 13; ...)» hh считает
 * подозрительным и требует капчу почти на каждый запрос. Случайный UA в
 * формате приложения проходит без капчи.
 */
export function generateHHApiUserAgent(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let model = "";
  for (let index = 0; index < 10; index += 1) {
    model += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  const minor = 100 + Math.floor(Math.random() * 51);
  const patch = 10000 + Math.floor(Math.random() * 5001);
  const android = 11 + Math.floor(Math.random() * 5);
  return (
    `ru.hh.android/7.${minor}.${patch}, Device: ${model}, ` +
    `Android OS: ${android} (UUID: ${randomUUID()})`
  );
}

function errorValue(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const record = data as Record<string, unknown>;
  const errors = record.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0] as Record<string, unknown>;
    return String(first.value ?? first.type ?? "");
  }
  if (record.description) return String(record.description);
  if (record.error) return String(record.error);
  return "";
}

export class HHOAuthClient {
  readonly captcha: HHCaptchaSolver;
  private readonly config: Config;
  private readonly browser: BrowserGateway;
  private readonly browserCaptcha?: BrowserCaptchaGateway;
  private readonly tokenPath: string;
  private readonly fetchImpl: typeof fetch;
  private token: StoredToken | null = null;
  private tokenLoaded = false;
  private apiUserAgent: string;
  private readonly fallbackUserAgent: string;
  private uaFallbackUsed = false;

  constructor(options: HHOAuthOptions) {
    this.config = options.config;
    this.captcha = options.captcha;
    this.browser = options.browser;
    this.browserCaptcha = options.browserCaptcha;
    this.tokenPath = options.tokenPath ?? options.config.hhTokenPath;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiUserAgent = options.config.hhUserAgent || generateHHApiUserAgent();
    this.fallbackUserAgent = options.config.hhUserAgentFallback || generateHHApiUserAgent();
  }

  // ── Токены ─────────────────────────────────────────────────────────────

  private loadToken(): StoredToken | null {
    if (this.tokenLoaded) return this.token;
    this.tokenLoaded = true;
    try {
      const raw = readFileSync(this.tokenPath, "utf8");
      const data = JSON.parse(raw) as Partial<StoredToken>;
      if (data.access_token && data.refresh_token !== undefined) {
        this.token = {
          access_token: String(data.access_token),
          refresh_token: String(data.refresh_token ?? ""),
          expires_at: Number(data.expires_at ?? 0),
        };
      }
    } catch {
      this.token = null;
    }
    return this.token;
  }

  private saveToken(token: StoredToken): void {
    this.token = token;
    this.tokenLoaded = true;
    try {
      mkdirSync(dirname(this.tokenPath), { recursive: true });
      writeFileSync(this.tokenPath, JSON.stringify(token, null, 2), { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      log.warn("token_save_failed", {
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  clearToken(): void {
    this.token = null;
    this.tokenLoaded = true;
    try {
      unlinkSync(this.tokenPath);
    } catch {
      // файла нет — ок
    }
  }

  /** Перечитать токен с диска (после входа через /login). */
  reloadToken(): void {
    this.token = null;
    this.tokenLoaded = false;
  }

  hasToken(): boolean {
    return Boolean(this.loadToken()?.access_token);
  }

  async getToken(): Promise<string> {
    const cached = this.loadToken();
    if (cached && cached.expires_at > Date.now() / 1000 + 300) {
      return cached.access_token;
    }

    if (cached?.refresh_token) {
      const refreshed = await this.refresh(cached.refresh_token);
      if (refreshed) {
        this.saveToken(refreshed);
        return refreshed.access_token;
      }
    }

    const authorized = await this.authorizeViaBrowser();
    if (authorized) {
      this.saveToken(authorized);
      return authorized.access_token;
    }
    return "";
  }

  private async refresh(refreshToken: string): Promise<StoredToken | null> {
    try {
      const response = await this.fetchImpl(`${HH_BASE}/oauth/token`, {
        method: "POST",
        headers: {
          "User-Agent": this.apiUserAgent,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          refresh_token: refreshToken,
        }),
      });
      if (response.status !== 200) {
        log.warn("oauth_refresh_failed", {
          status: response.status,
          body: (await response.text()).slice(0, 200),
        });
        return null;
      }
      const data = (await response.json()) as Record<string, unknown>;
      return {
        access_token: String(data.access_token),
        refresh_token: String(data.refresh_token ?? refreshToken),
        expires_at: Date.now() / 1000 + Number(data.expires_in ?? 1_209_599),
      };
    } catch (error) {
      log.warn("oauth_refresh_error", {
        error: error instanceof Error ? error.message : error,
      });
      return null;
    }
  }

  /** Получить OAuth-код через реальный браузер и обменять на токен. */
  async authorizeViaBrowser(): Promise<StoredToken | null> {
    if (!this.browser.isAvailable()) {
      log.error("oauth_no_browser", {
        hint: "Установи Chromium: bunx playwright install chromium",
      });
      return null;
    }

    let page: Page | null = null;
    try {
      page = await this.browser.newPage("hh");
      const authorizeUrl =
        `${HH_BASE}/oauth/authorize?response_type=code` +
        `&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=bot`;

      let code: string | null = null;
      const capture = (url: string): void => {
        if (code || !url) return;
        const match = /[?&]code=([^&\s]+)/.exec(url);
        if (match?.[1]) code = decodeURIComponent(match[1]);
      };
      page.on("request", (request) => capture(request.url()));
      page.on("response", (response) => capture(response.url()));
      page.on("framenavigated", (frame) => capture(frame.url()));

      try {
        await page.goto(authorizeUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      } catch {
        // Переход на hhandroid:// закономерно падает — это нормально.
      }
      await page.waitForTimeout(2000);

      const approveSelectors = [
        '[data-qa="oauth-grant-allow"]',
        'button:has-text("Продолжить")',
        'button:has-text("Разрешить")',
        'button:has-text("Подтвердить")',
        'button[data-qa*="oauth-grant"]',
      ];
      for (const selector of approveSelectors) {
        try {
          const button = page.locator(selector).first();
          if ((await button.count()) > 0 && (await button.isVisible())) {
            log.info("oauth_clicking_approve", { selector });
            await button.click({ timeout: 5000 }).catch(() => undefined);
            await page.waitForTimeout(2500);
            break;
          }
        } catch {
          // пробуем следующий селектор
        }
      }

      await page.waitForTimeout(1500);
      await this.browser.saveContext("hh");
      await page.close().catch(() => undefined);
      page = null;

      if (!code) {
        log.error("oauth_no_code");
        return null;
      }
      return await this.exchangeCode(code);
    } catch (error) {
      log.error("oauth_authorize_error", {
        error: error instanceof Error ? error.message : error,
      });
      return null;
    } finally {
      if (page) await page.close().catch(() => undefined);
    }
  }

  private async exchangeCode(code: string): Promise<StoredToken | null> {
    try {
      const response = await this.fetchImpl(`${HH_BASE}/oauth/token`, {
        method: "POST",
        headers: {
          "User-Agent": this.apiUserAgent,
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
        log.error("oauth_token_exchange_failed", {
          status: response.status,
          body: body.slice(0, 200),
        });
        return null;
      }
      const data = JSON.parse(body) as Record<string, unknown>;
      log.info("oauth_authorize_success", { expiresIn: data.expires_in });
      return {
        access_token: String(data.access_token),
        refresh_token: String(data.refresh_token ?? ""),
        expires_at: Date.now() / 1000 + Number(data.expires_in ?? 1_209_599),
      };
    } catch (error) {
      log.error("oauth_exchange_error", {
        error: error instanceof Error ? error.message : error,
      });
      return null;
    }
  }

  // ── HTTP-запросы ───────────────────────────────────────────────────────

  private async rawRequest(
    path: string,
    init: RequestInit,
    options: RequestOptions = {},
  ): Promise<Response> {
    let token = await this.getToken();
    let refreshed = false;

    for (;;) {
      const headers = new Headers(init.headers);
      headers.set("Accept", "application/json");
      const userAgent = options.ua ?? this.apiUserAgent;
      headers.set("User-Agent", userAgent);
      if (!options.ua && /^ru\.hh\.android\//.test(userAgent)) {
        headers.set("X-Force-App-Access", "true");
        headers.set("X-HH-App-Active", "true");
      }
      if (token) headers.set("Authorization", `Bearer ${token}`);
      if (
        (typeof init.body === "string" || init.body instanceof URLSearchParams) &&
        !headers.has("Content-Type")
      ) {
        headers.set("Content-Type", "application/x-www-form-urlencoded");
      }

      const url = path.startsWith("http") ? path : `${HH_API}${path}`;
      const response = await this.fetchImpl(url, { ...init, headers, redirect: "follow" });

      if (response.status === 401 && !refreshed && token) {
        refreshed = true;
        this.clearToken();
        token = await this.getToken();
        if (!token) return response;
        continue;
      }
      return response;
    }
  }

  private async requestWithCaptcha(
    path: string,
    init: RequestInit,
    options: RequestOptions = {},
  ): Promise<Response> {
    const maxAttempts = Math.max(2, this.config.captchaMaxAttempts + 2);
    let lastResponse: Response | null = null;
    let askedInThisRequest = false;
    let skippedRecentSolve = false;
    const browserAvailable =
      typeof this.browser.isAvailable === "function" && this.browser.isAvailable();

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const response = await this.rawRequest(path, init, options);
      lastResponse = response;
      if (response.status !== 403) return response;

      const body = await response.clone().text();
      const captcha: CaptchaErrorInfo | null = extractCaptchaError(body);
      if (!captcha) return response;

      if (!this.config.captchaEnabled) {
        log.warn("captcha_disabled", { url: captcha.url });
        return response;
      }

      // Другой воркер только что решил капчу — не дёргаем пользователя ещё раз,
      // но только если мы сами ещё не просили её в этом запросе.
      if (!askedInThisRequest && !skippedRecentSolve && this.captcha.wasRecentlySolved(60_000)) {
        skippedRecentSolve = true;
        await sleep(1000);
        continue;
      }

      // Если hh не нравится пользовательский UA (например, iPhone Safari),
      // один раз пробуем официальный Android UA без дергания пользователя.
      if (
        !this.uaFallbackUsed &&
        this.config.hhUserAgent &&
        this.apiUserAgent !== this.fallbackUserAgent
      ) {
        log.warn("hh_ua_captcha_fallback", {
          from: this.apiUserAgent,
          to: this.fallbackUserAgent,
        });
        this.apiUserAgent = this.fallbackUserAgent;
        this.uaFallbackUsed = true;
        await sleep(1000);
        continue;
      }

      askedInThisRequest = true;
      log.warn("captcha_required", {
        context: options.context,
        url: captcha.url,
        browser: browserAvailable,
      });

      let solved = false;
      if (browserAvailable && this.browserCaptcha) {
        solved = await this.browserCaptcha.solveCaptchaUrl(
          captcha.url,
          options.context ?? "запрос к hh.ru",
        );
        if (solved && typeof this.captcha.markSolved === "function") {
          this.captcha.markSolved();
        }
      } else {
        const result = await this.captcha.solve(
          captcha.url,
          options.context ?? "запрос к hh.ru",
        );
        solved = result.solved;
        if (!solved) log.warn("captcha_not_solved", { reason: result.reason });
      }

      if (!solved) return response;
      // Даём hh время зафиксировать решение капчи до следующего запроса.
      await sleep(Math.max(1500, this.config.captchaCooldownSec * 1000));
    }

    return lastResponse ?? new Response("", { status: 500 });
  }

  // ── Отклики ────────────────────────────────────────────────────────────

  private resolvedResumeId: string | null = null;

  /** HH_RESUME_ID из .env, а если он пуст — первое резюме из аккаунта. */
  async resolveResumeId(): Promise<string | null> {
    if (this.config.hhResumeId) return this.config.hhResumeId;
    if (this.resolvedResumeId) return this.resolvedResumeId;

    try {
      const response = await this.requestWithCaptcha(
        "/resumes/mine",
        { method: "GET" },
        { context: "получение списка резюме" },
      );
      if (response.status !== 200) return null;
      const data = (await response.json()) as { items?: Array<{ id?: string }> };
      const id = data.items?.find((item) => item.id)?.id ?? null;
      if (id) {
        this.resolvedResumeId = id;
        log.info("resume_id_resolved", { resumeId: id });
      }
      return id;
    } catch (error) {
      log.warn("resume_id_resolve_error", {
        error: error instanceof Error ? error.message : error,
      });
      return null;
    }
  }

  async apply(vacancyId: string | number, message = ""): Promise<ApplyOutcome> {
    const token = await this.getToken();
    if (!token) {
      return { result: false, error: "no_oauth_token" };
    }

    const resumeId = await this.resolveResumeId();
    if (!resumeId) {
      return { result: false, error: "no_resume_id" };
    }

    const body = new URLSearchParams({
      vacancy_id: String(vacancyId),
      resume_id: resumeId,
    });
    if (message) body.set("message", message);

    try {
      const response = await withTimeout(
        this.requestWithCaptcha(
          "/negotiations",
          {
            method: "POST",
            body,
          },
          { context: `отклик на вакансию ${vacancyId}` },
        ),
        this.config.captchaTimeoutSec * Math.max(1, this.config.captchaMaxAttempts) * 1000 + 180_000,
        "hh apply",
      );
      const text = await response.text();
      const outcome = classifyApplyResponse(response.status, text);
      if (outcome.error === "captcha_failed") {
        log.warn("apply_captcha_failed", { vacancyId });
      }
      return outcome;
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      log.error("apply_http_error", { vacancyId, error: messageText });
      return { result: false, error: `http: ${messageText}` };
    }
  }

  // ── Отклики / статусы ──────────────────────────────────────────────────

  async negotiationsStatus(maxPages = 60): Promise<NegotiationStatus[]> {
    const items = await this.listNegotiations("active", maxPages);
    return items.map((item) => {
      const stateId = item.stateId.toLowerCase();
      const tab: NegotiationStatus["tab"] =
        stateId === "invitation" ? "invitations" : stateId === "discard" ? "discard" : "pending";
      return {
        tab,
        title: item.vacancyName,
        company: item.companyName,
        status: item.stateName,
        threadId: item.id ? `hh_${item.id}` : undefined,
        vacancyId: item.vacancyId,
      };
    });
  }

  async listNegotiations(status = "active", maxPages = 60): Promise<NegotiationItem[]> {
    const result: NegotiationItem[] = [];
    const seen = new Set<string>();

    for (let page = 0; page < maxPages; page += 1) {
      try {
        const response = await this.requestWithCaptcha(
          `/negotiations?per_page=100&order_by=created_at&page=${page}&status=${encodeURIComponent(status)}`,
          { method: "GET" },
          { context: "проверка откликов", ua: DESKTOP_UA },
        );
        if (response.status !== 200) {
          log.warn("negotiations_list_failed", {
            status: response.status,
            body: (await response.text()).slice(0, 200),
          });
          break;
        }
        const data = (await response.json()) as {
          items?: RawNegotiation[];
          pages?: number;
        };
        const items = data.items ?? [];
        for (const item of items) {
          const id = String(item.id ?? "");
          if (!id || seen.has(id)) continue;
          seen.add(id);
          result.push({
            id,
            stateId: String(item.state?.id ?? ""),
            stateName: String(item.state?.name ?? ""),
            vacancyId: String(item.vacancy?.id ?? ""),
            vacancyName: String(item.vacancy?.name ?? ""),
            companyName: String(item.vacancy?.employer?.name ?? ""),
            updatedAt: String(item.updated_at ?? ""),
            createdAt: String(item.created_at ?? ""),
          });
        }
        if (page + 1 >= Number(data.pages ?? 0) || items.length === 0) break;
      } catch (error) {
        log.warn("negotiations_list_error", {
          error: error instanceof Error ? error.message : error,
        });
        break;
      }
    }
    return result;
  }

  async getAppliedVacancyIds(): Promise<string[]> {
    const items = await this.listNegotiations("active");
    return [...new Set(items.map((item) => item.vacancyId).filter(Boolean))];
  }

  async deleteNegotiation(id: string, withDeclineMessage: boolean): Promise<boolean> {
    try {
      const response = await this.requestWithCaptcha(
        `/negotiations/active/${encodeURIComponent(id)}?with_decline_message=${withDeclineMessage}`,
        { method: "DELETE" },
        { context: "очистка откликов" },
      );
      if (response.status === 200 || response.status === 204) return true;
      log.warn("negotiation_delete_failed", {
        id,
        status: response.status,
        body: (await response.text()).slice(0, 150),
      });
    } catch (error) {
      log.warn("negotiation_delete_error", {
        id,
        error: error instanceof Error ? error.message : error,
      });
    }
    return false;
  }

  async clearNegotiations(
    olderThanDays: number | null = null,
    dryRun = false,
  ): Promise<{ scanned: number; deleted: number; names: string[]; error?: string }> {
    const items = await this.listNegotiations("active");
    if (items.length === 0 && !this.hasToken()) {
      return { scanned: 0, deleted: 0, names: [], error: "no_oauth_token" };
    }

    const now = Date.now();
    let deleted = 0;
    const names: string[] = [];

    for (const item of items) {
      const isDiscard = item.stateId === "discard";
      if (olderThanDays !== null) {
        const timestamp = Date.parse(item.updatedAt || item.createdAt);
        if (!Number.isFinite(timestamp)) continue;
        if ((now - timestamp) / 86_400_000 <= olderThanDays) continue;
      } else if (!isDiscard) {
        continue;
      }

      if (dryRun) {
        deleted += 1;
        if (names.length < 30) names.push(item.vacancyName || "без названия");
        continue;
      }

      const ok = await this.deleteNegotiation(item.id, !isDiscard);
      if (ok) {
        deleted += 1;
        if (names.length < 30) names.push(item.vacancyName || "без названия");
      }
    }

    return { scanned: items.length, deleted, names };
  }

  // ── Резюме ─────────────────────────────────────────────────────────────

  async bumpResumes(): Promise<{
    bumped: number;
    titles: string[];
    blocked: number;
    error?: string;
  }> {
    const token = await this.getToken();
    if (!token) {
      return { bumped: 0, titles: [], blocked: 0, error: "no_oauth_token" };
    }
    try {
      const response = await this.requestWithCaptcha(
        "/resumes/mine",
        { method: "GET" },
        { context: "поднятие резюме" },
      );
      if (response.status !== 200) {
        return {
          bumped: 0,
          titles: [],
          blocked: 0,
          error: `list_${response.status}`,
        };
      }
      const data = (await response.json()) as {
        items?: Array<{ id?: string; title?: string; can_publish_or_update?: boolean }>;
      };
      let bumped = 0;
      let blocked = 0;
      const titles: string[] = [];

      for (const resume of data.items ?? []) {
        if (!resume.id) continue;
        if (!resume.can_publish_or_update) {
          blocked += 1;
          continue;
        }
        const publish = await this.requestWithCaptcha(
          `/resumes/${resume.id}/publish`,
          { method: "POST" },
          { context: "поднятие резюме" },
        );
        if (publish.status === 200 || publish.status === 204) {
          bumped += 1;
          if (titles.length < 10) titles.push(resume.title ?? "резюме");
        } else {
          log.warn("resume_publish_failed", {
            id: resume.id,
            status: publish.status,
            body: (await publish.text()).slice(0, 150),
          });
        }
      }
      return { bumped, titles, blocked };
    } catch (error) {
      return {
        bumped: 0,
        titles: [],
        blocked: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // ── Проверка сессии ────────────────────────────────────────────────────

  async getMe(): Promise<{ ok: boolean; status: number; name?: string }> {
    try {
      const response = await this.requestWithCaptcha(
        "/me",
        { method: "GET" },
        { context: "проверка сессии", ua: DESKTOP_UA },
      );
      if (response.status !== 200) return { ok: false, status: response.status };
      const data = (await response.json()) as { first_name?: string; last_name?: string };
      return {
        ok: true,
        status: 200,
        name: [data.first_name, data.last_name].filter(Boolean).join(" "),
      };
    } catch {
      return { ok: false, status: 0 };
    }
  }
}

