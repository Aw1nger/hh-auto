/** Общий контекст приложения, который прокидывается в воркеры и бота. */
import type { Config } from "./config";
import type { Store } from "./db";
import type { BrowserManager } from "./hh/browser";
import type { HHCaptchaSolver } from "./hh/captcha";
import type { HHPlaywright } from "./hh/playwright";
import type { HHOAuthClient } from "./hh/oauth";
import type { HHParser } from "./hh/search";
import type { Notifier } from "./notifier";
import type { SchedulerState } from "./state";

export interface AppContext {
  config: Config;
  db: Store;
  oauth: HHOAuthClient;
  parser: HHParser;
  captcha: HHCaptchaSolver;
  browser: BrowserManager;
  playwright: HHPlaywright;
  state: SchedulerState;
  notifier: Notifier;
}
