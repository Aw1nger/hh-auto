/** Текстовые утилиты и форматирование. */

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

export function normalizeSpaces(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

export function formatSalary(
  from: number | null,
  to: number | null,
  currency: string | null,
): string {
  const symbol =
    currency === "USD" ? "$" : currency === "EUR" ? "€" : currency === "KZT" ? "₸" : "₽";
  const parts: string[] = [];
  if (from) parts.push(`от ${from.toLocaleString("ru-RU")}`);
  if (to) parts.push(`до ${to.toLocaleString("ru-RU")}`);
  if (parts.length === 0) return "";
  return `${parts.join(" ")} ${symbol}`;
}

/**
 * Сопроводительное письмо. Поддерживает плейсхолдеры `{vacancy}` и
 * `{company}`, чтобы одно письмо можно было чуть-чуть персонализировать.
 */
export function renderLetter(
  template: string,
  vacancyTitle = "",
  companyName = "",
): string {
  const letter = template
    .replaceAll("{vacancy}", vacancyTitle)
    .replaceAll("{{vacancy}}", vacancyTitle)
    .replaceAll("{company}", companyName)
    .replaceAll("{{company}}", companyName)
    .trim();
  return letter || template.trim();
}

/** Похоже ли сообщение на команду бота. */
export function isCommand(text: string): boolean {
  return text.trimStart().startsWith("/");
}
