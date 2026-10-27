# hh-autoresponder

Telegram-бот автооткликов на вакансии **hh.ru**. Переписан на **Bun + TypeScript**.
Главное отличие от старой версии — **капча hh.ru приходит прямо в Telegram**:
бот присылает картинку, ты отвечаешь текстом, отклик продолжается.

[![Bun](https://img.shields.io/badge/Bun-1.1%2B-black?style=flat-square&logo=bun)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![License](https://img.shields.io/badge/License-MIT-22c55e?style=flat-square)](LICENSE)

> ⚠️ **Дисклеймер.** Автоматические отклики нарушают правила hh.ru, аккаунт могут
> ограничить. Держи разумные лимиты и используй на свой риск. Проект — для личного
> использования.

---

## Возможности

- 🔍 Каждые 5 минут ищет вакансии на hh.ru по твоим запросам (пагинация, несколько страниц).
- 🎯 Оценивает вакансии по правилам (заголовок, стек, зарплата, удалёнка, уровень) — быстро и без внешних API.
- 📨 Откликается через официальный API hh.ru (OAuth Android-приложения) — быстро и без браузера.
- 🔐 **Ловит `captcha_required` и присылает капчу в Telegram** — картинкой, ответ принимает текстом.
- ✉️ Отправляет сопроводительное письмо из `.env` (поддерживает `{vacancy}` и `{company}`).
- 🧩 Если у вакансии анкета/тест — добивает её через Playwright (нейтральными ответами).
- 💬 Присылает приглашения и реальные ответы работодателей, отсекая шум.
- 📊 Считает статусы откликов, присылает сводку каждые 2 часа.
- ⬆️ Поднимает резюме в поиске hh.ru.
- 🧹 Чистит отклики (отказы / старше N дней) через API.
- 📱 Управление через меню Telegram: пауза, автоотклики, статистика, логи, ЧС.

---

## Требования

- **Bun 1.1+** (`curl -fsSL https://bun.sh/install | bash`)
- Аккаунт hh.ru с опубликованным резюме
- Телеграм-бот (токен из [@BotFather](https://t.me/BotFather)) и твой numeric id
  из [@userinfobot](https://t.me/userinfobot)
- Chromium для Playwright — рекомендуется: через него идут капча и API-запросы
  (стабильнее и меньше капчи), а также анкеты и вход:
  `bunx playwright install chromium`

База — SQLite (файл), ничего кроме Bun ставить не нужно.

---

## Установка

```bash
git clone https://github.com/YAMAKAYAMACO/hh-autoresponder.git
cd hh-autoresponder

bun install
bunx playwright install chromium   # капча/API через браузер + анкеты + /login

cp .env.example .env
# открой .env и заполни TG_BOT_TOKEN, TG_ADMIN_CHAT_ID
```

Обязательный минимум в `.env`:

| Переменная | Что это |
|---|---|
| `TG_BOT_TOKEN` | токен бота из @BotFather |
| `TG_ADMIN_CHAT_ID` | твой числовой Telegram id |
| `HH_LOGIN` / `HH_PASSWORD` | нужны только для входа по паролю; можно войти по коду |

`HH_RESUME_ID` можно не заполнять — бот возьмёт первое резюме из аккаунта.

---

## Вход на hh.ru

Есть два способа.

### 1. Ручной вход в окне браузера (проще)

```bash
bun run login
```

Откроется Chromium. Войди руками (телефон/пароль, SMS, капча — всё в окне).
Скрипт сам сохранит cookies и OAuth-токен в `data/`.

### 2. Вход по коду прямо в Telegram

В боте: `/login` → пришли номер телефона → hh пришлёт код → пришли код боту.
Бот сам получит OAuth-токен и сохранит браузерную сессию.

---

## Запуск

```bash
bun run start
```

Дальше всё — через меню бота в Telegram. Пока процесс запущен, бот ищет вакансии
и откликается. Автозапуск при старте системы настраивается штатными средствами ОС
(systemd / launchd / Планировщик задач).

Для разработки:

```bash
bun run dev       # watch-режим
bun test          # тесты
bun run typecheck # проверка типов
```

---

## 🔐 Капча hh.ru — как это работает

hh.ru иногда отвечает на запрос отклика так:

```json
{
  "errors": [{
    "value": "captcha_required",
    "type": "captcha_required",
    "captcha_url": "https://hh.ru/account/captcha?state=..."
  }],
  "request_id": "..."
}
```

Раньше бот просто писал `hh_oauth_failed` и терял отклик. Теперь:

```
POST /negotiations (случайный официальный UA) → обычно без капчи
        │
        ├─ если всё-таки 403 captcha_required
        ▼
Открываем captcha_url в Chromium → фото в Telegram
        │
        ▼
Ты присылаешь текст с картинки одним сообщением
        │
        ▼
Вводим ответ и нажимаем «Отправить» в браузере
        │
        ▼
Повторяем POST /negotiations с тем же случайным UA
```

### Почему капча просилась на каждый отклик

Главная причина — **фиксированный User-Agent** старой версии:

`ru.hh.android/8.116 (Android 13; samsung SM-S908B)`

Это публичная, много раз скопированная строка. hh.ru/DDoS Guard помечает её как
подозрительную и требует капчу почти на каждый `POST /negotiations`. При этом
ответ на капчу отправлялся отдельным HTTP-клиентом, а не тем, который вызвал
капчу — поэтому решение могло не засчитываться и капча возвращалась снова.

Что изменено:

- Каждый экземпляр API-клиента генерирует **случайный UA в официальном формате**
  Android-приложения hh:
  `ru.hh.android/7.x.y, Device: XXXXXXXXXX, Android OS: 13 (UUID: ...)`.
- К API-запросам добавлены заголовки официального приложения
  `X-Force-App-Access: true` и `X-HH-App-Active: true`.
- Проверка на живом API: три `POST /negotiations` подряд с новым UA вернули
  `400 Vacancy not found` (тестовая несуществующая вакансия) и **ни одной капчи**.
  С прежним фиксированным UA тот же запрос стабильно давал `403 captcha_required`.
- Если капча всё же появилась, она решается в Chromium, а повторный API-запрос
  идёт с тем же случайным UA после паузы `CAPTCHA_COOLDOWN_SEC`.
- Ответ на капчу проверяется по тексту «Неверный текст» и по редиректу на
  `hh://applicant/captchaSuccessBackUrl`, а не только по HTTP-коду.
- Неверный ответ больше не считается успехом: бот сразу покажет новую картинку.

Важные детали:

- Картинка отправляется **обычной фотографией** — её видно сразу, можно зумить.
- Ответ принимается **одним сообщением**. Команда `/cancel_captcha` отменяет ввод.
- Если ответ неверный — hh снова просит капчу, бот присылает **новую картинку**
  (до `CAPTCHA_MAX_ATTEMPTS` раз).
- Если капча не решена за `CAPTCHA_TIMEOUT_SEC` — текущий цикл откликов
  останавливается, чтобы не долбить hh, и тебе приходит уведомление.
- Если Chromium не установлен (`bunx playwright install chromium`), бот
  работает в API-only режиме: капча решается через HTTP fallback и может
  запрашиваться чаще.
- Отвечать на капчу может только `TG_ADMIN_CHAT_ID`.

Настройки:

| Переменная | По умолчанию | Смысл |
|---|---|---|
| `CAPTCHA_ENABLED` | `true` | выключить приём капчи |
| `CAPTCHA_TIMEOUT_SEC` | `300` | сколько ждать ответ |
| `CAPTCHA_MAX_ATTEMPTS` | `3` | сколько раз показывать новую картинку |
| `CAPTCHA_LANG` | `RU` | язык картинки (`RU`/`EN`) |
| `CAPTCHA_SUBMIT_DELAY_SEC` | `10` | пауза перед отправкой ответа hh |
| `CAPTCHA_COOLDOWN_SEC` | `30` | пауза между запросами капчи |

> Если Telegram не настроен или картинку не удалось отправить, бот сохранит её в
> `data/captcha/` и напишет путь + ссылку в лог.

---

## Команды бота

| Команда | Что делает |
|---|---|
| `/start` | меню |
| `/stats` | статистика |
| `/vacancies` | список вакансий |
| `/top` | топ вакансии по score |
| `/messages` | приглашения и статусы откликов |
| `/settings` | настройки и переключатели |
| `/logs` | последние отклики |
| `/pause`, `/resume` | пауза / продолжить |
| `/login` | вход на hh по коду |
| `/cancel` | отменить вход |
| `/cancel_captcha` | отменить ввод капчи |
| `/bump` | поднять резюме |
| `/clear_neg` | очистка откликов |
| `/test_apply 5` | тестовые отклики с логом |
| `/health` | проверить сессию hh |
| `/thanks` | поблагодарить за отказы (экспериментально) |
| `/blacklist [company\|keyword\|vacancy] <значение>` | чёрный список |

Кнопки главного меню дублируют команды. Автоотклики по умолчанию **выключены** —
включи «⚪ Авто-отклик ВЫКЛ» в настройках.

---

## Как это устроено

```
src/
  index.ts              точка входа, graceful shutdown
  config.ts             .env (совместим со старой Python-версией)
  db.ts                 SQLite на bun:sqlite (+ миграция старой базы)
  scoring.ts            rule-based оценка вакансий
  scheduler.ts          фоновые задачи вместо APScheduler
  notifier.ts           Telegram-уведомления + ожидание ответа на капчу
  hh/
    constants.ts        credentials Android-приложения hh
    captcha.ts          HTTP-решение капчи (без браузера)
    oauth.ts            API hh: отклики, статусы, резюме, очистка
    search.ts           парсинг HTML-выдачи hh (cheerio)
    browser.ts          Playwright-менеджер
    playwright.ts       анкеты/тесты, fallback-отклик, чат
    login.ts            вход по коду (телефон → SMS → токен)
  workers/
    vacancy.ts          поиск + анализ
    apply.ts            автоотклики
    messages.ts         статусы/сообщения
  bot/
    bot.ts              меню, команды, приём капчи
    keyboards.ts        клавиатуры
  scripts/login.ts      ручной вход в окне браузера
tests/                  unit-тесты (bun test)
```

Ключевые решения:

- **OAuth API вместо браузера** для откликов — ~1 сек на отклик и нет DDoS Guard.
- **Playwright для капчи** — решение в реальном Chromium, плюс анкеты, тесты и вход по коду. API-отклики идут с случайным официальным UA.
- **Капча решается через HTTP + Telegram** — не нужен ни VNC, ни GUI на сервере.
- **SQLite + JSON-состояние** — без Postgres/Redis/Docker.

---

## Совместимость со старой Python-версией

Можно взять существующие `data/`:

- `data/jobhunter.db` — схема читается, при старте статусы `NEW`/`SENT` приводятся
  к нижнему регистру, а таймстампы — к ISO.
- `data/hh_oauth_token.json` — формат тот же.
- `data/browser_sessions/hh_state.json` — Playwright storage state, формат тот же.
- `data/scheduler_state.json` — ключи те же.

Старые Python-файлы в репозитории удалены; история доступна в git.

---

## Docker (опционально)

```bash
docker compose up -d --build
```

`docker-compose.yml` монтирует `./data` и читает `.env`.

---

## Частые проблемы

**Капча не приходит в Telegram.**
Проверь `TG_BOT_TOKEN`, `TG_ADMIN_CHAT_ID`, напиши боту `/start`. В логах должно быть
`captcha_sent_to_telegram`. Если Telegram недоступен, картинка сохранится в
`data/captcha/`.

**`hh_oauth_failed: captcha_required` в логах.**
Это ожидаемо: бот сейчас пришлёт капчу в Telegram. Если сообщение не пришло —
смотри логи `captcha_required` / `captcha_send_failed`.

**`captcha_failed` / капча не принимается.**
hh может не засчитывать ответы, если IP/UA давно «засветился». Подожди 10–15 минут,
не долби отклики, попробуй снова. Помогает смена IP/прокси (`PROXY_URL`).

**`Playwright not available` / `browser_start_failed`.**
`bunx playwright install chromium`. Без браузера бот работает в API-only режиме,
но капча решается HTTP-fallback'ом и может запрашиваться чаще.

**`no_resume_id`.**
На hh.ru нет опубликованного резюме. Опубликуй и повтори; либо укажи `HH_RESUME_ID`.

**`daily_limit`.**
Достигнут дневной лимит hh (или твой `MAX_APPLIES_PER_DAY_HH`). Жди следующего дня.

**Telegram не работает из страны блокировки.**
Укажи `TG_PROXY` или `TG_API_SERVER`. Прокси зависит от версии Bun; если не
работает — подними локальный Bot API server и укажи `TG_API_SERVER`.

---

## Лицензия

[MIT](LICENSE) © Nikita Vikhrov

Проект — форк [YAMAKAYAMACO/hh-autoresponder](https://github.com/YAMAKAYAMACO/hh-autoresponder),
переписанный на Bun + TypeScript.
