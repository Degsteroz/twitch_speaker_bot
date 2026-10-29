// The streamer's Telegram: notifications (quota, Twitch refusals) and the summary after a stream.
// Every notification is booked in notifications_sent first, so each kind goes out once per period
// even when several workers or redelivered jobs try at the same time.
import { telegramCall, type TelegramNotifyJob } from "@roastbot/shared";

import type { WorkerConfig } from "./config.js";
import type { Sql } from "./context.js";

export async function notifyStreamer(
  sql: Sql,
  config: WorkerConfig,
  job: TelegramNotifyJob,
  fetcher: typeof globalThis.fetch = globalThis.fetch
): Promise<boolean> {
  if (!config.TELEGRAM_BOT_TOKEN) return false;
  const [account] = await sql<{ chatId: string }[]>`
    select chat_id::text "chatId" from telegram_accounts where channel_id=${job.channelId}`;
  if (!account) return false;
  const booked = await sql`
    insert into notifications_sent(channel_id,kind,period)
    values(${job.channelId},${job.kind},${job.period}) on conflict do nothing returning kind`;
  if (!booked.length) return false;
  await telegramCall(
    config.TELEGRAM_BOT_TOKEN,
    "sendMessage",
    { chat_id: account.chatId, text: job.text, disable_web_page_preview: true },
    fetcher
  );
  return true;
}

/** The quota warning for this roast, if it crossed 80% or used the last one. */
export function quotaNotice(
  channelId: string,
  month: string,
  used: number,
  limit: number,
  dashboard: string | undefined
): TelegramNotifyJob | null {
  if (limit <= 0) return null;
  const link = dashboard ? ` Тарифы: ${dashboard}/#billing` : "";
  if (used >= limit) {
    return {
      channelId,
      kind: "quota_100",
      period: month,
      text: `Квота RoastBot на ${month} закончилась: до 1-го числа бот молчит.${link}`
    };
  }
  if (used >= limit * 0.8) {
    return {
      channelId,
      kind: "quota_80",
      period: month,
      text: `Квота RoastBot почти закончилась: осталось ${String(limit - used)} из ${String(limit)} роастов на ${month}.${link}`
    };
  }
  return null;
}

// A stream is over when the channel has been quiet this long after its last roast.
const QUIET_MINUTES = 45;

/**
 * After a stream, a short summary to every streamer with a linked Telegram: how many roasts
 * played, who got it most, the starred one. Runs every 15 minutes; a channel is summarised once
 * per session (last_summary_at), dashboard tests do not count.
 */
export async function sendStreamSummaries(
  sql: Sql,
  config: WorkerConfig,
  fetcher: typeof globalThis.fetch = globalThis.fetch
): Promise<number> {
  if (!config.TELEGRAM_BOT_TOKEN) return 0;
  const sessions = await sql<
    { channelId: string; chatId: string; login: string; since: Date; lastRoast: Date }[]
  >`
    select t.channel_id "channelId", t.chat_id::text "chatId", c.twitch_login login,
      greatest(coalesce(t.last_summary_at, '-infinity'), now()-interval '12 hours') since,
      max(r.created_at) "lastRoast"
    from telegram_accounts t join channels c on c.id=t.channel_id
    join roasts r on r.channel_id=t.channel_id and r.source<>'dashboard_test'
      and r.created_at > greatest(coalesce(t.last_summary_at, '-infinity'), now()-interval '12 hours')
    group by t.channel_id, t.chat_id, c.twitch_login, t.last_summary_at
    having max(r.created_at) < now() - ${QUIET_MINUTES} * interval '1 minute'`;
  let sent = 0;
  for (const session of sessions) {
    const [stats] = await sql<
      {
        played: number;
        blocked: number;
        skipped: number;
        topViewer: string | null;
        topCount: number;
        favorite: string | null;
      }[]
    >`
      with session as (
        select * from roasts where channel_id=${session.channelId} and source<>'dashboard_test'
          and created_at > ${session.since}
      ), top as (
        select viewer_login, count(*)::int n from session
        where status in ('done','blocked_output') and viewer_login is not null
          and lower(viewer_login)<>lower(${session.login})
        group by viewer_login order by n desc, viewer_login limit 1
      )
      select count(*) filter (where status in ('done','blocked_output'))::int played,
        count(*) filter (where status in ('blocked_input','blocked_output'))::int blocked,
        count(*) filter (where status='skipped')::int skipped,
        (select viewer_login from top) "topViewer",
        coalesce((select n from top),0)::int "topCount",
        (select output_text from session where favorite_at is not null
          order by favorite_at desc limit 1) favorite
      from session`;
    await sql`update telegram_accounts set last_summary_at=now()
      where channel_id=${session.channelId}`;
    if (!stats || stats.played + stats.skipped === 0) continue;
    const dashboard = config.DASHBOARD_URL?.replace(/\/$/u, "");
    const lines = [
      `Итог стрима на #${session.login}:`,
      `прозвучало роастов: ${String(stats.played)}` +
        (stats.blocked || stats.skipped
          ? ` (заблокировано ${String(stats.blocked)}, пропущено ${String(stats.skipped)})`
          : ""),
      ...(stats.topViewer
        ? [`чаще всех доставалось @${stats.topViewer}: ${String(stats.topCount)}`]
        : []),
      ...(stats.favorite ? [`лучший: «${stats.favorite}»`] : []),
      ...(dashboard ? ["", `Журнал: ${dashboard}/#activity`] : [])
    ];
    await telegramCall(
      config.TELEGRAM_BOT_TOKEN,
      "sendMessage",
      { chat_id: session.chatId, text: lines.join("\n"), disable_web_page_preview: true },
      fetcher
    ).then(
      () => sent++,
      (error: unknown) => console.warn(`stream summary for ${session.login}:`, error)
    );
  }
  return sent;
}
