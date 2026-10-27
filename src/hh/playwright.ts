/**
 * Playwright-сценарии hh.ru:
 *  - вход по сохранённой сессии/паролю (+ капча через Telegram);
 *  - отклик на вакансию с анкетой/тестом (fallback, когда API вернул needs_test);
 *  - благодарность за отказ (экспериментально).
 *
 * Основной путь отклика — OAuth API, этот модуль нужен только для того,
 * что API не умеет: анкеты, тесты и чат.
 */
import { mkdirSync } from "node:fs";
import type { Locator, Page } from "playwright";

import type { Config } from "../config";
import { Logger } from "../logger";
import type { ApplyResult } from "../models";
import type { Notifier } from "../notifier";
import { randomDelay, sleep } from "../utils/async";
import { escapeHtml } from "../utils/text";
import type { BrowserManager } from "./browser";
import { CAPTCHA_SUCCESS_BACKURL, HH_BASE, HH_NEGOTIATIONS } from "./constants";
import { isHHCaptchaPage } from "./captcha";

const log = new Logger("hh:playwright");

const HIDDEN_PATTERNS = [
  "вам недоступна эта вакансия",
  "вакансия скрыта",
  "вакансия не найдена",
  "vacancy not found",
  "эта вакансия недоступна",
  "вакансия недоступна",
  "вакансия закрыта",
  "вакансия снята с публикации",
  "скрыта от вас",
  "скрыта работодателем",
  "вакансия не активна",
  "вакансия не опубликована",
  "данная вакансия недоступна",
];

const APPLY_SELECTORS = [
  '[data-qa="vacancy-response-link-top"]',
  '[data-qa="vacancy-response-link-bottom"]',
  'a[data-qa*="vacancy-response-link"]',
  'button[data-qa*="vacancy-response"]',
  'a[href*="/applicant/vacancy_response"]',
];

const SUBMIT_SELECTORS = [
  '[data-qa="vacancy-response-submit-popup"]',
  '[data-qa="vacancy-response-letter-submit"]',
  'button[data-qa*="response-submit"]',
  '.vacancy-response-popup-actions button[type="submit"]',
  'button:has-text("Откликнуться")',
];

const CONFIRM_TEXTS = [
  "все равно откликнуться",
  "всё равно откликнуться",
  "все равно",
  "всё равно",
  "согласиться",
  "согласен",
  "соглашаюсь",
  "продолжить",
  "подтвердить",
  "ok",
  "ок",
];

function isCaptchaUrl(url: string): boolean {
  return /\/account\/captcha/i.test(url);
}

export interface PlaywrightDeps {
  config: Config;
  browser: BrowserManager;
  notifier: Notifier;
}

export class HHPlaywright {
  private readonly config: Config;
  private readonly browser: BrowserManager;
  private readonly notifier: Notifier;
  private page: Page | null = null;
  private loggedIn = false;

  constructor(deps: PlaywrightDeps) {
    this.config = deps.config;
    this.browser = deps.browser;
    this.notifier = deps.notifier;
  }

  isAvailable(): boolean {
    return this.browser.isAvailable();
  }

