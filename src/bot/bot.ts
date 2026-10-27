/**
 * Telegram-бот: меню, статистика, вакансии, настройки и — главное —
 * приём ответа на капчу hh.ru.
 */
import { Bot, InputFile, type Context } from "grammy";

import type { AppContext } from "../context";
import { log } from "../logger";
import type { Application, NegotiationStatus, Vacancy } from "../models";
import type { WorkerScheduler } from "../scheduler";
import { dropLoginSession, getLoginSession, OTPLoginSession, setLoginSession } from "../hh/login";
import { isCommand } from "../utils/text";
import { escapeHtml, formatSalary, renderLetter, truncate } from "../utils/text";
import { manualApply, runTestApply } from "../workers/apply";
import { processRejectionThanks } from "../workers/messages";
import {
  behaviorKeyboard,
  captchaKeyboard,
  clearNegotiationsKeyboard,
  confirmApplyKeyboard,
  mainMenu,
  settingsKeyboard,
  vacancyKeyboard,
  vacancyListKeyboard,
} from "./keyboards";

const PAGE_SIZE = 5;

const MENU_BUTTONS = new Set([
  "📊 Статистика",
  "🔍 Вакансии",
  "⭐ Топ вакансии",
  "⚙️ Настройки",
  "📋 Логи",
  "📩 Сообщения",
  "🔐 Войти на hh",
  "🧹 Очистка откликов",
]);

const STATUS_EMOJI: Record<string, string> = {
  sent: "✅",
  failed: "❌",
  pending: "⏳",
  viewed: "👀",
  rejected: "🚫",
  invited: "🎉",
};

type LoginPhase = "phone" | "starting" | "code" | "checking";

function isAdmin(config: AppContext["config"], ctx: Context): boolean {
  return String(ctx.chat?.id ?? "") === config.tgAdminChatId;
}

