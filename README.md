# hh-auto

Telegram-бот автооткликов на **hh.ru**. Ищет вакансии, оценивает их по правилам,
откликается через официальный API hh и присылает капчу в Telegram **обычной
фотографией**.

Проект работает на **Bun + TypeScript**, данные хранит в SQLite.

> ⚠️ Автоматические отклики нарушают правила hh.ru — аккаунт могут ограничить.
> Держи разумный темп и используй на свой риск. Проект для личного использования.

---

## Возможности

- 🔍 Поиск вакансий на hh.ru каждые 5 минут, несколько страниц выдачи.
- 🎯 Оценка вакансий по правилам: заголовок, стек, зарплата, удалёнка, уровень.
- 📨 Отклики через официальный API hh (OAuth) — быстро, без открытия браузера.
- 🔐 Капча hh.ru приходит в Telegram фотографией: бот не распознаёт её сам,
  ты присылаешь текст, бот вводит его в Chromium.
- ✉️ Сопроводительное письмо из `.env` (поддерживает `{vacancy}` и `{company}`).
- 🧩 Анкеты и тесты работодателя — через Playwright.
- 💬 Приглашения и ответы работодателей — в Telegram.
- 📊 Статистика, логи откликов и сводка каждые 2 часа.
- ⬆️ Поднятие резюме, очистка откликов, чёрный список.
- ⚙️ Управление меню бота: пауза, автоотклики, тесты, уведомления, лимиты.

---

## Требования

