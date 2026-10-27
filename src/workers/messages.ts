/** Воркер сообщений и статусов откликов. */
import type { AppContext } from "../context";
import { log } from "../logger";
import { escapeHtml, truncate } from "../utils/text";

export interface IncomingMessage {
  id: number;
  platform: string;
  sender: string;
  company: string;
  text: string;
  vacancyId: number | null;
  title?: string;
}

export async function checkAllMessages(ctx: AppContext): Promise<IncomingMessage[]> {
  log.info("message_check_started");
  const incoming: IncomingMessage[] = [];

  try {
    const statuses = await ctx.oauth.negotiationsStatus();
    for (const status of statuses) {
      const baseThread = status.threadId ?? `${status.vacancyId ?? ""}:${status.title}`;
      const threadId = `${baseThread}|${status.status}`;
      const record = ctx.db.addMessageIfNew({
        platform: "hh",
        title: status.title,
        company: status.company,
        sender: status.company,
        text: status.status ? `Статус: ${status.status}` : "",
        threadId,
      });
      if (record) {
        incoming.push({
          id: record.id,
          platform: record.platform,
          sender: record.senderName ?? record.senderCompany ?? "Неизвестно",
          company: record.senderCompany ?? "",
          text: record.text,
          vacancyId: record.vacancyId,
          title: status.title,
        });
      }
    }
  } catch (error) {
    log.error("message_check_error", {
      error: error instanceof Error ? error.message : error,
    });
  }

  log.info("message_check_complete", { newCount: incoming.length });
  return incoming;
}

export async function processRejectionThanks(ctx: AppContext, maxCount = 3): Promise<number> {
  try {
    const sent = await ctx.playwright.sendThanksForRejections(maxCount);
    log.info("rejection_thanks_complete", { sent });
    return sent;
  } catch (error) {
    log.error("rejection_thanks_error", {
      error: error instanceof Error ? error.message : error,
    });
    return 0;
  }
}

/** Отформатировать сообщение для Telegram (как в старом боте). */
export function formatMessageNotification(message: IncomingMessage): string {
  const title = message.title ? `\n📋 ${escapeHtml(truncate(message.title, 100))}` : "";
  return (
    "📩 <b>Новое сообщение — hh.ru</b>\n\n" +
    `👤 ${escapeHtml(message.sender || "Неизвестно")}\n` +
    `🏢 ${escapeHtml(message.company || "—")}` +
    title +
    "\n\n" +
    escapeHtml(truncate(message.text, 600))
  );
}