function splitMessage(text: string, limit = 3900): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    if (current.length + line.length + 1 > limit && current) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function createBot(app: AppContext, scheduler: WorkerScheduler): Bot {
  const bot = new Bot(app.config.tgBotToken, buildClientOptions(app));
  const chatId = app.config.tgAdminChatId;
  const loginPhases = new Map<number, LoginPhase>();

  // ── Notifier: исходящие сообщения и капча ────────────────────────────
  app.notifier.configure({
    sendText: async (text: string) => {
      for (const chunk of splitMessage(text)) {
        try {
          await bot.api.sendMessage(chatId, chunk, {
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
          });
        } catch (error) {
          log.warn("telegram_html_failed", {
            error: error instanceof Error ? error.message : error,
          });
          await bot.api.sendMessage(chatId, chunk);
        }
      }
    },
    sendCaptchaImage: async (prompt) => {
      const keyboard = captchaKeyboard(prompt.url);
      const photo = new InputFile(Buffer.from(prompt.image), "hh-captcha.png");
      try {
        // Обычная фотография: Telegram показывает её сразу, без открытия файла.
        await bot.api.sendPhoto(chatId, photo, {
          caption: prompt.caption,
          parse_mode: "HTML",
          reply_markup: keyboard,
        });
      } catch (error) {
        log.warn("send_photo_failed", {
          error: error instanceof Error ? error.message : error,
        });
        await bot.api.sendDocument(chatId, new InputFile(Buffer.from(prompt.image), "hh-captcha.png"), {
          caption: prompt.caption,
          parse_mode: "HTML",
          reply_markup: keyboard,
        });
      }
    },
    fallbackDir: `${app.config.dataDir}/captcha`,
  });

  // ── Доступ только админу ─────────────────────────────────────────────
  bot.use(async (ctx, next) => {
    if (isAdmin(app.config, ctx)) return next();
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: "Нет доступа" }).catch(() => undefined);
    }
    return;
  });

  // ── Ответ на капчу приходит обычным текстом ──────────────────────────
  bot.on("message:text", async (ctx, next) => {
    const text = ctx.message.text;
    if (app.notifier.hasPendingCaptcha() && !isCommand(text) && !MENU_BUTTONS.has(text)) {
      const accepted = app.notifier.resolveCaptcha(text);
      if (accepted) {
        await ctx.reply("✅ Принял капчу, проверяю…").catch(() => undefined);
        return;
      }
    }
    await next();
  });

  // ── Вход по коду: телефон → код ──────────────────────────────────────
  bot.on("message:text", async (ctx, next) => {
    const uid = ctx.chat!.id;
    const phase = loginPhases.get(uid);
    if (!phase) return next();
    const text = ctx.message.text.trim();
    if (isCommand(text)) return next();

    if (phase === "phone") {
      if (text.replace(/\D/g, "").length < 5) {
        await ctx.reply("Не похоже на номер. Пришли телефон ещё раз или /cancel.");
        return;
      }
      loginPhases.set(uid, "starting");
      await ctx.reply("⏳ Открываю вход на hh и запрашиваю код…");
      void startOtpLogin(bot, app, uid, text, loginPhases);
      return;
    }

    if (phase === "code") {
      loginPhases.set(uid, "checking");
      await ctx.reply("⏳ Проверяю код…");
      void submitOtpCode(bot, app, uid, text, loginPhases);
      return;
    }

    await ctx.reply("⏳ Ещё выполняю вход, подожди пару секунд…");
  });

  // ── Команды ──────────────────────────────────────────────────────────
  bot.command("start", async (ctx) => {
    await ctx.reply(
      "👋 <b>hh-autoresponder</b>\n\n" +
        "Бот ищет вакансии на hh.ru и откликается за тебя.\n" +
        "Если hh попросит капчу — пришлю картинку сюда, просто ответь текстом.\n\n" +
        "Управление — кнопками ниже. Справка: /help",
      { parse_mode: "HTML", reply_markup: mainMenu() },
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      "📚 <b>Команды</b>\n\n" +
        "/start — меню\n" +
        "/stats — статистика\n" +
        "/vacancies — вакансии\n" +
        "/top — топ вакансии\n" +
        "/messages — приглашения и статусы\n" +
        "/settings — настройки\n" +
        "/logs — последние отклики\n" +
        "/pause и /resume — пауза/продолжить\n" +
        "/login — вход на hh по коду\n" +
        "/cancel — отменить вход\n" +
        "/cancel_captcha — отменить ввод капчи\n" +
        "/bump — поднять резюме\n" +
        "/clear_neg — очистка откликов\n" +
        "/test_apply 5 — тестовые отклики\n" +
        "/health — проверка сессии\n" +
        "/blacklist [company|keyword|vacancy] <значение> — ЧС\n",
      { parse_mode: "HTML" },
    );
  });

  bot.command("stats", async (ctx) => sendStats(ctx, app));
  bot.command("vacancies", async (ctx) => sendVacancyPage(ctx, app, 0, false));
  bot.command("top", async (ctx) => sendVacancyPage(ctx, app, 0, true));
  bot.command("settings", async (ctx) => sendSettings(ctx, app, scheduler));
  bot.command("messages", async (ctx) => {
    await ctx.reply("🔄 Проверяю отклики на hh.ru…");
    void (async () => {
      await sendMessages(bot, app, ctx.chat!.id);
    })();
  });
  bot.command("logs", async (ctx) => sendLogs(ctx, app));
  bot.command("pause", async (ctx) => {
    scheduler.pause();
    await ctx.reply("⏸ Пауза. /resume — возобновить", { reply_markup: mainMenu() });
  });
  bot.command("resume", async (ctx) => {
    scheduler.resume();
    await ctx.reply("▶️ Возобновлено", { reply_markup: mainMenu() });
  });
  bot.command("cancel", async (ctx) => {
    await dropLoginSession(ctx.chat!.id);
    loginPhases.delete(ctx.chat!.id);
    app.notifier.cancelCaptcha("отменено командой /cancel");
    await ctx.reply("Отменено.");
  });
  bot.command("cancel_captcha", async (ctx) => {
    const cancelled = app.notifier.cancelCaptcha();
    await ctx.reply(cancelled ? "🚫 Ввод капчи отменён." : "Сейчас нет активной капчи.");
  });
  bot.command("login", async (ctx) => beginLogin(ctx, app, loginPhases));
  bot.command("health", async (ctx) => {
    await ctx.reply("🔄 Проверяю сессию hh.ru…");
    // Важно: не ждём сеть в обработчике — иначе капча, которую попросит hh,
    // не сможет дойти до нас: grammY обрабатывает апдейты последовательно.
    void (async () => {
      const me = await app.oauth.getMe();
      await bot.api.sendMessage(
        ctx.chat!.id,
        me.ok
          ? `✅ Сессия hh.ru работает${me.name ? `: ${escapeHtml(me.name)}` : ""}`
          : `❌ Сессия hh.ru не работает (HTTP ${me.status}). Отправь /login.`,
      );
    })();
  });
  bot.command("blacklist", async (ctx) => handleBlacklistCommand(ctx, app));
  bot.command("bump", async (ctx) => {
    await ctx.reply("⬆️ Поднимаю резюме…");
    void (async () => {
      const result = await app.oauth.bumpResumes();
      if (result.error) {
        await bot.api.sendMessage(ctx.chat!.id, `❌ Не получилось: ${escapeHtml(result.error)}`);
        return;
      }
      if (result.bumped > 0) {
        const titles = result.titles.map((title) => `• ${escapeHtml(title)}`).join("\n");
        await bot.api.sendMessage(
          ctx.chat!.id,
          `✅ Поднято резюме: ${result.bumped}${titles ? `\n${titles}` : ""}`,
          { parse_mode: "HTML" },
        );
      } else if (result.blocked > 0) {
        await bot.api.sendMessage(
          ctx.chat!.id,
          `ℹ️ Пока нельзя поднять (${result.blocked} шт). hh разрешает раз в 4 часа.`,
        );
      } else {
        await bot.api.sendMessage(ctx.chat!.id, "ℹ️ Резюме не найдены в аккаунте hh.");
      }
    })();
  });
  bot.command("clear_neg", async (ctx) => {
    await ctx.reply(
      "🧹 <b>Очистка откликов на hh.ru</b>\n\n" +
        "Отклики скрываются через официальный API, переписка не удаляется.",
      { parse_mode: "HTML", reply_markup: clearNegotiationsKeyboard() },
    );
  });
  bot.command("negotiations", async (ctx) => {
    void (async () => {
      const statuses = await app.oauth.negotiationsStatus();
      await bot.api.sendMessage(ctx.chat!.id, formatNegotiations(statuses), {
        parse_mode: "HTML",
      });
    })();
  });
  bot.command("test_apply", async (ctx) => {
    const parts = (ctx.message?.text ?? "").split(/\s+/);
    const count = Math.max(1, Math.min(Number.parseInt(parts[1] ?? "10", 10) || 10, 20));
    await ctx.reply(`🧪 Запускаю тест-отклики: ${count} шт. Это может занять несколько минут.`);
    void (async () => {
      const stats = await runTestApply(app, count, 70);
      await bot.api.sendMessage(
        ctx.chat!.id,
        `📊 <b>Итоги теста:</b>\n` +
          `✅ Отправлено: ${stats.sent}\n` +
          `ℹ️ Уже откликались: ${stats.already}\n` +
          `❌ Ошибки: ${stats.failed}`,
        { parse_mode: "HTML" },
      );
    })();
  });
  bot.command("thanks", async (ctx) => {
    await ctx.reply("💬 Отправляю благодарности за отказы…");
    void (async () => {
      const sent = await processRejectionThanks(app, 3);
      await bot.api.sendMessage(ctx.chat!.id, `Отправлено сообщений: ${sent}`);
    })();
  });

  // ── Кнопки главного меню ─────────────────────────────────────────────
  bot.hears("📊 Статистика", async (ctx) => sendStats(ctx, app));
  bot.hears("🔍 Вакансии", async (ctx) => sendVacancyPage(ctx, app, 0, false));
  bot.hears("⭐ Топ вакансии", async (ctx) => sendVacancyPage(ctx, app, 0, true));
  bot.hears("⚙️ Настройки", async (ctx) => sendSettings(ctx, app, scheduler));
  bot.hears("📋 Логи", async (ctx) => sendLogs(ctx, app));
  bot.hears("🔐 Войти на hh", async (ctx) => beginLogin(ctx, app, loginPhases));
  bot.hears("🧹 Очистка откликов", async (ctx) => {
    await ctx.reply("🧹 <b>Очистка откликов</b>", {
      parse_mode: "HTML",
      reply_markup: clearNegotiationsKeyboard(),
    });
  });
  bot.hears("📩 Сообщения", async (ctx) => {
    await ctx.reply("🔄 Проверяю отклики на hh.ru…");
    void (async () => {
      await sendMessages(bot, app, ctx.chat!.id);
    })();
  });

  // ── Callback-кнопки ──────────────────────────────────────────────────
  bot.callbackQuery("noop", async (ctx) => {
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^page:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendVacancyPage(ctx, app, Number(ctx.match[1]), false, true);
  });
  bot.callbackQuery(/^top_page:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendVacancyPage(ctx, app, Number(ctx.match[1]), true, true);
  });

  bot.callbackQuery(/^details:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const vacancy = app.db.getVacancy(Number(ctx.match[1]));
    if (!vacancy) {
      await ctx.reply("Вакансия не найдена.");
      return;
    }
    await ctx.reply(formatVacancyDetails(vacancy), {
      parse_mode: "HTML",
      reply_markup: vacancyKeyboard(vacancy.id),
      link_preview_options: { is_disabled: true },
    });
  });

  bot.callbackQuery(/^apply:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const vacancy = app.db.getVacancy(Number(ctx.match[1]));
    if (!vacancy) {
      await ctx.reply("Вакансия не найдена.");
      return;
    }
    const letter = renderLetter(app.config.coverLetter, vacancy.title, vacancy.companyName ?? "");
    await ctx.reply(
      `📨 <b>${escapeHtml(vacancy.title)}</b>\n\n${escapeHtml(letter)}`,
      {
        parse_mode: "HTML",
        reply_markup: confirmApplyKeyboard(vacancy.id),
      },
    );
  });

  bot.callbackQuery(/^confirm_apply:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const vacancy = app.db.getVacancy(Number(ctx.match[1]));
    if (!vacancy) {
      await ctx.reply("Вакансия не найдена.");
      return;
    }
    await ctx.reply("📨 Отправляю отклик…");
    void (async () => {
      const result = await manualApply(app, vacancy);
      if (result.result === true) {
        await bot.api.sendMessage(ctx.chat!.id, "✅ Отклик отправлен!");
      } else if (result.result === "already") {
        await bot.api.sendMessage(
          ctx.chat!.id,
          "ℹ️ На эту вакансию уже есть отклик (новый не отправлен).",
        );
      } else {
        await bot.api.sendMessage(
          ctx.chat!.id,
          `❌ Не удалось отправить отклик${result.error ? `: ${escapeHtml(result.error)}` : ""}`,
        );
      }
    })();
  });

  bot.callbackQuery(/^skip:(\d+)$/, async (ctx) => {
    app.db.setVacancyStatus(Number(ctx.match[1]), "rejected");
    await ctx.answerCallbackQuery({ text: "❌ Пропущена" });
  });

  bot.callbackQuery(/^blacklist:(\d+)$/, async (ctx) => {
    const vacancy = app.db.getVacancy(Number(ctx.match[1]));
    if (vacancy) {
      app.db.addBlacklist("vacancy", vacancy.externalId, "manual");
      app.db.setVacancyStatus(vacancy.id, "rejected");
    }
    await ctx.answerCallbackQuery({ text: "🚫 В чёрном списке" });
  });

  bot.callbackQuery("toggle_pause", async (ctx) => {
    if (scheduler.isPaused) scheduler.resume();
    else scheduler.pause();
    await ctx.answerCallbackQuery({ text: scheduler.isPaused ? "⏸ Пауза" : "▶️ Работает" });
    await safeEdit(ctx, app, scheduler);
  });

  bot.callbackQuery("toggle_auto", async (ctx) => {
    scheduler.setAutoApply(!scheduler.autoApply);
    await ctx.answerCallbackQuery({
      text: scheduler.autoApply ? "🟢 Авто-отклик ВКЛ" : "⚪ Авто-отклик ВЫКЛ",
    });
    await safeEdit(ctx, app, scheduler);
  });

  bot.callbackQuery("force_search", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "🔄 Запускаю поиск…" });
    void (async () => {
      try {
        const count = await scheduler.forceSearch();
        await bot.api.sendMessage(
          ctx.chat!.id,
          `🔍 Найдено <b>${count}</b> новых вакансий`,
          { parse_mode: "HTML" },
        );
      } catch (error) {
        await bot.api.sendMessage(
          ctx.chat!.id,
          `❌ Поиск не удался: ${escapeHtml(error instanceof Error ? error.message : String(error))}`,
        );
      }
    })();
  });

  bot.callbackQuery("bump_resume", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "⬆️ Поднимаю резюме…" });
    void (async () => {
      const result = await app.oauth.bumpResumes();
      if (result.error) {
        await bot.api.sendMessage(ctx.chat!.id, `❌ Не получилось: ${escapeHtml(result.error)}`);
      } else if (result.bumped > 0) {
        await bot.api.sendMessage(ctx.chat!.id, `✅ Поднято резюме: ${result.bumped}`);
      } else {
        await bot.api.sendMessage(
          ctx.chat!.id,
          result.blocked > 0
            ? `ℹ️ Пока нельзя поднять (${result.blocked} шт). hh разрешает раз в 4 часа.`
            : "ℹ️ Резюме не найдены.",
        );
      }
    })();
  });

  bot.callbackQuery("behavior_menu", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      "🎛 <b>Что делает бот</b>\n\n" +
        "Нажми на пункт, чтобы включить (✅) или выключить (⬜️):\n" +
        "• <b>Авто-отклики</b> — сам откликается на вакансии\n" +
        "• <b>Проходить тесты</b> — пробует заполнять анкеты нейтральными ответами\n" +
        "• <b>Сообщать о рекрутёрах</b> — уведомления о приглашениях\n" +
        "• <b>Благодарить за отказ</b> — сообщение спасибо в чат (экспериментально)\n" +
        "• <b>Поднимать резюме</b> — авто-поднятие каждые 4 часа",
      { parse_mode: "HTML", reply_markup: behaviorKeyboard(scheduler.getFlags()) },
    );
  });

  bot.callbackQuery(/^bflag:(.+)$/, async (ctx) => {
    const name = ctx.match[1]!;
    const current = scheduler.getFlags()[name] ?? true;
    scheduler.setFlag(name, !current);
    await ctx.answerCallbackQuery({ text: current ? "Выключено" : "Включено" });
    await ctx.editMessageReplyMarkup({
      reply_markup: behaviorKeyboard(scheduler.getFlags()),
    }).catch(() => undefined);
  });

  bot.callbackQuery("clear_neg", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("🧹 <b>Очистка откликов</b>", {
      parse_mode: "HTML",
      reply_markup: clearNegotiationsKeyboard(),
    });
  });

  bot.callbackQuery(/^clearneg:(discard|old14|old30|dry)$/, async (ctx) => {
    const mode = ctx.match[1]!;
    await ctx.answerCallbackQuery({ text: "Выполняю…" });
    void (async () => {
      const olderThanDays = mode === "old14" ? 14 : mode === "old30" ? 30 : null;
      const result = await app.oauth.clearNegotiations(olderThanDays, mode === "dry");
      if (result.error) {
        await bot.api.sendMessage(
          ctx.chat!.id,
          `❌ ${escapeHtml(result.error === "no_oauth_token" ? "Нет токена hh. Отправь /login." : result.error)}`,
        );
        return;
      }
      const label =
        mode === "discard"
          ? "Отказы"
          : mode === "old14"
            ? "Старше 14 дней"
            : mode === "old30"
              ? "Старше 30 дней"
              : "Предпросмотр";
      const verb = mode === "dry" ? "Под удаление попадёт" : "Убрано";
      let text =
        `✅ <b>${label}</b>\n` +
        `Просмотрено откликов: ${result.scanned}\n` +
        `${verb}: <b>${result.deleted}</b>`;
      if (result.names.length > 0) {
        text += `\n\n${result.names.slice(0, 15).map((name) => `• ${escapeHtml(name)}`).join("\n")}`;
      }
      await bot.api.sendMessage(ctx.chat!.id, text, { parse_mode: "HTML" });
    })();
  });

  bot.callbackQuery("settings_back", async (ctx) => {
    await ctx.answerCallbackQuery();
    await safeEdit(ctx, app, scheduler);
  });

  bot.callbackQuery("show_stats", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendStats(ctx, app);
  });

  bot.callbackQuery("login_start", async (ctx) => {
    await ctx.answerCallbackQuery();
    await beginLogin(ctx, app, loginPhases);
  });

  bot.callbackQuery(/^cancel_apply:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Отменено" });
    await ctx.deleteMessage().catch(() => undefined);
  });

  bot.callbackQuery(/^thank_rejections$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "💬 Отправляю…" });
    void (async () => {
      const sent = await processRejectionThanks(app, 3);
      await bot.api.sendMessage(ctx.chat!.id, `Отправлено сообщений: ${sent}`);
    })();
  });

  bot.catch((error) => {
    log.error("bot_error", {
      error: error.error instanceof Error ? error.error.message : String(error.error),
      update: error.ctx.update.update_id,
    });
  });

  return bot;
}

