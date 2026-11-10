/** Точка входа приложения. */
import { createBot, startBot } from "./bot/bot";
import { loadConfig, validateForBot, describeConfig } from "./config";
import type { AppContext } from "./context";
import { Store } from "./db";
import { BrowserManager } from "./hh/browser";
import { HHCaptchaSolver } from "./hh/captcha";
import { HHOAuthClient } from "./hh/oauth";
import { HHPlaywright } from "./hh/playwright";
import { dropAllLoginSessions } from "./hh/login";
import { HHParser } from "./hh/search";
import { log, setLogLevel } from "./logger";
import { notifier } from "./notifier";
import { WorkerScheduler } from "./scheduler";
import { SchedulerState } from "./state";
import { startDashboardServer } from "./server";

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  const errors = validateForBot(config);
  const botConfigured = errors.length === 0;

  if (!botConfigured) {
    console.warn("⚠️ Не хватает настроек для Telegram-бота:\n" + errors.map((error) => `  • ${error}`).join("\n"));
    console.warn("Скопируй .env.example в .env и заполни TG_BOT_TOKEN и TG_ADMIN_CHAT_ID.");
    console.warn("Панель управления hh-auto запускается на порту 3000...");
  }

  log.info("starting_hh_autoresponder", {
    dryRun: config.dryRun,
    captcha: config.captchaEnabled,
    botConfigured,
  });

  const db = new Store(config.databasePath);
  const state = new SchedulerState(config.schedulerStatePath);
  const browser = new BrowserManager(config);
  const browserOk = await browser.start();

  const captcha = new HHCaptchaSolver({
    ask: (prompt) => notifier.askCaptcha(prompt, config.captchaTimeoutSec * 1000),
    cookiePath: config.captchaCookiePath,
    lang: config.captchaLang,
    submitDelayMs: config.captchaSubmitDelaySec * 1000,
    maxAttempts: config.captchaMaxAttempts,
    cooldownMs: config.captchaCooldownSec * 1000,
    proxyUrl: config.proxyUrl || undefined,
  });

  const playwright = new HHPlaywright({ config, browser, notifier });
  const oauth = new HHOAuthClient({
    config,
    captcha,
    browser,
    browserCaptcha: playwright,
  });
  const parser = new HHParser({ config, captcha, browserCaptcha: playwright });

  const ctx: AppContext = {
    config,
    db,
    oauth,
    parser,
    captcha,
    browser,
    playwright,
    state,
    notifier,
  };

  const scheduler = new WorkerScheduler(ctx);

  // Запуск веб-сервера панели управления на порту 3000
  const server = startDashboardServer({
    ctx,
    scheduler,
    botConfigured,
  });

  let shuttingDown = false;
  let resolveShutdown!: () => void;
  const shutdownDone = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });

  let bot: ReturnType<typeof createBot> | undefined;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return shutdownDone;
    shuttingDown = true;
    log.info("shutting_down", { signal });
    const keepAlive = setInterval(() => undefined, 1000);
    try {
      server.close();
      await scheduler.stop().catch(() => undefined);
      log.info("shutdown_step", { step: "bot" });
      if (bot) {
        const botStop = bot.stop().catch(() => undefined);
        await Promise.race([
          botStop,
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 2000);
            timer.unref?.();
          }),
        ]);
      }
      log.info("shutdown_step", { step: "playwright" });
      await dropAllLoginSessions().catch(() => undefined);
      await playwright.close().catch(() => undefined);
      log.info("shutdown_step", { step: "browser" });
      await browser.close().catch(() => undefined);
      db.close();
      log.info("stopped");
    } finally {
      clearInterval(keepAlive);
      resolveShutdown();
    }
  };

  const onSignal = (signal: string): void => {
    const hardExit = setTimeout(() => process.exit(0), 15_000);
    hardExit.unref?.();
    void shutdown(signal);
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  if (!botConfigured) {
    log.info("running_in_dashboard_mode_waiting_config");
    await shutdownDone;
    return;
  }

  bot = createBot(ctx, scheduler);
  scheduler.start();

  await notifier.send(
    "🚀 <b>hh-autoresponder запущен</b>\n\n" +
      describeConfig(config) +
      `\n🖥 Браузер: ${browserOk ? "Playwright доступен" : "API-only (анкеты через браузер недоступны)"}\n\n` +
      "Управление — /start. Капча hh.ru будет приходить сюда.",
  );

  if (state.autoApplyPaused) {
    await notifier.sendWithButton(
      "⏸ <b>Автоотклики приостановлены после ошибки капчи.</b>\n\n" +
        "Нажми кнопку ниже, чтобы продолжить.",
      "▶️ Продолжить автоотклики",
      "resume_auto_apply",
    );
  }

  if (config.dryRun) {
    await notifier.send("🧪 Режим DRY_RUN: отклики не отправляются.");
  }
  if (config.captchaEnabled) {
    await notifier.send(
      "🔐 <b>Капча настроена</b>\n\n" +
        "Когда hh.ru попросит капчу, пришлю картинку сюда. Ответь текстом с картинки " +
        "одним сообщением. Отменить — /cancel_captcha.",
    );
  }

  try {
    await startBot(bot);
    await shutdownDone;
  } catch (error) {
    log.error("bot_fatal", {
      error: error instanceof Error ? error.message : error,
    });
    await shutdown("bot_fatal");
    process.exit(1);
  }
}

await main();
