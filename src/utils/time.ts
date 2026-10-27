/** Время в московской таймзоне: день/ночь, тихие часы, начало суток. */

const MSK = "Europe/Moscow";

export function moscowNow(): Date {
  // Date хранит UTC-момент; для получения компонентов используем Intl.
  return new Date();
}

export function getMoscowParts(date = new Date()): {
  hour: number;
  minute: number;
  year: number;
  month: number;
  day: number;
} {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: MSK,
    hour: "2-digit",
    minute: "2-digit",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return {
    hour: Number(parts.hour ?? 0),
    minute: Number(parts.minute ?? 0),
    year: Number(parts.year ?? 1970),
    month: Number(parts.month ?? 1),
    day: Number(parts.day ?? 1),
  };
}

export function getMoscowHour(date = new Date()): number {
  return getMoscowParts(date).hour;
}

export function isDaytime(config: { dayStartHour: number; dayEndHour: number }, date = new Date()): boolean {
  const hour = getMoscowHour(date);
  return hour >= config.dayStartHour && hour < config.dayEndHour;
}

export function isQuietHours(
  config: { notifyHourStart: number; notifyHourEnd: number },
  date = new Date(),
): boolean {
  const hour = getMoscowHour(date);
  return !(hour >= config.notifyHourStart && hour < config.notifyHourEnd);
}

/**
 * Начало текущих суток по Москве, выраженное в UTC ISO-строке.
 * Нужно для дневного лимита откликов.
 */
export function startOfMoscowDayUtcIso(date = new Date()): string {
  const parts = getMoscowParts(date);
  // Москва — UTC+3 круглый год (без перехода на летнее время).
  const utcMidnight = Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0) - 3 * 60 * 60 * 1000;
  return new Date(utcMidnight).toISOString();
}

/** Время в МСК в формате HH:mm. */
export function formatMoscowTime(date = new Date()): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: MSK,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

/** Ключ вида `2026-10-27 10` для cron-сводки (МСК). */
export function moscowHourKey(date = new Date()): string {
  const parts = getMoscowParts(date);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")} ${parts.hour}`;
}

export function moscowDateLabel(date = new Date()): string {
  const parts = getMoscowParts(date);
  return `${String(parts.day).padStart(2, "0")}.${String(parts.month).padStart(2, "0")}.${parts.year}`;
}