function buildClientOptions(app: AppContext): {
  client?: { apiRoot?: string; fetch?: typeof fetch; timeoutSeconds?: number };
} {
  const client: { apiRoot?: string; fetch?: typeof fetch; timeoutSeconds?: number } = {
    timeoutSeconds: 60,
  };
  if (app.config.tgApiServer) client.apiRoot = app.config.tgApiServer;
  if (app.config.tgProxy) {
    const proxy = app.config.tgProxy;
    client.fetch = ((input: string | URL | Request, init?: RequestInit) =>
      fetch(input as never, { ...(init ?? {}), proxy } as never)) as typeof fetch;
  }
  return Object.keys(client).length > 0 ? { client } : {};
}

// ── Логика входа ────────────────────────────────────────────────────────

async function beginLogin(
  ctx: Context,
  app: AppContext,
  phases: Map<number, LoginPhase>,
): Promise<void> {
  const uid = ctx.chat?.id;
  if (!uid) return;
  if (app.notifier.hasPendingCaptcha()) {
    app.notifier.cancelCaptcha("вход на hh перезапущен");
  }
  await dropLoginSession(uid);
  phases.set(uid, "phone");
  const hint = app.config.hhLogin
    ? `\n\nЛогин из настроек: <code>${escapeHtml(app.config.hhLogin)}</code>`
    : "";
  await ctx.reply(
    "🔐 <b>Вход на hh.ru по коду</b>\n\n" +
      "Пришли номер телефона, привязанный к hh (например <code>+79991234567</code>). " +
      "hh отправит код, его потом введёшь здесь." +
      hint +
      "\n\nОтмена: /cancel",
    { parse_mode: "HTML" },
  );
}