  private async getPage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    this.page = await this.browser.newPage("hh");
    return this.page;
  }

  // ── Вход ───────────────────────────────────────────────────────────────

  async login(): Promise<boolean> {
    if (this.loggedIn) return true;
    if (!this.browser.isAvailable()) return false;

    const page = await this.getPage();
    try {
      await page.goto(HH_BASE, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForTimeout(2500);
      if (await this.isLoggedInPage(page)) {
        this.loggedIn = true;
        await this.browser.saveContext("hh");
        log.info("hh_already_logged_in");
        return true;
      }
      await this.safeScreenshot(page, "login_check");
      log.warn("hh_session_expired", { url: page.url() });
    } catch (error) {
      log.warn("hh_login_check_error", {
        error: error instanceof Error ? error.message : error,
      });
    }

    if (!this.config.hhLogin || !this.config.hhPassword) {
      log.error("hh_credentials_missing");
      return false;
    }

    try {
      await page.goto(`${HH_BASE}/account/login`, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      await page.waitForTimeout(1500);
      if (await this.solvePageCaptcha(page, "вход на hh.ru")) {
        await page.waitForTimeout(1000);
      }

      const passwordToggle = page.locator('[data-qa="expand-login-by-password"]').first();
      if ((await passwordToggle.count()) > 0) {
        await passwordToggle.click({ timeout: 5000 }).catch(() => undefined);
        await page.waitForTimeout(800);
      }

      const loginInput = page
        .locator('[data-qa="login-input-username"], input[name="login"]')
        .first();
      if ((await loginInput.count()) === 0) {
        await this.safeScreenshot(page, "login_failed");
        return false;
      }
      await loginInput.fill(this.config.hhLogin);

      const passwordInput = page
        .locator('[data-qa="login-input-password"], input[type="password"]')
        .first();
      if ((await passwordInput.count()) === 0) return false;
      await passwordInput.fill(this.config.hhPassword);

      const submit = page
        .locator('[data-qa="account-login-submit"], button[type="submit"]')
        .first();
      if ((await submit.count()) > 0) await submit.click();
      else await page.keyboard.press("Enter");

      await page.waitForTimeout(4500);
      if (isCaptchaUrl(page.url()) || (await this.hasCaptchaWidget(page))) {
        await this.solvePageCaptcha(page, "вход на hh.ru");
      }

      if (await this.isLoggedInPage(page)) {
        this.loggedIn = true;
        await this.browser.saveContext("hh");
        log.info("hh_login_success");
        return true;
      }

      await this.safeScreenshot(page, "login_failed");
      const errorText = await page
        .locator('[data-qa="account-login-error"]')
        .first()
        .innerText()
        .catch(() => "");
      log.error("hh_login_failed", {
        reason: errorText || "unknown, возможно капча",
      });
      return false;
    } catch (error) {
      log.error("hh_login_error", {
        error: error instanceof Error ? error.message : error,
      });
      return false;
    }
  }

  private async isLoggedInPage(page: Page): Promise<boolean> {
    for (const selector of [
      '[data-qa="mainmenu_applicantProfile"]',
      '[data-qa="mainmenu_myResumes"]',
      'a[href*="/applicant/resumes"]',
    ]) {
      if ((await page.locator(selector).count()) > 0) return true;
    }
    return false;
  }

  // ── Капча в браузере ───────────────────────────────────────────────────

  private async hasCaptchaWidget(page: Page): Promise<boolean> {
    if ((await page.locator('img[data-qa="account-captcha-picture"]').count()) > 0) return true;
    try {
      const html = await page.content();
      return isHHCaptchaPage(page.url(), html);
    } catch {
      return false;
    }
  }

  /**
   * Решить капчу в настоящем Chromium. Это надёжнее HTTP-решения: TLS и
   * куки браузера совпадают с обычным пользователем, поэтому hh засчитывает
   * ответ, а не просит капчу на каждый следующий отклик.
   */
  async solveCaptchaUrl(captchaUrl: string, context: string): Promise<boolean> {
    if (!this.config.captchaEnabled || !this.browser.isAvailable()) return false;

    const page = await this.browser.newPage("hh");
    try {
      const url = new URL(captchaUrl);
      url.searchParams.set("backurl", CAPTCHA_SUCCESS_BACKURL);
      await page.goto(url.toString(), {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      await page.waitForTimeout(1500);

      if (/\/account\/login/.test(page.url())) {
        log.warn("browser_captcha_login_required", { url: page.url() });
        return false;
      }

      let passed = false;
      const checkSuccess = (url: string): void => {
        if (url.startsWith(CAPTCHA_SUCCESS_BACKURL)) passed = true;
      };
      page.on("request", (request) => checkSuccess(request.url()));
      page.on("response", (response) => checkSuccess(response.url()));

      const solved = await this.solvePageCaptcha(page, context, () => passed);
      if (solved) {
        await this.browser.saveContext("hh");
        log.info("browser_captcha_solved", { context });
      }
      return solved;
    } catch (error) {
      log.warn("browser_captcha_error", {
        error: error instanceof Error ? error.message : error,
      });
      return false;
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  private async solvePageCaptcha(
    page: Page,
    context: string,
    isSuccess?: () => boolean,
  ): Promise<boolean> {
    if (!this.config.captchaEnabled) return false;

    for (let attempt = 1; attempt <= this.config.captchaMaxAttempts; attempt += 1) {
      if (!(await this.hasCaptchaWidget(page))) return true;

      let image: Uint8Array;
      try {
        const picture = page.locator('img[data-qa="account-captcha-picture"]').first();
        const buffer =
          (await picture.count()) > 0
            ? await picture.screenshot()
            : await page.screenshot({ fullPage: false });
        image = new Uint8Array(buffer);
      } catch (error) {
        log.warn("page_captcha_screenshot_failed", {
          error: error instanceof Error ? error.message : error,
        });
        return false;
      }

      const answer = await this.notifier.askCaptcha(
        {
          image,
          url: page.url(),
          caption:
            "🔐 <b>hh.ru просит капчу</b>\n\n" +
            `Контекст: ${escapeHtml(context)}\n` +
            `Попытка ${attempt}/${this.config.captchaMaxAttempts}.\n\n` +
            "Введи текст с картинки <b>одним сообщением</b>.\n" +
            "Отмена: /cancel_captcha",
        },
        this.config.captchaTimeoutSec * 1000,
      );
      if (!answer) return false;

      try {
        const input = page
          .locator(
            '[data-qa="account-captcha-input"], input[name="captchaText"], input[type="text"]',
          )
          .first();
        if ((await input.count()) === 0) return false;
        await input.fill(answer);
        const submit = page
          .locator(
            '[data-qa="account-captcha-submit"], button:has-text("Отправить"), button:has-text("Продолжить"), button[type="submit"]',
          )
          .first();
        if (this.config.captchaSubmitDelaySec > 0) {
          await sleep(this.config.captchaSubmitDelaySec * 1000);
        }
        if ((await submit.count()) > 0) await submit.click();
        else await page.keyboard.press("Enter");
        await page.waitForTimeout(3000);
      } catch (error) {
        log.warn("page_captcha_submit_error", {
          error: error instanceof Error ? error.message : error,
        });
      }

      if (isSuccess?.()) {
        log.info("page_captcha_solved", { context, via: "redirect" });
        return true;
      }

      let pageText = "";
      try {
        pageText = (
          await page.evaluate(() => (document.body?.innerText ?? "").toLowerCase())
        ) as string;
      } catch {
        // Страница могла уйти на hh:// после верного ответа.
        if (page.isClosed()) return true;
        return !(await this.hasCaptchaWidget(page));
      }
      if (/неверный\s+текст|попробуйте\s+(ещ[её]|снова)/i.test(pageText)) {
        log.warn("page_captcha_wrong", { context, attempt });
        continue;
      }

      if (!(await this.hasCaptchaWidget(page))) {
        log.info("page_captcha_solved", { context });
        return true;
      }
    }

    log.warn("page_captcha_not_solved", { context });
    return false;
  }

  // ── Отклик ─────────────────────────────────────────────────────────────

  async applyToVacancy(
    vacancyUrl: string,
    coverLetter: string,
    options: { screenshotName?: string; vacancyTitle?: string; vacancyDescription?: string } = {},
  ): Promise<ApplyResult> {
    if (!this.browser.isAvailable()) {
      log.warn("hh_apply_no_browser", { url: vacancyUrl });
      return false;
    }
    if (!this.loggedIn && !(await this.login())) return false;

    let page = await this.getPage();
    try {
      try {
        await page.goto(vacancyUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
      } catch (error) {
        if (!this.isDeadPageError(error)) throw error;
        log.warn("hh_apply_page_recover");
        await page.close().catch(() => undefined);
        this.page = null;
        page = await this.getPage();
        await page.goto(vacancyUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
      }
      await page.waitForTimeout(2200);

      if (isCaptchaUrl(page.url()) || (await this.hasCaptchaWidget(page))) {
        const solved = await this.solvePageCaptcha(page, `отклик на ${vacancyUrl}`);
        if (!solved) return false;
        await page.waitForTimeout(1000);
      }

      const pageText = (
        await page.evaluate(() => (document.body?.innerText ?? "").slice(0, 5000).toLowerCase())
      ) as string;
      if (HIDDEN_PATTERNS.some((pattern) => pageText.includes(pattern))) {
        log.info("hh_vacancy_unavailable", { url: vacancyUrl });
        return "already";
      }
      if (/\/account\/login/.test(page.url())) {
        log.warn("hh_session_lost_on_vacancy", { url: vacancyUrl });
        this.loggedIn = false;
        return false;
      }

      if (!/\/applicant\/vacancy_response/.test(page.url())) {
        const clicked = await this.clickApply(page);
        if (!clicked) {
          if (await this.looksAlreadyApplied(page)) {
            log.info("hh_already_applied", { url: vacancyUrl });
            return "already";
          }
          await this.safeScreenshot(page, "apply_no_btn");
          log.warn("hh_apply_btn_not_found", { url: vacancyUrl, pageUrl: page.url() });
          return false;
        }
        await page.waitForTimeout(2200);
        await this.confirmModals(page);
      }

      await this.fillResponseForm(page, coverLetter, {
        title: options.vacancyTitle ?? "",
        url: vacancyUrl,
        description: options.vacancyDescription,
      });

      const submit = await this.findFirst(page, SUBMIT_SELECTORS);
      if (!submit) {
        await this.safeScreenshot(page, "apply_no_submit");
        log.warn("hh_apply_no_submit", { url: vacancyUrl });
        return false;
      }

      if (options.screenshotName) {
        await page
          .screenshot({ path: `data/test_apply_${options.screenshotName}_before.png` })
          .catch(() => undefined);
      }

      await submit.click();
      await page.waitForTimeout(1600);
      await this.confirmModals(page);

      if (await this.waitForApplySuccess(page)) {
        if (options.screenshotName) {
          await page
            .screenshot({ path: `data/test_apply_${options.screenshotName}_after.png` })
            .catch(() => undefined);
        }
        await this.browser.saveContext("hh");
        log.info("hh_apply_success", { url: vacancyUrl, final: page.url() });
        return true;
      }

      const errors = await page.evaluate(() => {
        const nodes = document.querySelectorAll('[class*="error"], [data-qa*="error"]');
        return Array.from(nodes)
          .slice(0, 5)
          .map((node) => (node.textContent ?? "").trim())
          .filter(Boolean);
      });
      if (Array.isArray(errors) && errors.length > 0) {
        log.warn("hh_apply_validation_errors", { errors: errors.slice(0, 3) });
      }

      await this.safeScreenshot(page, "apply_fail");
      if (options.screenshotName) {
        await page
          .screenshot({ path: `data/test_apply_${options.screenshotName}_after.png` })
          .catch(() => undefined);
      }
      log.warn("hh_apply_uncertain", { url: vacancyUrl, pageUrl: page.url() });
      return false;
    } catch (error) {
      await this.safeScreenshot(page, "apply_error").catch(() => undefined);
      log.error("hh_apply_error", {
        url: vacancyUrl,
        error: error instanceof Error ? error.message : error,
      });
      return false;
    }
  }

  private async clickApply(page: Page): Promise<boolean> {
    for (const selector of APPLY_SELECTORS) {
      const button = page.locator(selector).first();
      if ((await button.count()) > 0 && (await button.isVisible().catch(() => false))) {
        await button.click({ timeout: 8000 }).catch(() => undefined);
        return true;
      }
    }
    return (await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll("a, button"));
      const element = elements.find((node) => {
        const text = (node.textContent ?? "").trim().toLowerCase();
        return text === "откликнуться" && (node as HTMLElement).offsetParent !== null;
      }) as HTMLElement | undefined;
      if (!element) return false;
      element.click();
      return true;
    })) as boolean;
  }

  private async looksAlreadyApplied(page: Page): Promise<boolean> {
    for (const selector of [
      '[data-qa="vacancy-response-link-view-topic"]',
      'a[href*="/applicant/negotiations/topic"]',
    ]) {
      if ((await page.locator(selector).count()) > 0) return true;
    }
    return (await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll("a, button"));
      return elements.some((element) => {
        const text = (element.textContent ?? "").trim().toLowerCase();
        return text.includes("перейти к переписке") || text.includes("вы уже откликались");
      });
    })) as boolean;
  }

  private async confirmModals(page: Page): Promise<void> {
    try {
      const clicked = await page.evaluate((texts) => {
        const wanted = new Set(texts);
        const buttons = document.querySelectorAll(
          'button, a[role="button"], [role="button"]',
        );
        for (const button of Array.from(buttons)) {
          const text = (button.textContent ?? "").trim().toLowerCase();
          if (wanted.has(text)) {
            (button as HTMLElement).click();
            return true;
          }
        }
        return false;
      }, CONFIRM_TEXTS);
      if (clicked) {
        log.info("hh_confirm_modal_clicked");
        await page.waitForTimeout(2000);
      }
    } catch {
      // модалки может не быть
    }
  }

  private async waitForApplySuccess(page: Page): Promise<boolean> {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await page.waitForTimeout(1000);
      if (/\/applicant\/negotiations|vacancy_response_success/.test(page.url())) return true;
      if ((await page.locator('[data-qa="vacancy-response-link-view-topic"]').count()) > 0) {
        return true;
      }
      if (
        (await page.locator('[data-qa*="response-success"], [class*="response-success"]').count()) >
        0
      ) {
        return true;
      }
      try {
        const text = (
          await page.evaluate(() => (document.body?.innerText ?? "").slice(0, 2000).toLowerCase())
        ) as string;
        if (text.includes("отклик отправлен") || text.includes("вы откликнулись")) return true;
      } catch {
        // ignore
      }
    }
    return false;
  }

  // ── Анкета / сопроводительное ──────────────────────────────────────────

  private async fillResponseForm(
    page: Page,
    coverLetter: string,
    vacancy: { title: string; url: string; description?: string },
  ): Promise<void> {
    await this.fillQuestionnaire(page, vacancy);

    // Ссылка «Добавить сопроводительное».
    for (const selector of [
      '[data-qa="vacancy-response-letter-toggle"]',
      'button:has-text("Добавить сопроводительное")',
      'a:has-text("Добавить сопроводительное")',
    ]) {
      const toggle = page.locator(selector).first();
      if ((await toggle.count()) > 0 && (await toggle.isVisible().catch(() => false))) {
        await toggle.click().catch(() => undefined);
        await page.waitForTimeout(700);
        break;
      }
    }

    if (coverLetter) {
      const letter = await this.findLetterArea(page);
      if (letter) {
        await letter.fill(coverLetter).catch(() => undefined);
        await page.waitForTimeout(400);
      } else {
        log.warn("hh_letter_area_not_found");
      }
    }

    // Выбор резюме, если их несколько.
    const resumeDropdown = page
      .locator('[data-qa="vacancy-response-popup-form-resume-dropdown"]')
      .first();
    if ((await resumeDropdown.count()) > 0) {
      await resumeDropdown.click().catch(() => undefined);
      await page.waitForTimeout(500);
      const option = page
        .locator('[data-qa="vacancy-response-popup-form-resume-option"]')
        .first();
      if ((await option.count()) > 0) await option.click().catch(() => undefined);
    }
  }

  private async findLetterArea(page: Page) {
    for (const selector of [
      '[data-qa="vacancy-response-popup-form-letter-input"]',
      '[data-qa="cover-letter-input"]',
      'textarea[name="text"]',
      'textarea[name="letter"]',
      'textarea[placeholder*="опроводительн"]',
      'textarea[placeholder*="приветствие"]',
      'textarea[placeholder*="расскажи"]',
    ]) {
      const area = page.locator(selector).first();
      if ((await area.count()) > 0 && (await area.isVisible().catch(() => false))) return area;
    }
    return null;
  }

  private async fillQuestionnaire(
    page: Page,
    vacancy: { title: string; url: string; description?: string },
  ): Promise<void> {
    await this.fillRadioQuestions(page, vacancy);

    const textareas = await page.locator("textarea").all();
    const questionAreas: Array<{ locator: (typeof textareas)[number]; question: string }> = [];
    for (const area of textareas) {
      if (!(await area.isVisible().catch(() => false))) continue;
      const dataQa = (await area.getAttribute("data-qa")) ?? "";
      const name = (await area.getAttribute("name")) ?? "";
      const placeholder = (await area.getAttribute("placeholder")) ?? "";
      if (
        dataQa.toLowerCase().includes("letter") ||
        name === "text" ||
        /опровод/i.test(placeholder)
      ) {
        continue;
      }
      const question = (await area.evaluate((element) => {
        let current: Element | null = element;
        for (let index = 0; index < 6; index += 1) {
          current = current?.parentElement ?? null;
          if (!current) break;
          const nodes = current.querySelectorAll("label, p, div, span, h1, h2, h3, h4");
          for (const node of Array.from(nodes)) {
            if (node.contains(element)) continue;
            const text = (node.textContent ?? "").trim();
            if (text && text.length > 5 && text.length < 500 && !text.includes("Писать тут")) {
              return text;
            }
          }
        }
        return "";
      })) as string;
      if (question) questionAreas.push({ locator: area, question });
    }

    log.info("hh_questions_collected", { count: questionAreas.length });
    if (questionAreas.length === 0) return;

    // Без LLM: на вопросы анкеты отвечаем нейтрально, но честно.
    for (let index = 0; index < questionAreas.length; index += 1) {
      const item = questionAreas[index]!;
      const answer = "Готов обсудить детали на собеседовании.";
      let filled = false;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const area = attempt === 1 ? item.locator : (await this.refindQuestionArea(page, index));
        if (!area) break;
        try {
          await area.fill(answer);
          filled = true;
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message.toLowerCase() : "";
          if (attempt === 1 && /not attached|detached|no node/.test(message)) {
            await page.waitForTimeout(600);
            continue;
          }
          break;
        }
      }
      if (filled) {
        log.info("hh_question_answered", {
          index: index + 1,
          chars: answer.length,
          question: item.question.slice(0, 60),
        });
      }
    }
  }

  private async refindQuestionArea(page: Page, targetIndex: number): Promise<Locator | null> {
    const fresh: Locator[] = [];
    for (const area of await page.locator("textarea").all()) {
      if (!(await area.isVisible().catch(() => false))) continue;
      const dataQa = (await area.getAttribute("data-qa")) ?? "";
      const name = (await area.getAttribute("name")) ?? "";
      const placeholder = (await area.getAttribute("placeholder")) ?? "";
      if (
        dataQa.toLowerCase().includes("letter") ||
        name === "text" ||
        /опровод/i.test(placeholder)
      ) {
        continue;
      }
      fresh.push(area);
    }
    return fresh[targetIndex] ?? null;
  }

  private async fillRadioQuestions(
    page: Page,
    vacancy: { title: string; url: string; description?: string },
  ): Promise<void> {
    let groups: Record<
      string,
      { question: string; options: Array<{ value: string; label: string; id: string }> }
    >;
    try {
      groups = (await page.evaluate(() => {
        const result: Record<
          string,
          { question: string; options: Array<{ value: string; label: string; id: string }> }
        > = {};
        const radios = document.querySelectorAll('input[type="radio"]');
        for (const radio of Array.from(radios)) {
          const element = radio as HTMLInputElement;
          if (element.offsetParent === null) continue;
          const name = element.name || element.getAttribute("data-qa") || "unknown";
          result[name] ??= { question: "", options: [] };
          let label = "";
          if (element.id) {
            const labelElement = document.querySelector(`label[for="${element.id}"]`);
            if (labelElement) label = (labelElement.textContent ?? "").trim();
          }
          if (!label && element.parentElement) {
            label = (element.parentElement.textContent ?? "").trim();
          }
          result[name]!.options.push({ value: element.value, label, id: element.id });
        }
        for (const name of Object.keys(result)) {
          const first = document.querySelector(`input[type="radio"][name="${name}"]`);
          if (!first) continue;
          let current: HTMLElement | null = first as HTMLElement;
          for (let index = 0; index < 8; index += 1) {
            current = current?.parentElement ?? null;
            if (!current) break;
            const text = (current.textContent ?? "").split("\n")[0]?.trim() ?? "";
            if (text.length > 5 && text.length < 200 && text.trim().endsWith("?")) {
              result[name]!.question = text;
              break;
            }
          }
        }
        return result;
      })) as typeof groups;
    } catch {
      return;
    }

    for (const [name, group] of Object.entries(groups)) {
      if (group.options.length === 0) continue;
      let chosen = -1;
      const labels = group.options.map((option) => option.label.toLowerCase());
      chosen = labels.findIndex(
        (label) => label.includes("все") && (label.includes("вариант") || label.includes("подход")),
      );
      if (chosen < 0) chosen = labels.findIndex((label) => /удал|remote/.test(label));
      if (chosen < 0) chosen = labels.findIndex((label) => /^да\b|готов/.test(label));
      if (chosen < 0) chosen = 0;

      const option = group.options[chosen]!;
      const selector = option.id
        ? `input[type="radio"]#${option.id}`
        : `input[type="radio"][name="${name}"][value="${option.value}"]`;
      await page.check(selector).catch(() => undefined);
      await page.waitForTimeout(250);
      log.info("hh_radio_chosen", {
        question: (group.question || name).slice(0, 60),
        pick: option.label.slice(0, 40),
      });
    }
  }

  // ── Благодарность за отказ ─────────────────────────────────────────────

  async sendThanksForRejections(maxCount = 3): Promise<number> {
    if (!this.browser.isAvailable() || !(await this.login())) return 0;
    const page = await this.getPage();
    let sent = 0;

    try {
      for (let index = 0; index < maxCount; index += 1) {
        await page.goto(HH_NEGOTIATIONS, { waitUntil: "domcontentloaded", timeout: 45_000 });
        await page.waitForTimeout(3000);
        const clicked = (await page.evaluate(() => {
          const items = Array.from(
            document.querySelectorAll('[data-qa="negotiations-item"], .negotiations-list-item'),
          );
          const target = items.find((item) => {
            const text = (item.textContent ?? "").toLowerCase();
            if (!/отказ|не подош|отклонил/.test(text)) return false;
            if ((item as HTMLElement).dataset.thanksSent === "1") return false;
            return true;
          }) as HTMLElement | undefined;
          if (!target) return false;
          target.dataset.thanksSent = "1";
          target.click();
          return true;
        })) as boolean;
        if (!clicked) break;

        await page.waitForTimeout(3500);
        const input = page
          .locator(
            '[data-qa="chatik-new-message-text"], textarea[placeholder*="Сообщение"], textarea[name="message"], div[contenteditable="true"]',
          )
          .first();
        if ((await input.count()) === 0) break;
        await input
          .fill("Спасибо за обратную связь! Желаю успехов в подборе кандидата.")
          .catch(() => undefined);
        await page.waitForTimeout(700);
        const send = page
          .locator('[data-qa="chatik-do-send-message"], button:has-text("Отправить"), button[type="submit"]')
          .first();
        if ((await send.count()) === 0) break;
        await send.click().catch(() => undefined);
        await page.waitForTimeout(2000);
        sent += 1;
        await randomDelay(8, 12);
      }
      if (sent > 0) await this.browser.saveContext("hh");
    } catch (error) {
      log.warn("hh_thanks_error", {
        error: error instanceof Error ? error.message : error,
      });
    }
    return sent;
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private async findFirst(page: Page, selectors: string[]) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if ((await locator.count()) > 0 && (await locator.isVisible().catch(() => false))) {
        return locator;
      }
    }
    return null;
  }

  private isDeadPageError(error: unknown): boolean {
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
    return /target page|frame was detached|err_aborted|target closed|browser has been closed/.test(
      message,
    );
  }

  private async safeScreenshot(page: Page, name: string): Promise<void> {
    try {
      mkdirSync("data", { recursive: true });
      await page.screenshot({ path: `data/debug_${name}.png`, fullPage: false });
    } catch {
      // ignore
    }
  }

  async close(): Promise<void> {
    if (this.page && !this.page.isClosed()) {
      await this.browser.saveContext("hh");
      await this.page.close().catch(() => undefined);
      this.page = null;
    }
    this.loggedIn = false;
  }
}
