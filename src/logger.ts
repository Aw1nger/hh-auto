/**
 * Небольшой структурированный логгер без внешних зависимостей.
 * Формат: `2026-01-01T00:00:00.000Z [info] hh сообщение key=value`.
 */
import type { LogLevel } from "./config";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let currentLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

type Fields = Record<string, unknown>;

function serializeValue(value: unknown): string {
  if (typeof value === "string") {
    return /[\s="]/.test(value) ? JSON.stringify(value) : value;
  }
  if (value instanceof Error) return JSON.stringify(value.message);
  if (typeof value === "object" && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function serializeFields(fields?: Fields): string {
  if (!fields) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    parts.push(`${key}=${serializeValue(value)}`);
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

function write(level: LogLevel, scope: string, message: string, fields?: Fields): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[currentLevel]) return;
  const line = `${new Date().toISOString()} [${level.padEnd(5)}] ${scope} ${message}${serializeFields(fields)}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export class Logger {
  constructor(private readonly scope: string = "app") {}

  child(scope: string): Logger {
    return new Logger(`${this.scope}:${scope}`);
  }

  debug(message: string, fields?: Fields): void {
    write("debug", this.scope, message, fields);
  }

  info(message: string, fields?: Fields): void {
    write("info", this.scope, message, fields);
  }

  warn(message: string, fields?: Fields): void {
    write("warn", this.scope, message, fields);
  }

  error(message: string, fields?: Fields): void {
    write("error", this.scope, message, fields);
  }
}

export const log = new Logger("app");