async function startOtpLogin(
  bot: Bot,
  app: AppContext,
  uid: number,
  phone: string,
  phases: Map<number, LoginPhase>,
): Promise<void> {
  const session = new OTPLoginSession(app.config, app.notifier);
  setLoginSession(uid, session);
  try {
    const result = await session.start(phone);
    if (phases.get(uid) !== "starting") {
      // Пользователь отменил вход, пока открывался браузер.
      await dropLoginSession(uid);
      return;
    }
    if (result.status === "ok") {
      phases.delete(uid);
      await dropLoginSession(uid);
      app.oauth.reloadToken();
      app.state.markPlatformHealthy("hh");
      app.state.setLastLoginAlert("hh", null);
      await bot.api.sendMessage(
        uid,
        "✅ Вход выполнен. Токен hh и браузерная сессия обновлены.",
      );
      return;
    }
    if (result.status === "code_sent") {
      phases.set(uid, "code");
      await bot.api.sendMessage(
        uid,
        "📩 hh отправил код (SMS или почта). Пришли его сюда одним сообщением.",
      );
      return;
    }
    phases.delete(uid);
    await dropLoginSession(uid);
    if (result.status === "captcha") {
      await bot.api.sendMessage(
        uid,
        "🔐 Капча при входе не решена. Попробуй /login ещё раз.",
      );
    } else {
      await bot.api.sendMessage(
        uid,
        `❌ Не удалось начать вход: ${escapeHtml(result.error ?? "unknown")}\nПопробуй /login ещё раз.`,
        { parse_mode: "HTML" },
      );
    }
  } catch (error) {
    if (phases.get(uid) !== "starting") return;
    phases.delete(uid);
    await dropLoginSession(uid);
    await bot.api.sendMessage(
      uid,
      `❌ Ошибка входа: ${escapeHtml(error instanceof Error ? error.message : String(error))}`,
    );
  }
}

