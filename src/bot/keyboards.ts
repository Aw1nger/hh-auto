/** Клавиатуры Telegram-бота (grammY). */
import { InlineKeyboard, Keyboard } from "grammy";

export function mainMenu(): Keyboard {
  return new Keyboard()
    .text("🔍 Вакансии")
    .text("📊 Статистика")
    .row()
    .text("📩 Сообщения")
    .text("⚙️ Настройки")
    .row()
    .text("⭐ Топ вакансии")
    .text("📋 Логи")
    .row()
    .text("🧹 Очистка откликов")
    .text("🔐 Войти на hh")
    .resized()
    .persistent();
}

export function settingsKeyboard(isPaused: boolean, autoApply: boolean): InlineKeyboard {
  return new InlineKeyboard()
    .text(isPaused ? "▶️ Возобновить" : "⏸ Пауза", "toggle_pause")
    .text(autoApply ? "🟢 Авто-отклик ВКЛ" : "⚪ Авто-отклик ВЫКЛ", "toggle_auto")
    .row()
    .text("🔄 Искать сейчас", "force_search")
    .text("⬆️ Поднять резюме", "bump_resume")
    .row()
    .text("🎛 Что делает бот", "behavior_menu")
    .text("🧹 Очистить отклики", "clear_neg")
    .row()
    .text("🔐 Войти на hh", "login_start")
    .text("📊 Статистика", "show_stats");
}

export function vacancyListKeyboard(
  ids: number[],
  page: number,
  totalPages: number,
  prefix = "",
  pageSize = 5,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  ids.forEach((id, index) => {
    keyboard
      .text(`📄 #${page * pageSize + index + 1}`, `details:${id}`)
      .text("✅", `apply:${id}`)
      .text("❌", `skip:${id}`)
      .row();
  });

  if (page > 0) keyboard.text("◀️ Назад", `${prefix}page:${page - 1}`);
  keyboard.text(`${page + 1}/${totalPages}`, "noop");
  if (page < totalPages - 1) keyboard.text("Вперёд ▶️", `${prefix}page:${page + 1}`);
  return keyboard;
}

export function vacancyKeyboard(vacancyId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Откликнуться", `apply:${vacancyId}`)
    .text("❌ Пропустить", `skip:${vacancyId}`)
    .row()
    .text("📄 Подробнее", `details:${vacancyId}`)
    .text("🚫 В ЧС", `blacklist:${vacancyId}`);
}

export function confirmApplyKeyboard(vacancyId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("📨 Да, отправить", `confirm_apply:${vacancyId}`)
    .text("❌ Отмена", `cancel_apply:${vacancyId}`);
}

const FLAG_LABELS: Record<string, string> = {
  auto_apply: "Авто-отклики",
  pass_tests: "Проходить тесты вакансий",
  notify_messages: "Сообщать о рекрутёрах",
  thank_rejections: "Благодарить за отказ",
  bump_resume: "Поднимать резюме",
};

export function behaviorKeyboard(flags: Record<string, boolean>): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const [name, label] of Object.entries(FLAG_LABELS)) {
    keyboard.text(`${flags[name] ? "✅" : "⬜️"} ${label}`, `bflag:${name}`).row();
  }
  return keyboard;
}

export function clearNegotiationsKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🚫 Убрать отказы", "clearneg:discard")
    .row()
    .text("🗓 Старше 14 дней", "clearneg:old14")
    .row()
    .text("🗓 Старше 30 дней", "clearneg:old30")
    .row()
    .text("👀 Показать без удаления", "clearneg:dry")
    .row()
    .text("⬅️ Назад", "settings_back");
}

export function captchaKeyboard(url: string): InlineKeyboard {
  return new InlineKeyboard().url("🌐 Открыть страницу капчи", url);
}
