/**
 * HTTP-сервер панели управления hh-auto (порт 3000).
 *
 * Предоставляет веб-дашборд со статистикой откликов, статусом бота,
 * логом последних вакансий и кнопками ручного запуска задач.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AppContext } from "./context";
import { log } from "./logger";
import type { WorkerScheduler } from "./scheduler";
import { runVacancyAnalysis } from "./workers/vacancy";

export interface ServerOptions {
  ctx: AppContext;
  scheduler?: WorkerScheduler;
  botConfigured: boolean;
  port?: number;
  host?: string;
}

export function startDashboardServer(options: ServerOptions) {
  const { ctx, scheduler, botConfigured } = options;
  const port = options.port ?? 3000;
  const host = options.host ?? "0.0.0.0";

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // CORS & common headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      if (url.pathname === "/api/stats") {
        const stats = ctx.db.getStats();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            stats,
            botConfigured,
            isPaused: scheduler?.isPaused ?? false,
            autoApply: scheduler?.autoApply ?? false,
            autoApplyPaused: scheduler?.autoApplyPaused ?? false,
            autoApplyPausedReason: scheduler?.autoApplyPausedReason,
            browserAvailable: ctx.browser.isAvailable(),
            dryRun: ctx.config.dryRun,
          }),
        );
        return;
      }

      if (url.pathname === "/api/recent") {
        const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 15));
        const recent = ctx.db.getRecentApplications(limit);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(recent));
        return;
      }

      if (req.method === "POST") {
        if (url.pathname === "/api/search") {
          if (!scheduler) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Планировщик ещё не инициализирован" }));
            return;
          }
          try {
            const count = await scheduler.forceSearch();
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, count }));
          } catch (err) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
          }
          return;
        }

        if (url.pathname === "/api/analyze") {
          try {
            const count = await runVacancyAnalysis(ctx);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, count }));
          } catch (err) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
          }
          return;
        }

        if (url.pathname === "/api/apply") {
          if (!scheduler) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Планировщик ещё не инициализирован" }));
            return;
          }
          try {
            const count = await scheduler.forceApply();
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, count }));
          } catch (err) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
          }
          return;
        }

        if (url.pathname === "/api/toggle-pause") {
          if (!scheduler) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Планировщик не активен" }));
            return;
          }
          if (scheduler.isPaused) {
            scheduler.resume();
          } else {
            scheduler.pause();
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, isPaused: scheduler.isPaused }));
          return;
        }

        if (url.pathname === "/api/toggle-auto-apply") {
          if (!scheduler) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Планировщик не активен" }));
            return;
          }
          const next = !scheduler.autoApply;
          scheduler.setAutoApply(next);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, autoApply: scheduler.autoApply }));
          return;
        }
      }

      // Default: HTML Web Dashboard
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderDashboardHtml(ctx, botConfigured, scheduler));
    } catch (error) {
      log.error("server_request_error", {
        path: url.pathname,
        error: error instanceof Error ? error.message : error,
      });
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Internal Server Error");
    }
  });

  server.listen(port, host, () => {
    log.info("dashboard_server_listening", { port, host });
    console.log(`🌐 Панель управления hh-auto доступна на http://${host}:${port}`);
  });

  return server;
}

function renderDashboardHtml(
  ctx: AppContext,
  botConfigured: boolean,
  scheduler?: WorkerScheduler,
): string {
  const stats = ctx.db.getStats();
  const recent = ctx.db.getRecentApplications(10);
  const cfg = ctx.config;

  const statusColor = !botConfigured ? "#f59e0b" : cfg.dryRun ? "#3b82f6" : "#10b981";
  const statusText = !botConfigured
    ? "🟡 Ожидает токен Telegram"
    : cfg.dryRun
      ? "🧪 DRY_RUN (Тестовый режим)"
      : "🟢 Бот активен и запущен";

  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>hh-auto — Автоотклики на hh.ru</title>
  <style>
    :root {
      --bg: #0f172a;
      --card: #1e293b;
      --border: #334155;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --accent: #38bdf8;
      --accent-hover: #0284c7;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background: var(--bg); color: var(--text); padding: 24px 16px; min-height: 100vh; }
    .container { max-width: 1100px; margin: 0 auto; }
    header { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 16px; padding-bottom: 24px; border-bottom: 1px solid var(--border); margin-bottom: 24px; }
    .title-group h1 { font-size: 24px; font-weight: 700; display: flex; align-items: center; gap: 10px; }
    .title-group p { font-size: 14px; color: var(--text-muted); margin-top: 4px; }
    .status-badge { display: inline-flex; align-items: center; gap: 6px; padding: 6px 14px; border-radius: 9999px; background: rgba(255,255,255,0.06); border: 1px solid var(--border); font-size: 13px; font-weight: 500; }
    
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 18px; }
    .card-label { font-size: 13px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; }
    .card-value { font-size: 28px; font-weight: 700; margin-top: 6px; }
    .card-sub { font-size: 12px; color: var(--text-muted); margin-top: 4px; }

    .actions-card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px; margin-bottom: 24px; }
    .actions-title { font-size: 16px; font-weight: 600; margin-bottom: 14px; }
    .btn-group { display: flex; flex-wrap: wrap; gap: 10px; }
    button { background: var(--accent); color: #0f172a; border: none; border-radius: 8px; padding: 10px 18px; font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.15s ease; display: inline-flex; align-items: center; gap: 6px; }
    button:hover { background: var(--accent-hover); color: #fff; }
    button.secondary { background: rgba(255,255,255,0.08); color: var(--text); border: 1px solid var(--border); }
    button.secondary:hover { background: rgba(255,255,255,0.15); }
    button:disabled { opacity: 0.5; cursor: not-allowed; }

    .section-title { font-size: 18px; font-weight: 600; margin-bottom: 14px; }
    .table-container { overflow-x: auto; background: var(--card); border: 1px solid var(--border); border-radius: 12px; margin-bottom: 24px; }
    table { width: 100%; border-collapse: collapse; text-align: left; font-size: 14px; }
    th { padding: 12px 16px; background: rgba(0,0,0,0.2); color: var(--text-muted); font-size: 12px; text-transform: uppercase; font-weight: 600; }
    td { padding: 12px 16px; border-top: 1px solid var(--border); }
    tr:hover { background: rgba(255,255,255,0.02); }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .pill { display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 600; }
    .pill-sent { background: rgba(16,185,129,0.2); color: #34d399; }
    .pill-failed { background: rgba(239,68,68,0.2); color: #f87171; }
    .pill-pending { background: rgba(245,158,11,0.2); color: #fbbf24; }

    .toast { position: fixed; bottom: 20px; right: 20px; background: #0284c7; color: #fff; padding: 12px 20px; border-radius: 8px; font-size: 14px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); display: none; z-index: 100; }
    .config-box { font-size: 13px; line-height: 1.6; color: var(--text-muted); }
    .config-box code { color: #38bdf8; background: rgba(0,0,0,0.3); padding: 2px 6px; border-radius: 4px; font-size: 12px; }
    .alert-box { background: rgba(245,158,11,0.1); border: 1px solid rgba(245,158,11,0.3); border-radius: 10px; padding: 16px; margin-bottom: 24px; color: #fde68a; font-size: 14px; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="title-group">
        <h1>🚀 hh-auto <span style="font-size: 14px; font-weight: 400; color: var(--text-muted)">v2.0</span></h1>
        <p>Автоматизированный поиск, скоринг и отправка откликов на hh.ru</p>
      </div>
      <div class="status-badge" style="border-color: ${statusColor}">
        ${statusText}
      </div>
    </header>

    ${
      !botConfigured
        ? `<div class="alert-box">
          <b>ℹ️ Бот готов к работе в режиме дашборда.</b><br />
          Для запуска Telegram-бота и фоновых автооткликов укажите <code>TG_BOT_TOKEN</code> и <code>TG_ADMIN_CHAT_ID</code> в файле <code>.env</code>. Вы также можете вручную вызывать поиск и анализ через кнопки ниже.
        </div>`
        : ""
    }

    <!-- KPI Grid -->
    <div class="grid">
      <div class="card">
        <div class="card-label">Откликов сегодня</div>
        <div class="card-value" id="kpi-sent">${stats.sentToday} <span style="font-size: 16px; color: var(--text-muted)">/ ${cfg.maxAppliesPerDay}</span></div>
        <div class="card-sub">Всего отправлено: <span id="kpi-total-sent">${stats.sentTotal}</span></div>
      </div>
      <div class="card">
        <div class="card-label">Ошибок сегодня</div>
        <div class="card-value" style="color: ${stats.failedToday > 0 ? "var(--danger)" : "var(--text)"}" id="kpi-failed">${stats.failedToday}</div>
        <div class="card-sub">Лимиты или капчи</div>
      </div>
      <div class="card">
        <div class="card-label">Вакансий в базе</div>
        <div class="card-value" id="kpi-vacancies">${stats.totalVacancies}</div>
        <div class="card-sub">Новых: <span id="kpi-new">${stats.newVacancies}</span> · Одобрено: <span id="kpi-approved">${stats.approvedVacancies}</span></div>
      </div>
      <div class="card">
        <div class="card-label">Средний score</div>
        <div class="card-value" id="kpi-score">${stats.avgScore !== null ? Math.round(stats.avgScore) + "%" : "—"}</div>
        <div class="card-sub">Порог отклика: ${cfg.applyMinScoreDay}% (день) / ${cfg.applyMinScoreNight}% (ночь)</div>
      </div>
      <div class="card">
        <div class="card-label">Ответы работодателей</div>
        <div class="card-value" id="kpi-messages">${stats.messages}</div>
        <div class="card-sub">Новых сообщений в чатах</div>
      </div>
    </div>

    <!-- Actions Control Panel -->
    <div class="actions-card">
      <div class="actions-title">⚡ Ручное управление задачами</div>
      <div class="btn-group">
        <button id="btn-search" onclick="runAction('/api/search', 'Поиск вакансий запущен...')">🔍 Запустить поиск сейчас</button>
        <button id="btn-analyze" class="secondary" onclick="runAction('/api/analyze', 'Анализ и скоринг запущены...')">🧠 Запустить анализ</button>
        <button id="btn-apply" class="secondary" onclick="runAction('/api/apply', 'Цикл откликов запущен...')">🚀 Запустить автоотклик</button>
        <button id="btn-pause" class="secondary" onclick="runAction('/api/toggle-pause', 'Статус паузы изменён')">
          ${scheduler?.isPaused ? "▶️ Возобновить планировщик" : "⏸ Пауза планировщика"}
        </button>
        <button id="btn-auto-apply" class="secondary" onclick="runAction('/api/toggle-auto-apply', 'Режим автоотклика переключен')">
          ${scheduler?.autoApply ? "⚡ Автоотклики: ВКЛ" : "💤 Автоотклики: ВЫКЛ"}
        </button>
      </div>
    </div>

    <!-- Configuration overview -->
    <div class="actions-card">
      <div class="actions-title">⚙️ Текущая конфигурация поиска и скоринга</div>
      <div class="config-box">
        <p>• <b>Целевая позиция:</b> ${cfg.desiredPosition}</p>
        <p>• <b>Поисковые запросы:</b> <code>${cfg.searchQueries.join("</code>, <code>")}</code></p>
        <p>• <b>Сортировка hh.ru:</b> <code>order_by=publication_time</code> (первыми идут свежие вакансии по времени публикации)</p>
        <p>• <b>Интервал проверки:</b> каждые ${Math.round(cfg.checkIntervalSec / 60)} мин</p>
        <p>• <b>Желаемая вилка:</b> ${cfg.desiredSalaryMin.toLocaleString("ru-RU")} – ${cfg.desiredSalaryMax.toLocaleString("ru-RU")} ₽</p>
        <p>• <b>Браузер (Playwright):</b> ${ctx.browser.isAvailable() ? "✅ Доступен (анкеты с тестами поддерживаются)" : "⚠️ API-only"}</p>
        <p>• <b>Капча:</b> ${cfg.captchaEnabled ? "Включена (уведомление в Telegram)" : "Выключена"}</p>
      </div>
    </div>

    <!-- Recent applications -->
    <div class="section-title">📋 Последние отклики и кандидаты</div>
    <div class="table-container">
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Вакансия</th>
            <th>Платформа</th>
            <th>Статус</th>
            <th>Дата</th>
          </tr>
        </thead>
        <tbody id="recent-body">
          ${
            recent.length === 0
              ? '<tr><td colspan="5" style="text-align:center; color: var(--text-muted); padding: 24px;">Пока нет зарегистрированных откликов. Запустите поиск вакансий кнопкой выше!</td></tr>'
              : recent
                  .map(
                    (app) => `<tr>
              <td>#${app.id}</td>
              <td>
                <a href="${app.vacancyUrl ?? "#"}" target="_blank" rel="noopener">${escapeHtml(app.vacancyTitle ?? "Вакансия")}</a>
              </td>
              <td>${app.platform}</td>
              <td><span class="pill pill-${app.status}">${app.status}</span></td>
              <td style="color: var(--text-muted); font-size: 12px;">${formatDate(app.createdAt)}</td>
            </tr>`,
                  )
                  .join("")
          }
        </tbody>
      </table>
    </div>
  </div>

  <div id="toast" class="toast"></div>

  <script>
    function showToast(text) {
      const t = document.getElementById('toast');
      t.innerText = text;
      t.style.display = 'block';
      setTimeout(() => { t.style.display = 'none'; }, 4000);
    }

    async function runAction(endpoint, msg) {
      showToast(msg);
      try {
        const res = await fetch(endpoint, { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
          showToast('Успешно выполнено! Результат: ' + JSON.stringify(data));
          refreshStats();
        } else {
          showToast('Ошибка: ' + (data.error || 'не удалось выполнить'));
        }
      } catch (err) {
        showToast('Ошибка запроса: ' + err.message);
      }
    }

    async function refreshStats() {
      try {
        const res = await fetch('/api/stats');
        const data = await res.json();
        if (data.stats) {
          const s = data.stats;
          document.getElementById('kpi-sent').innerHTML = s.sentToday + ' <span style="font-size: 16px; color: var(--text-muted)">/ ${cfg.maxAppliesPerDay}</span>';
          document.getElementById('kpi-total-sent').innerText = s.sentTotal;
          document.getElementById('kpi-failed').innerText = s.failedToday;
          document.getElementById('kpi-vacancies').innerText = s.totalVacancies;
          document.getElementById('kpi-new').innerText = s.newVacancies;
          document.getElementById('kpi-approved').innerText = s.approvedVacancies;
          document.getElementById('kpi-score').innerText = s.avgScore !== null ? Math.round(s.avgScore) + '%' : '—';
          document.getElementById('kpi-messages').innerText = s.messages;
        }
      } catch {}
    }

    setInterval(refreshStats, 10000);
  </script>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatDate(iso: string): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString("ru-RU", { timeZone: "Europe/Moscow" });
  } catch {
    return iso;
  }
}