async function submitOtpCode(
  bot: Bot,
  app: AppContext,
  uid: number,
  code: string,
  phases: Map<number, LoginPhase>,
): Promise<void> {
  const session = getLoginSession(uid);
  if (!session) {
    phases.delete(uid);
    await bot.api.sendMessage(uid, "Сессия входа потеряна. Начни заново: /login");
    return;
  }
  try {
    const result = await session.submitCode(code);
    if (phases.get(uid) !== "checking") {
      await dropLoginSession(uid);
      return;
    }
    phases.delete(uid);
    await dropLoginSession(uid);
    if (result.status === "ok") {
      app.oauth.reloadToken();
      app.state.markPlatformHealthy("hh");
      app.state.setLastLoginAlert("hh", null);
      await bot.api.sendMessage(
        uid,
        "✅ Вход выполнен. Токен hh и браузерная сессия обновлены.\n" +
          "Теперь работают отклики, анкеты и поднятие резюме.",
      );
    } else {
      await bot.api.sendMessage(
        uid,
        `❌ Код не подошёл: ${escapeHtml(result.error ?? "unknown")}\nПопробуй /login заново.`,
        { parse_mode: "HTML" },
      );
    }
  } catch (error) {
    if (phases.get(uid) !== "checking") return;
    phases.delete(uid);
    await dropLoginSession(uid);
    await bot.api.sendMessage(
      uid,
      `❌ Ошибка проверки кода: ${escapeHtml(error instanceof Error ? error.message : String(error))}`,
    );
  }
}

