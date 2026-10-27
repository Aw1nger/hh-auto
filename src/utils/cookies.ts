/**
 * Мини-хранилище cookies для HTTP-клиента (fetch не хранит cookies сам).
 *
 * Нужно для страницы капчи hh.ru: hh выдаёт `_xsrf`, `hhtoken`, `hhuid`,
 * `__ddg*`, и все последующие запросы должны идти с этими cookie.
 */
export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number | null;
  secure: boolean;
  httpOnly: boolean;
  hostOnly: boolean;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** Разбить сырой заголовок Set-Cookie на отдельные cookies. */
export function splitSetCookieHeader(raw: string | null | undefined): string[] {
  if (!raw) return [];
  // Запятая внутри Expires ("Wed, 27 Oct 2026...") не должна считаться
  // разделителем, поэтому режем только перед "name=".
  return raw
    .split(/,(?=\s*[A-Za-z0-9_!#$%&'*+\-.^`|~]+=)/g)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function parseSetCookie(
  header: string,
  requestUrl: string,
): Cookie | null {
  const url = new URL(requestUrl);
  const [pair, ...attributes] = header.split(";");
  if (!pair) return null;
  const eq = pair.indexOf("=");
  if (eq <= 0) return null;
  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  if (!name) return null;

  let domain = url.hostname.toLowerCase();
  let hostOnly = true;
  let path = "/";
  let expires: number | null = null;
  let secure = false;
  let httpOnly = false;

  for (const attr of attributes) {
    const index = attr.indexOf("=");
    const key = (index === -1 ? attr : attr.slice(0, index)).trim().toLowerCase();
    const attrValue = index === -1 ? "" : attr.slice(index + 1).trim();
    switch (key) {
      case "domain":
        if (attrValue) {
          domain = attrValue.replace(/^\./, "").toLowerCase();
          hostOnly = false;
        }
        break;
      case "path":
        path = attrValue || "/";
        break;
      case "max-age": {
        const seconds = Number.parseInt(attrValue, 10);
        if (Number.isFinite(seconds)) expires = nowSec() + seconds;
        break;
      }
      case "expires": {
        if (expires === null) {
          const timestamp = Date.parse(attrValue);
          if (Number.isFinite(timestamp)) expires = Math.floor(timestamp / 1000);
        }
        break;
      }
      case "secure":
        secure = true;
        break;
      case "httponly":
        httpOnly = true;
        break;
      default:
        break;
    }
  }

  return { name, value, domain, path: path || "/", expires, secure, httpOnly, hostOnly };
}

function domainMatches(cookie: Cookie, hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (cookie.hostOnly) return host === cookie.domain;
  return host === cookie.domain || host.endsWith(`.${cookie.domain}`);
}

function pathMatches(cookiePath: string, requestPath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath.charAt(cookiePath.length) === "/";
}

function cookieKey(cookie: Pick<Cookie, "domain" | "path" | "name">): string {
  return `${cookie.domain}|${cookie.path}|${cookie.name}`;
}

export class CookieJar {
  private cookies = new Map<string, Cookie>();

  setCookie(header: string, requestUrl: string): void {
    const cookie = parseSetCookie(header, requestUrl);
    if (!cookie) return;
    if (cookie.expires !== null && cookie.expires <= nowSec()) {
      this.cookies.delete(cookieKey(cookie));
      return;
    }
    this.cookies.set(cookieKey(cookie), cookie);
  }

  /** Сохранить все Set-Cookie из ответа fetch. */
  setFromHeaders(requestUrl: string, headers: Headers): void {
    const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
    const list =
      typeof getSetCookie === "function"
        ? getSetCookie.call(headers)
        : splitSetCookieHeader(headers.get("set-cookie"));
    for (const header of list) this.setCookie(header, requestUrl);
  }

  get(name: string, requestUrl?: string): string | undefined {
    const candidates = [...this.cookies.values()].filter((cookie) => {
      if (cookie.name !== name) return false;
      if (cookie.expires !== null && cookie.expires <= nowSec()) return false;
      if (!requestUrl) return true;
      const url = new URL(requestUrl);
      return domainMatches(cookie, url.hostname) && pathMatches(cookie.path, url.pathname);
    });
    return candidates.at(-1)?.value;
  }

  has(name: string, requestUrl?: string): boolean {
    return this.get(name, requestUrl) !== undefined;
  }

  /** Заголовок Cookie для запроса. */
  header(requestUrl: string): string {
    const url = new URL(requestUrl);
    const now = nowSec();
    const matches = [...this.cookies.values()]
      .filter((cookie) => {
        if (cookie.expires !== null && cookie.expires <= now) return false;
        if (cookie.secure && url.protocol !== "https:") return false;
        return domainMatches(cookie, url.hostname) && pathMatches(cookie.path, url.pathname);
      })
      .sort((a, b) => b.path.length - a.path.length);
    return matches.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  }

  toJSON(): Cookie[] {
    const now = nowSec();
    return [...this.cookies.values()].filter(
      (cookie) => cookie.expires === null || cookie.expires > now,
    );
  }

  static fromJSON(cookies: Cookie[]): CookieJar {
    const jar = new CookieJar();
    for (const cookie of cookies) {
      if (!cookie?.name || !cookie.domain) continue;
      jar.cookies.set(cookieKey(cookie), cookie);
    }
    return jar;
  }
}
