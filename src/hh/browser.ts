/**
 * Менеджер Playwright-браузера.
 *
 * Нужен для двух вещей: OAuth-авторизация (получить code) и прохождение
 * тестов/анкет, которые hh не даёт отправить через API. Если Chromium не
 * установлен — приложение работает в API-only режиме, капча всё равно
 * решается через HTTP (см. captcha.ts).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import { chromium } from "playwright";

import type { Config } from "../config";
import { Logger } from "../logger";
import { randomInt } from "../utils/async";

const log = new Logger("browser");

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
];

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
  { width: 1536, height: 864 },
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
];

const LAUNCH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--disable-dev-shm-usage",
  "--no-sandbox",
  "--disable-gpu",
  "--disable-software-rasterizer",
  "--disable-extensions",
  "--disable-background-networking",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-features=TranslateUI",
  "--disable-ipc-flooding-protection",
  "--memory-pressure-off",
  "--js-flags=--max-old-space-size=512",
];

const ANTI_DETECT_SCRIPT = `
  Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
  Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3, 4, 5]});
  Object.defineProperty(navigator, 'languages', {get: () => ['ru-RU', 'ru', 'en-US', 'en']});
  window.chrome = {runtime: {}};
`;

function randomUserAgent(): string {
  return USER_AGENTS[randomInt(0, USER_AGENTS.length - 1)] ?? USER_AGENTS[0]!;
}

function randomViewport(): { width: number; height: number } {
  return VIEWPORTS[randomInt(0, VIEWPORTS.length - 1)] ?? VIEWPORTS[0]!;
}

const DEAD_MARKERS = [
  "target page, context or browser has been closed",
  "browser has been closed",
  "browser closed",
  "browser has disconnected",
  "target closed",
  "connection closed",
  "context or browser",
];

function looksDead(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return DEAD_MARKERS.some((marker) => message.includes(marker));
}

export interface IsolatedPageOptions {
  mobile?: boolean;
  headless?: boolean;
  storageStatePath?: string;
}

export class BrowserManager {
  private browser: Browser | null = null;
  private readonly contexts = new Map<string, BrowserContext>();
  private available = false;
  private started = false;

  constructor(private readonly config: Config) {}

  isAvailable(): boolean {
    return this.available;
  }

  async start(): Promise<boolean> {
    if (this.started) return this.available;
    this.started = true;
    try {
      await this.ensureBrowser();
      this.available = true;
      log.info("browser_started", { headless: this.config.browserHeadless });
    } catch (error) {
      this.available = false;
      log.warn("browser_start_failed", {
        error: error instanceof Error ? error.message : error,
        hint: "bunx playwright install chromium",
      });
    }
    return this.available;
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (this.contexts.size > 0) {
      log.warn("browser_dead_dropping_contexts", { count: this.contexts.size });
      this.contexts.clear();
    }

    const launchOptions = {
      headless: this.config.browserHeadless,
      args: LAUNCH_ARGS,
      // Playwright по умолчанию сам перехватывает SIGINT и выходит.
      // Нам нужен контролируемый shutdown (закрыть БД, сохранить сессию).
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    };

    try {
      this.browser = await chromium.launch(
        this.config.browserChannel
          ? { ...launchOptions, channel: this.config.browserChannel }
          : launchOptions,
      );
    } catch (error) {
      if (this.config.browserChannel) {
        log.warn("browser_channel_failed", {
          channel: this.config.browserChannel,
          error: error instanceof Error ? error.message : error,
        });
        this.browser = await chromium.launch(launchOptions);
      } else {
        throw error;
      }
    }
    log.info("browser_launched", { headless: this.config.browserHeadless });
    return this.browser;
  }

  private storagePath(platform: string): string {
    return this.config.hhStatePath.replace(/hh_state\.json$/, `${platform}_state.json`);
  }

  private async buildContext(platform: string): Promise<BrowserContext> {
    const browser = await this.ensureBrowser();
    const storagePath = this.storagePath(platform);
    const contextOptions: Parameters<Browser["newContext"]>[0] = {
      userAgent: randomUserAgent(),
      viewport: randomViewport(),
      locale: "ru-RU",
      timezoneId: "Europe/Moscow",
    };
    if (this.config.proxyUrl) {
      contextOptions.proxy = { server: this.config.proxyUrl };
    }
    if (existsSync(storagePath)) {
      contextOptions.storageState = storagePath;
    }

    const context = await browser.newContext(contextOptions);
    await context.addInitScript(ANTI_DETECT_SCRIPT);
    this.contexts.set(platform, context);
    log.info("browser_context_created", { platform, storagePath });
    return context;
  }

  async getContext(platform: string): Promise<BrowserContext> {
    await this.ensureBrowser();
    const existing = this.contexts.get(platform);
    if (existing) return existing;
    return this.buildContext(platform);
  }

  async newPage(platform: string): Promise<Page> {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const context = await this.getContext(platform);
        return await context.newPage();
      } catch (error) {
        if (attempt === 2 || !looksDead(error)) throw error;
        log.warn("browser_new_page_recover", {
          error: error instanceof Error ? error.message.slice(0, 160) : error,
        });
        this.contexts.delete(platform);
        if (this.browser) await this.browser.close().catch(() => undefined);
        this.browser = null;
      }
    }
    throw new Error("newPage: unreachable");
  }

  /** Отдельный контекст для OTP-логина (мобильная эмуляция, без cookies). */
  async newIsolatedPage(options: IsolatedPageOptions = {}): Promise<{
    context: BrowserContext;
    page: Page;
  }> {
    const browser = await this.ensureBrowser();
    const contextOptions: Parameters<Browser["newContext"]>[0] = {
      userAgent: options.mobile
        ? "Mozilla/5.0 (Linux; Android 13; SM-A556B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36"
        : randomUserAgent(),
      viewport: options.mobile ? { width: 412, height: 915 } : randomViewport(),
      locale: "ru-RU",
      timezoneId: "Europe/Moscow",
      isMobile: options.mobile ?? false,
      hasTouch: options.mobile ?? false,
    };
    if (this.config.proxyUrl) contextOptions.proxy = { server: this.config.proxyUrl };
    if (options.storageStatePath && existsSync(options.storageStatePath)) {
      contextOptions.storageState = options.storageStatePath;
    }
    const context = await browser.newContext(contextOptions);
    await context.addInitScript(ANTI_DETECT_SCRIPT);
    const page = await context.newPage();
    return { context, page };
  }

  async saveContext(platform: string): Promise<void> {
    const context = this.contexts.get(platform);
    if (!context) return;
    try {
      const state = await context.storageState();
      const path = this.storagePath(platform);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
      log.info("browser_state_saved", { platform, path });
    } catch (error) {
      if (looksDead(error)) {
        log.warn("browser_state_save_skip_dead", { platform });
      } else {
        log.warn("browser_state_save_error", {
          platform,
          error: error instanceof Error ? error.message : error,
        });
      }
    }
  }

  /** Прочитать сохранённые cookies (для проверки, что сессия вообще есть). */
  hasSavedState(platform = "hh"): boolean {
    const path = this.storagePath(platform);
    if (!existsSync(path)) return false;
    try {
      const data = JSON.parse(readFileSync(path, "utf8")) as { cookies?: unknown[] };
      return Array.isArray(data.cookies) && data.cookies.length > 0;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    for (const platform of [...this.contexts.keys()]) {
      await this.saveContext(platform);
      try {
        await this.contexts.get(platform)?.close();
      } catch {
        // ignore
      }
    }
    this.contexts.clear();
    if (this.browser) {
      await this.browser.close().catch(() => undefined);
      this.browser = null;
    }
    this.available = false;
    log.info("browser_closed");
  }
}