// ── Отображение ─────────────────────────────────────────────────────────

async function sendStats(ctx: Context, app: AppContext): Promise<void> {
  const stats = app.db.getStats();
  const lines = [
    "📊 <b>Статистика</b>",
    "",
    `📦 Всего вакансий: <b>${stats.totalVacancies}</b>`,
    `🆕 Новые: <b>${stats.newVacancies}</b>`,
    `⭐ Одобрено: <b>${stats.approvedVacancies}</b>`,
    `📈 Средний score: <b>${stats.avgScore === null ? "—" : Math.round(stats.avgScore)}</b>`,
    "",
    "📨 <b>Отклики:</b>",
    `  • Сегодня: <b>${stats.sentToday}/${app.config.maxAppliesPerDay}</b>`,
    `  • Ошибок сегодня: <b>${stats.failedToday}</b>`,
    `  • Всего отправлено: <b>${stats.sentTotal}</b>`,
    "",
    "🏷 <b>По платформам:</b>",
  ];

  if (stats.byPlatform.length === 0) {
    lines.push("  • hh.ru — пока пусто");
  } else {
    for (const platform of stats.byPlatform) {
      lines.push(
        `  <b>hh.ru</b>\n` +
          `    📦 Вакансий: ${platform.vacancies}\n` +
          `    📨 Сегодня: ${platform.sentToday}\n` +
          `    📨 Всего: ${platform.sentTotal}\n` +
          `    💬 Сообщений: ${platform.messages}`,
      );
    }
  }

  await ctx.reply(lines.join("\n"), {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
}

async function sendVacancyPage(
  ctx: Context,
  app: AppContext,
  page: number,
  topOnly: boolean,
  edit = false,
): Promise<void> {
  const safePage = Math.max(0, page);
  const { items, total } = app.db.getVacancyPage(safePage * PAGE_SIZE, PAGE_SIZE, topOnly);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const normalizedPage = Math.min(safePage, totalPages - 1);
  if (normalizedPage !== safePage) {
    return sendVacancyPage(ctx, app, normalizedPage, topOnly, edit);
  }

  if (items.length === 0) {
    const text = topOnly ? "Нет топ-вакансий." : "Нет вакансий. Подожди следующий поиск.";
    if (edit) await ctx.editMessageText(text).catch(() => ctx.reply(text));
    else await ctx.reply(text);
    return;
  }

  const lines: string[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const vacancy = items[index]!;
    const number = normalizedPage * PAGE_SIZE + index + 1;
    const salary = formatSalary(vacancy.salaryFrom, vacancy.salaryTo, vacancy.salaryCurrency);
    const remote = vacancy.isRemote ? " 🏠" : "";
    const score = vacancy.score === null ? "" : ` | ⭐ ${Math.round(vacancy.score)}`;
    const company = vacancy.companyName ? `\n   🏢 ${escapeHtml(vacancy.companyName)}` : "";
    lines.push(
      `<b>${number}. ${escapeHtml(vacancy.title)}</b>${remote}${company}\n` +
        `   📍 ${escapeHtml(vacancy.location || "—")}${salary ? ` | 💰 ${salary}` : ""}${score}\n` +
        `   🔗 <a href="${escapeHtml(vacancy.url)}">Открыть</a>`,
    );
  }

  const header = topOnly ? "⭐ <b>Топ вакансии</b>" : "🔍 <b>Вакансии</b>";
  const text = `${header} (${total} шт.)\n\n${lines.join("\n\n")}`;
  const keyboard = vacancyListKeyboard(
    items.map((vacancy) => vacancy.id),
    normalizedPage,
    totalPages,
    topOnly ? "top_" : "",
    PAGE_SIZE,
  );

  if (edit) {
    await ctx
      .editMessageText(text, {
        parse_mode: "HTML",
        reply_markup: keyboard,
        link_preview_options: { is_disabled: true },
      })
      .catch(async () => {
        await ctx.reply(text, {
          parse_mode: "HTML",
          reply_markup: keyboard,
          link_preview_options: { is_disabled: true },
        });
      });
  } else {
    await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup: keyboard,
      link_preview_options: { is_disabled: true },
    });
  }
}

