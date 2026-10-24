import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/postgres-js/migrator";

import { createDatabase } from "./client.js";

const MIGRATION_LOCK_ID = 7_621_884_901;

export async function runMigrations(databaseUrl: string): Promise<void> {
  // The session-level advisory lock is held on the raw connection for the whole run, so two
  // concurrent deploys serialise even though Drizzle migrates over its own connection.
  const database = createDatabase(databaseUrl, {
    maxConnections: 1,
    applicationName: "roastbot-migrate"
  });

  try {
    await database.client`select pg_advisory_lock(${MIGRATION_LOCK_ID})`;
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url))
    });
  } finally {
    try {
      await database.client`select pg_advisory_unlock(${MIGRATION_LOCK_ID})`;
    } finally {
      await database.close();
    }
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  await runMigrations(databaseUrl);
}
