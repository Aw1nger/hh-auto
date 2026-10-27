import { describe, expect, it } from "bun:test";

import {
  CookieJar,
  parseSetCookie,
  splitSetCookieHeader,
} from "../src/utils/cookies";

describe("cookies", () => {
  it("parses Set-Cookie with attributes", () => {
    const cookie = parseSetCookie(
      "_xsrf=abc123; Domain=hh.ru; Path=/; SameSite=lax; Secure; HttpOnly",
      "https://ryazan.hh.ru/account/captcha?state=x",
    );
    expect(cookie).not.toBeNull();
    expect(cookie?.name).toBe("_xsrf");
    expect(cookie?.value).toBe("abc123");
    expect(cookie?.domain).toBe("hh.ru");
    expect(cookie?.hostOnly).toBe(false);
    expect(cookie?.secure).toBe(true);
    expect(cookie?.httpOnly).toBe(true);
  });

  it("matches cookies for subdomains", () => {
    const jar = new CookieJar();
    jar.setCookie("hhtoken=token; Domain=.hh.ru; Path=/", "https://hh.ru/");
    expect(jar.get("hhtoken", "https://ryazan.hh.ru/vacancy/1")).toBe("token");
    expect(jar.get("hhtoken", "https://example.com/")).toBeUndefined();
  });

  it("does not return expired cookies", () => {
    const jar = new CookieJar();
    jar.setCookie("old=1; Max-Age=0; Path=/", "https://hh.ru/");
    expect(jar.get("old", "https://hh.ru/")).toBeUndefined();
  });

  it("builds a Cookie header with the most specific path first", () => {
    const jar = new CookieJar();
    jar.setCookie("a=1; Path=/", "https://hh.ru/");
    jar.setCookie("b=2; Path=/account", "https://hh.ru/");
    const header = jar.header("https://hh.ru/account/captcha");
    expect(header).toContain("a=1");
    expect(header).toContain("b=2");
    expect(header.indexOf("b=2")).toBeLessThan(header.indexOf("a=1"));
  });

  it("splits combined Set-Cookie headers without breaking Expires", () => {
    const raw =
      "a=1; Expires=Wed, 27 Oct 2026 17:11:44 GMT; Path=/, b=2; Path=/account";
    expect(splitSetCookieHeader(raw)).toEqual([
      "a=1; Expires=Wed, 27 Oct 2026 17:11:44 GMT; Path=/",
      "b=2; Path=/account",
    ]);
  });
});