function formatVacancyDetails(vacancy: Vacancy): string {
  const salary = formatSalary(vacancy.salaryFrom, vacancy.salaryTo, vacancy.salaryCurrency);
  const company = vacancy.companyName ? `\n🏢 ${escapeHtml(vacancy.companyName)}` : "";
  const description = truncate(vacancy.description || "Описание не загружено", 3000);
  const score =
    vacancy.score === null
      ? ""
      : `\n\n⭐ <b>Score: ${Math.round(vacancy.score)}/100</b>\n${escapeHtml(vacancy.reason ?? "—")}`;
  return (
    `<b>${escapeHtml(vacancy.title)}</b>${company}` +
    `${salary ? `\n💰 ${salary}` : ""}` +
    score +
    `\n\n${escapeHtml(description)}\n\n` +
    `🔗 <a href="${escapeHtml(vacancy.url)}">Открыть на hh.ru</a>`
  );
}

async function sendSettings(
  ctx: Context,
  app: AppContext,
  scheduler: WorkerScheduler,
): Promise<void> {
  await ctx.reply(settingsText(app, scheduler), {
    parse_mode: "HTML",
    reply_markup: settingsKeyboard(scheduler.isPaused, scheduler.autoApply),
  });
}

function settingsText(app: AppContext, scheduler: WorkerScheduler): string {
  const flags = scheduler.getFlags();
  const flagLine = (name: string, label: string): string =>
    `${flags[name] ? "✅" : "⬜️"} ${label}`;
  return (
    "⚙️ <b>Настройки</b>\n\n" +
    `📍 Позиция: ${escapeHtml(app.config.desiredPosition)}\n` +
    `💰 Зарплата: ${app.config.desiredSalaryMin.toLocaleString("ru-RU")}–${app.config.desiredSalaryMax.toLocaleString("ru-RU")} ₽\n` +
    `⏱ Интервал поиска: ${Math.round(app.config.checkIntervalSec / 60)} мин\n` +
    `🎯 Лимит откликов/день: <b>${app.config.maxAppliesPerDay}</b>\n` +
    `⏱ Задержка между откликами: ${app.config.applyDelayMin}–${app.config.applyDelayMax} сек\n` +
    `🔔 Уведомления: ${app.config.notifyHourStart}:00–${app.config.notifyHourEnd}:00 МСК\n` +
    `🔐 Резюме: <code>${escapeHtml(app.config.hhResumeId || "определится автоматически")}</code>\n` +
    `🖼 Капча в Telegram: ${app.config.captchaEnabled ? "✅ вкл" : "⬜️ выкл"}\n\n` +
    `${flagLine("auto_apply", "Авто-отклики")}\n` +
    `${flagLine("pass_tests", "Проходить анкеты")}\n` +
    `${flagLine("notify_messages", "Сообщать о рекрутёрах")}\n` +
    `${flagLine("thank_rejections", "Благодарить за отказ")}\n` +
    `${flagLine("bump_resume", "Поднимать резюме")}\n\n` +
    `${scheduler.isPaused ? "⏸ Пауза" : "▶️ Работает"}`
  );
}

async function safeEdit(
  ctx: Context,
  app: AppContext,
  scheduler: WorkerScheduler,
): Promise<void> {
  const text = settingsText(app, scheduler);
  const keyboard = settingsKeyboard(scheduler.isPaused, scheduler.autoApply);
  await ctx
    .editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard })
    .catch(async () => {
      await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
    });
}

async function sendLogs(ctx: Context, app: AppContext): Promise<void> {
  const applications = app.db.getRecentApplications(10);
  if (applications.length === 0) {
    await ctx.reply("📋 Пока нет записей.");
    return;
  }
  const lines = ["📋 <b>Последние отклики</b>", ""];
  for (const application of applications) {
    lines.push(formatApplicationLine(application));
  }
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}