- **Bun 1.1+** — `curl -fsSL https://bun.sh/install | bash`
- Аккаунт hh.ru с опубликованным резюме
- Telegram-бот ([@BotFather](https://t.me/BotFather)) и твой numeric id
  ([@userinfobot](https://t.me/userinfobot))
- Chromium для Playwright:
  ```bash
  bunx playwright install chromium
  ```

База — SQLite. Postgres, Redis и Docker не обязательны.

---

## Установка

```bash
git clone git@github.com:Aw1nger/hh-auto.git
cd hh-auto

bun install
bunx playwright install chromium

cp .env.example .env
# заполни .env
```

Минимум в `.env`:

```env
TG_BOT_TOKEN=...
TG_ADMIN_CHAT_ID=...
```

`HH_LOGIN` / `HH_PASSWORD` нужны только для входа по паролю.
`HH_RESUME_ID` можно не заполнять — бот возьмёт первое резюме из аккаунта.

---

## Настройка

Основные переменные `.env`:

| Переменная                                   | Назначение                             |
| -------------------------------------------- | -------------------------------------- |
| `TG_BOT_TOKEN`, `TG_ADMIN_CHAT_ID`           | Telegram-бот и админ                   |
| `TG_PROXY`, `TG_API_SERVER`                  | прокси / свой Bot API server           |
| `HH_LOGIN`, `HH_PASSWORD`                    | вход по паролю                         |
| `HH_RESUME_ID`                               | id резюме (пусто — первое из аккаунта) |
| `HH_USER_AGENT`                              | User-Agent для API hh.ru               |
| `HH_USER_AGENT_FALLBACK`                     | резервный UA, если hh запросит капчу   |
| `DESIRED_POSITION`, `DESIRED_SALARY_MIN/MAX` | профиль и зарплата                     |
| `SEARCH_QUERIES_RAW`                         | поисковые запросы через запятую        |
| `TARGET_KEYWORDS_RAW`                        | целевые слова заголовка                |
| `NEGATIVE_KEYWORDS_RAW`                      | стоп-слова заголовка                   |
| `STACK_KEYWORDS_RAW`                         | бонусные слова                         |
| `SALARY_FLOOR`                               | нижний порог зарплаты                  |
| `COVER_LETTER`                               | сопроводительное письмо                |
| `CHECK_INTERVAL_SEC`                         | интервал поиска                        |
| `APPLY_DELAY_MIN/MAX`                        | пауза между откликами                  |
| `MAX_APPLIES_PER_DAY_HH`                     | дневной лимит                          |
| `APPLY_MIN_SCORE_DAY/NIGHT`                  | порог score днём и ночью               |
| `BROWSER_HEADLESS`, `BROWSER_CHANNEL`        | Playwright                             |
| `PROXY_URL`                                  | прокси для hh и браузера               |
| `NOTIFY_HOUR_START/END`                      | тихие часы (МСК)                       |
| `DRY_RUN`                                    | только искать, не откликаться          |
| `LOG_LEVEL`                                  | `debug` / `info` / `warn` / `error`    |

---

## Вход на hh.ru

### Вручную в окне браузера

```bash
bun run login
```

Откроется Chromium. Войди руками (телефон/пароль, SMS, капча). Скрипт сохранит
cookies и OAuth-токен в `data/`.

### По коду в Telegram

В боте: `/login` → номер телефона → код из SMS/почты.
Бот сам обменяет код на OAuth-токен и сохранит сессию.

---

## Запуск

```bash
bun run start
```

Открой бота, отправь `/start` и включи автоотклики в «⚙️ Настройки».

Для разработки:

```bash
bun run dev        # watch-режим
bun test           # тесты
bun run typecheck  # проверка типов
```

---

## User-Agent

UA задаётся в `.env`, чтобы поведение было предсказуемым:

```env
HH_USER_AGENT="Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1"
HH_USER_AGENT_FALLBACK="ru.hh.android/7.131.23456, Device: QWERTY1234, Android OS: 14 (UUID: ...)"
```

- `HH_USER_AGENT` — основной UA для запросов к API hh.
- `HH_USER_AGENT_FALLBACK` — UA, на который бот один раз переключится, если hh
  запросит капчу на основной. Переключение происходит автоматически, без вопроса.
- Если оставить обе переменные пустыми, бот сгенерирует официальный Android UA.
- Если нужен только один UA — поставь `HH_USER_AGENT_FALLBACK` таким же, как
  `HH_USER_AGENT`.

---

## Капча

Когда hh просит капчу:

```
POST /negotiations
   │ 403 captcha_required
   ▼
Chromium открывает captcha_url
   ▼
Скриншот картинки → Telegram (фото)
   ▼
Ты присылаешь текст одним сообщением
   ▼
Бот вводит ответ в Chromium и нажимает «Отправить»
   ▼
Повтор POST /negotiations
```

- Бот **не распознаёт** капчу — только пересылает и отправляет твой ответ.
- Неверный ответ → новая картинка (до `CAPTCHA_MAX_ATTEMPTS`).
- Нет ответа за `CAPTCHA_TIMEOUT_SEC` → цикл откликов останавливается.
- Если капча так и не решена, автоотклики **приостанавливаются**, а в Telegram
  приходит кнопка **«▶️ Продолжить автоотклики»**. Та же кнопка есть в
  «⚙️ Настройки».
- `/cancel_captcha` — отменить ввод.
- Отвечать может только `TG_ADMIN_CHAT_ID`.

| Переменная                 | По умолчанию | Смысл                        |
| -------------------------- | ------------ | ---------------------------- |
| `CAPTCHA_ENABLED`          | `true`       | включить приём капчи         |
| `CAPTCHA_TIMEOUT_SEC`      | `300`        | сколько ждать ответ          |
| `CAPTCHA_MAX_ATTEMPTS`     | `3`          | попыток на одну капчу        |
| `CAPTCHA_LANG`             | `RU`         | язык картинки HTTP-fallback  |
| `CAPTCHA_SUBMIT_DELAY_SEC` | `10`         | пауза перед отправкой ответа |
| `CAPTCHA_COOLDOWN_SEC`     | `30`         | пауза после решения          |

> Если Telegram недоступен или фото не отправилось, картинка сохранится в
> `data/captcha/`, а в лог попадёт путь и ссылка.

---

## Команды бота

| Команда                                             | Действие              |
| --------------------------------------------------- | --------------------- |
| `/start`                                            | меню                  |
| `/stats`                                            | статистика            |
| `/vacancies`                                        | вакансии              |
| `/top`                                              | топ по score          |
| `/messages`                                         | приглашения и статусы |
| `/settings`                                         | настройки             |
| `/logs`                                             | последние отклики     |
| `/pause`, `/resume`                                 | пауза / продолжить    |
| `/login`                                            | вход на hh по коду    |
| `/cancel`                                           | отменить вход         |
| `/cancel_captcha`                                   | отменить капчу        |
| `/bump`                                             | поднять резюме        |
| `/clear_neg`                                        | очистка откликов      |
| `/test_apply 5`                                     | тестовые отклики      |
| `/health`                                           | проверить сессию      |
| `/blacklist [company\|keyword\|vacancy] <значение>` | чёрный список         |

Кнопки главного меню дублируют команды. Автоотклики по умолчанию **выключены**.

---

## Как устроено

```
src/
  index.ts              запуск и graceful shutdown
  config.ts             .env
  db.ts                 SQLite (bun:sqlite)
  scoring.ts            rule-based оценка вакансий
  scheduler.ts          фоновые задачи
  notifier.ts           Telegram + ожидание ответа на капчу
  hh/
    oauth.ts            API hh: отклики, статусы, резюме, UA
    captcha.ts          HTTP-fallback решения капчи
    playwright.ts       Chromium: капча, анкеты, чат
    search.ts           парсинг выдачи hh
    browser.ts          менеджер Playwright
    login.ts            вход по коду
  workers/
    vacancy.ts          поиск и анализ
    apply.ts            отклики
    messages.ts         статусы и сообщения
  bot/
    bot.ts              меню, команды, приём капчи
    keyboards.ts        клавиатуры
  scripts/login.ts      ручной вход в браузере
tests/                  bun test
```

- **API hh** — основной путь отклика.
- **Playwright** — капча, анкеты, вход по коду.
- **SQLite** — вакансии, отклики, сообщения; состояние планировщика и токен — в `data/`.

---

## Данные

- `data/jobhunter.db` — база.
- `data/hh_oauth_token.json` — OAuth-токен.
- `data/browser_sessions/hh_state.json` — cookies Playwright.
- `data/scheduler_state.json` — пауза, флаги, лимиты.
- `data/captcha_cookies.json` — cookies HTTP-fallback капчи.

`data/` и `.env` игнорируются git. Секреты никуда не отправляются.

---

## Docker

```bash
docker compose up -d --build
```

`docker-compose.yml` монтирует `./data` и читает `.env`.
Chromium внутри контейнера требует `shm_size: "1gb"` — уже задано.

---

## Частые проблемы

**Капча не приходит в Telegram.**
Проверь `TG_BOT_TOKEN`, `TG_ADMIN_CHAT_ID`, отправь боту `/start`.
В логах: `captcha_sent_to_telegram` или `captcha_send_failed`.

**hh просит капчу часто.**
Реши одну капчу и подожди 10–15 минут. Уменьши
`MAX_APPLIES_PER_DAY_HH` и увеличь `APPLY_DELAY_MIN/MAX`.

**`Playwright not available` / `browser_start_failed`.**
`bunx playwright install chromium`. Без браузера API работает, но капча
решается HTTP-fallback'ом и может запрашиваться чаще.

**`no_resume_id`.**
Нет опубликованного резюме на hh.ru. Опубликуй или укажи `HH_RESUME_ID`.

**`daily_limit`.**
Дневной лимит hh или твой `MAX_APPLIES_PER_DAY_HH`. Жди следующий день.

**`409 Conflict` в Telegram.**
С тем же токеном запущен другой бот. Останови лишнюю копию.

**Telegram заблокирован.**
`TG_PROXY` или локальный Bot API server через `TG_API_SERVER`.

---

## Форк

Проект является форком
[YAMAKAYAMACO/hh-autoresponder](https://github.com/YAMAKAYAMACO/hh-autoresponder).
