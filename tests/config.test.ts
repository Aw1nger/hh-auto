import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";

import { loadConfig, resolveDatabasePath, splitList } from "../src/config";

describe("config", () => {
  it("splits comma-separated lists", () => {
    expect(splitList(" a, b ,, c ")).toEqual(["a", "b", "c"]);
    expect(splitList("")).toEqual([]);
  });

  it("supports the old SQLAlchemy sqlite URL", () => {
    expect(
      resolveDatabasePath({
        DATABASE_URL: "sqlite+aiosqlite:///data/jobhunter.db",
      } as NodeJS.ProcessEnv),
    ).toBe(resolve("data/jobhunter.db"));
  });

  it("supports an absolute sqlite URL", () => {
    expect(
      resolveDatabasePath({
        DATABASE_URL: "sqlite:////tmp/hh-auto.db",
      } as NodeJS.ProcessEnv),
    ).toBe("/tmp/hh-auto.db");
  });

  it("parses booleans and numbers", () => {
    const config = loadConfig({
      TG_BOT_TOKEN: "token",
      TG_ADMIN_CHAT_ID: "123",
      APPLY_DELAY_MIN: "10",
      APPLY_DELAY_MAX: "20",
      BROWSER_HEADLESS: "false",
      CAPTCHA_ENABLED: "true",
      SEARCH_QUERIES_RAW: "performance, seo",
      } as NodeJS.ProcessEnv);
    expect(config.applyDelayMin).toBe(10);
    expect(config.applyDelayMax).toBe(20);
    expect(config.browserHeadless).toBe(false);
    expect(config.captchaEnabled).toBe(true);
    expect(config.searchQueries).toEqual(["performance", "seo"]);
  });

  it("falls back to desired position when search queries are empty", () => {
    const config = loadConfig({
      DESIRED_POSITION: "Маркетолог",
      SEARCH_QUERIES_RAW: "",
      } as NodeJS.ProcessEnv);
    expect(config.searchQueries).toEqual(["Маркетолог"]);
  });
});