function formatApplicationLine(application: Application): string {
  const emoji = STATUS_EMOJI[application.status] ?? "❓";
  const title = application.vacancyTitle
    ? escapeHtml(truncate(application.vacancyTitle, 60))
    : `ID ${application.vacancyId}`;
  const error = application.errorMessage
    ? `\n   <i>${escapeHtml(truncate(application.errorMessage, 80))}</i>`
    : "";
  return `${emoji} [hh] ${title} — ${application.status}${error}`;
}

async function sendMessages(bot: Bot, app: AppContext, chatId: number): Promise<void> {
  try {
    const statuses = await app.oauth.negotiationsStatus();
    if (statuses.length === 0) {
      await bot.api.sendMessage(chatId, "📭 Нет активных откликов.");
      return;
    }

    const invites = statuses.filter((status) => status.tab === "invitations");
    const discards = statuses.filter((status) => status.tab === "discard");
    const pending = statuses.filter((status) => status.tab === "pending");

    const lines = [
      "📩 <b>Приглашения от работодателей</b>",
      `🎉 Приглашений: <b>${invites.length}</b>  •  ❌ Отказы: ${discards.length}  •  ⏳ Без ответа: ${pending.length}`,
    ];
    if (invites.length > 0) {
      lines.push("", "<b>Кто позвал:</b>");
      for (const invite of invites.slice(-25).reverse()) {
        lines.push(
          `• <b>${escapeHtml(invite.company || "—")}</b> — ${escapeHtml(invite.title || "вакансия")}`,
        );
      }
      if (invites.length > 25) {
        lines.push(`…и ещё ${invites.length - 25}. Полная переписка — на hh.ru.`);
      }
    } else {
      lines.push("", "Пока никто не позвал. Как появится приглашение — покажу здесь.");
    }

    await bot.api.sendMessage(chatId, lines.join("\n"), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  } catch (error) {
    await bot.api.sendMessage(
      chatId,
      `❌ Не удалось получить статусы: ${escapeHtml(error instanceof Error ? error.message : String(error))}`,
    );
  }
}

function formatNegotiations(statuses: NegotiationStatus[]): string {
  if (statuses.length === 0) return "📭 Нет активных откликов.";
  const invites = statuses.filter((status) => status.tab === "invitations");
  const discards = statuses.filter((status) => status.tab === "discard");
  const pending = statuses.filter((status) => status.tab === "pending");
  const lines = ["📋 <b>Статусы откликов hh.ru</b>"];
  if (invites.length > 0) {
    lines.push(`\n🎉 <b>Приглашения (${invites.length}):</b>`);
    for (const invite of invites.slice(0, 10)) {
      lines.push(`  • ${escapeHtml(invite.title.slice(0, 50))} — ${escapeHtml(invite.company)}`);
    }
  }
  lines.push(`\n⏳ Без ответа: ${pending.length}`);
  lines.push(`❌ Отказы: ${discards.length}`);
  return lines.join("\n");
}

async function handleBlacklistCommand(ctx: Context, app: AppContext): Promise<void> {
  const rawMatch = ctx.match;
  const args = (typeof rawMatch === "string" ? rawMatch : "").trim().split(/\s+/).filter(Boolean);
  if (args.length === 0) {
    const entries = app.db.listBlacklist(20);
    if (entries.length === 0) {
      await ctx.reply(
        "🚫 Чёрный список пуст.\n\nДобавить: /blacklist company|keyword|vacancy <значение>",
      );
      return;
    }
    await ctx.reply(
      "🚫 <b>Чёрный список:</b>\n\n" +
        entries.map((entry) => `• [${entry.entryType}] ${escapeHtml(entry.value)}`).join("\n"),
      { parse_mode: "HTML" },
    );
    return;
  }

  const first = args[0]!;
  const type = ["company", "keyword", "vacancy"].includes(first) ? first : "keyword";
  const value = type === first ? args.slice(1).join(" ") : args.join(" ");
  if (!value) {
    await ctx.reply("Укажи значение: /blacklist keyword продажи");
    return;
  }
  app.db.addBlacklist(type, value, "manual");
  await ctx.reply(`✅ Добавлено в ЧС: [${type}] ${escapeHtml(value)}`, { parse_mode: "HTML" });
}

export async function startBot(bot: Bot): Promise<void> {
  await bot.api
    .setMyCommands([
    { command: "start", description: "Меню" },
    { command: "stats", description: "Статистика" },
    { command: "vacancies", description: "Вакансии" },
    { command: "messages", description: "Приглашения" },
    { command: "settings", description: "Настройки" },
    { command: "login", description: "Войти на hh по коду" },
    { command: "help", description: "Справка" },
    ])
    .catch((error) => {
      log.warn("set_commands_failed", {
        error: error instanceof Error ? error.message : error,
      });
    });
  await bot.start({
    onStart: (me) => {
      log.info("bot_started", { username: me.username });
    },
  });
}
