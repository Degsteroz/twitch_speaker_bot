// "!топ": the character shows who called her most this stream. A card on the overlay with a sound
// effect: no quota, no model, no voice, so it is free on every plan. The bot reads chat anonymously
// and cannot post there, so the overlay is the only place to show it.
import { findStopListMatch } from "@roastbot/prompts";
import {
  OVERLAY_EVENT_TTL_SECONDS,
  TOP_BOARD_COOLDOWN_MINUTES,
  TOP_BOARD_SIZE,
  TOP_BOARD_WINDOW_HOURS,
  type Archetype,
  type RoastRequestedJob
} from "@roastbot/shared";

import type { OnAirCharacter, PipelineDependencies, RoastOutcome, Sql } from "./context.js";
import { publishOverlay } from "./overlay.js";

export interface BoardInput {
  job: RoastRequestedJob;
  roastId: string;
  streamerLogin: string;
  planCode: string | null;
  character: OnAirCharacter | undefined;
  archetype: Archetype;
  stopWords: readonly string[];
  started: number;
}

/** "Чаще всех нарывались: 1. vasya — 5, 2. petya — 3"; a quiet stream has its own line. */
export const boardText = (rows: readonly { login: string; count: number }[]) =>
  rows.length
    ? `Чаще всех нарывались: ${rows
        .map((row, index) => `${String(index + 1)}. ${row.login} — ${String(row.count)}`)
        .join(", ")}`
    : "За этот стрим ещё никто не нарвался. Пока.";

/**
 * Shows the board, at most once per TOP_BOARD_COOLDOWN_MINUTES per channel: the check and the
 * publish share one transaction under a per-channel lock, so parallel workers never show two.
 * Counted: the viewers' own calls that got a real roast in the last TOP_BOARD_WINDOW_HOURS; never
 * the streamer, viewers who opted out, or a login the stop list catches now.
 */
export async function playBoard(
  deps: PipelineDependencies,
  input: BoardInput
): Promise<RoastOutcome> {
  const { job, roastId } = input;
  const now = deps.now?.() ?? new Date();
  const expiresAt = new Date(now.getTime() + OVERLAY_EVENT_TTL_SECONDS * 1000);
  const reason = await deps.sql.begin(async (transaction) => {
    const tx = transaction as unknown as Sql;
    await tx`select pg_advisory_xact_lock(hashtext('roastbot-board'), hashtext(${job.channelId}::text))`;
    const [recent] = await tx`select 1 from roasts where channel_id=${job.channelId}
      and error='top_board' and id<>${roastId}
      and created_at > ${now.toISOString()}::timestamptz
        - make_interval(mins => ${TOP_BOARD_COOLDOWN_MINUTES})`;
    if (recent) {
      await tx`update roasts set status='skipped', error='top_cooldown',
        latency_ms=${Date.now() - input.started} where id=${roastId}`;
      return "top_cooldown";
    }
    const rows = await tx<{ login: string; count: number }[]>`
      select lower(r.viewer_login) login, count(*)::int count from roasts r
      where r.channel_id=${job.channelId} and r.status='done'
        and r.source in ('chat_command','chat_keyword','reward')
        and r.created_at > ${now.toISOString()}::timestamptz
          - make_interval(hours => ${TOP_BOARD_WINDOW_HOURS})
        and lower(r.viewer_login) <> lower(${input.streamerLogin})
        and not exists (select 1 from viewer_optouts o where o.channel_id=r.channel_id
          and lower(o.viewer_login)=lower(r.viewer_login))
      group by 1 order by 2 desc, max(r.created_at) desc limit ${TOP_BOARD_SIZE * 3}`;
    const shown = rows
      .filter((row) => !findStopListMatch(row.login, input.stopWords))
      .slice(0, TOP_BOARD_SIZE);
    const text = boardText(shown);
    await tx`update roasts set status='skipped', error='top_board', output_text=${text},
      latency_ms=${Date.now() - input.started} where id=${roastId}`;
    await publishOverlay(tx, {
      job,
      roastId,
      text,
      archetype: input.archetype,
      character: input.character,
      planCode: input.planCode,
      sound: "ping",
      now,
      expiresAt
    });
    return "top_board";
  });
  return { roastId, status: "skipped", reason };
}
