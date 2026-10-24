import { and, eq, isNotNull, lt, or, sql } from "drizzle-orm";

import { createDatabase, type Database } from "./client.js";
import { cooldownState, events, overlayEvents, roasts } from "./schema.js";

export interface CleanupResult {
  readonly redactedRoasts: number;
  readonly redactedEvents: number;
  readonly expiredOverlayEvents: number;
  readonly deletedOverlayEvents: number;
  readonly deletedCooldowns: number;
}

export async function cleanupExpiredData(
  db: Database,
  now = new Date(),
  roastRetentionDays = 30
): Promise<CleanupResult> {
  if (!Number.isInteger(roastRetentionDays) || roastRetentionDays < 1) {
    throw new RangeError("roastRetentionDays must be a positive integer");
  }
  const roastCutoff = new Date(now.getTime() - roastRetentionDays * 86_400_000);
  const overlayDeleteCutoff = new Date(now.getTime() - 7 * 86_400_000);

  return db.transaction(async (tx) => {
    const redacted = await tx
      .update(roasts)
      .set({ inputText: null, outputText: null })
      .where(
        and(
          lt(roasts.createdAt, roastCutoff),
          or(isNotNull(roasts.inputText), isNotNull(roasts.outputText))
        )
      )
      .returning({ id: roasts.id });

    // events.raw keeps the viewer's chat tags and message text, so it follows the same retention.
    const redactedEvents = await tx
      .update(events)
      .set({ raw: {} })
      .where(and(lt(events.receivedAt, roastCutoff), sql`${events.raw} <> '{}'::jsonb`))
      .returning({ id: events.id });

    const expired = await tx
      .update(overlayEvents)
      .set({ status: "expired" })
      .where(and(eq(overlayEvents.status, "pending"), lt(overlayEvents.expiresAt, now)))
      .returning({ id: overlayEvents.id });

    const deletedEvents = await tx
      .delete(overlayEvents)
      .where(
        and(
          or(eq(overlayEvents.status, "delivered"), eq(overlayEvents.status, "expired")),
          lt(overlayEvents.expiresAt, overlayDeleteCutoff)
        )
      )
      .returning({ id: overlayEvents.id });

    const deletedCooldowns = await tx
      .delete(cooldownState)
      .where(lt(cooldownState.nextAllowedAt, now))
      .returning({ channelId: cooldownState.channelId });

    return {
      redactedRoasts: redacted.length,
      redactedEvents: redactedEvents.length,
      expiredOverlayEvents: expired.length,
      deletedOverlayEvents: deletedEvents.length,
      deletedCooldowns: deletedCooldowns.length
    };
  });
}

async function main(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const database = createDatabase(databaseUrl, { applicationName: "roastbot-cleanup" });

  try {
    const retention = Number.parseInt(process.env["ROAST_RETENTION_DAYS"] ?? "30", 10);
    const result = await cleanupExpiredData(database.db, new Date(), retention);
    console.log(JSON.stringify(result));
  } finally {
    await database.close();
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  await main();
}
