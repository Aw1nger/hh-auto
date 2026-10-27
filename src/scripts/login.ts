/**
 * Ручной вход на hh.ru в обычном окне Chromium.
 *
 * Запуск: `bun run login`
 *
 * Откроется браузер. Войди руками (телефон/почта + пароль, SMS, капча).
 * Скрипт сам заметит вход, сохранит cookies и OAuth-токен в data/.
 * После этого можно запускать бота: `bun run start`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { chromium } from "playwright";

import { loadConfig } from "../config";
import {
  ANDROID_UA,
  CLIENT_ID,
  CLIENT_SECRET,
  HH_BASE,
  REDIRECT_URI,
} from "../hh/constants";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const config = loadConfig();
mkdirSync(dirname(config.hhStatePath), { recursive: true });
mkdirSync(dirname(config.hhTokenPath), { recursive: true });

const browser = await chromium.launch({
  headless: false,
  channel: config.browserChannel || undefined,
  args: ["--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage"],
});

const contextOptions: Parameters<typeof browser.newContext>[0] = {
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  viewport: { width: 1200, height: 760 },
  locale: "ru-RU",
  timezoneId: "Europe/Moscow",
};
if (config.proxyUrl) contextOptions.proxy = { server: config.proxyUrl };

const context = await browser.newContext(contextOptions);
await context.addInitScript(`
  Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
  window.chrome = {runtime: {}};
`);
const page = await context.newPage();
await page.goto(`${HH_BASE}/account/login`, { waitUntil: "domcontentloaded" });

console.log("\n" + "=".repeat(60));
console.log("Открылось окно браузера на странице входа hh.ru.");
console.log("Залогинься руками (телефон + пароль, SMS, капча при необходимости).");
console.log("Скрипт сам поймает вход и сохранит cookies + OAuth-токен.");
console.log("=".repeat(60) + "\n");

let loggedIn = false;
for (let attempt = 0; attempt < 240; attempt += 1) {
  await sleep(3000);
  try {
    if (/\/account\/login/.test(page.url())) continue;
    if ((await page.locator('[data-qa="mainmenu_myResumes"]').count()) > 0) {
      loggedIn = true;
      break;
    }
    if ((await page.locator('[data-qa="mainmenu_applicantProfile"]').count()) > 0) {
      loggedIn = true;
      break;
    }
    if ((await page.locator('a[href*="/applicant/resumes"]').count()) > 0) {
      loggedIn = true;
      break;
    }
  } catch {
    // страница могла перезагружаться
  }
}

if (!loggedIn) {
  console.error("Не удалось дождаться входа. Запусти `bun run login` ещё раз.");
  await browser.close();
  process.exit(1);
}

await context.storageState({ path: config.hhStatePath });
console.log(`\n✅ Cookies сохранены: ${config.hhStatePath}`);

// Получаем OAuth-токен тем же способом, что и мобильное приложение.
let code: string | null = null;
page.on("request", (request) => {
  const match = /[?&]code=([^&\s]+)/.exec(request.url());
  if (match?.[1]) code ??= decodeURIComponent(match[1]);
});
page.on("response", (response) => {
  const match = /[?&]code=([^&\s]+)/.exec(response.url());
  if (match?.[1]) code ??= decodeURIComponent(match[1]);
});

const authorizeUrl =
  `${HH_BASE}/oauth/authorize?response_type=code` +
  `&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=cli`;

try {
  await page.goto(authorizeUrl, { waitUntil: "domcontentloaded", timeout: 40_000 });
} catch {
  // переход на hhandroid:// ожидаемо падает
}
await sleep(2500);

for (const selector of [
  '[data-qa="oauth-grant-allow"]',
  'button:has-text("Продолжить")',
  'button:has-text("Разрешить")',
  'button:has-text("Подтвердить")',
]) {
  const button = page.locator(selector).first();
  if ((await button.count()) > 0 && (await button.isVisible().catch(() => false))) {
    await button.click().catch(() => undefined);
    await sleep(2500);
    break;
  }
}

for (let attempt = 0; attempt < 10 && !code; attempt += 1) await sleep(1000);

if (code) {
  const response = await fetch(`${HH_BASE}/oauth/token`, {
    method: "POST",
    headers: {
      "User-Agent": ANDROID_UA,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      code,
    }),
  });
  const text = await response.text();
  if (response.status === 200) {
    const data = JSON.parse(text) as Record<string, unknown>;
    const token = {
      access_token: String(data.access_token),
      refresh_token: String(data.refresh_token ?? ""),
      expires_at: Date.now() / 1000 + Number(data.expires_in ?? 1_209_599),
    };
    writeFileSync(config.hhTokenPath, JSON.stringify(token, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    console.log(`✅ OAuth-токен сохранён: ${config.hhTokenPath}`);
  } else {
    console.error(`❌ Не удалось обменять OAuth-код (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }
} else {
  console.warn(
    "⚠️ OAuth-код не получен. Cookies сохранены — бот сможет работать через браузер, " +
      "но для API-откликов отправь /login в боте.",
  );
}

await context.storageState({ path: config.hhStatePath });
await sleep(1000);
await browser.close();
console.log("\nГотово. Запускай бота: bun run start\n");
