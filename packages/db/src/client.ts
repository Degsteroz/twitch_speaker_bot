import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema.js";

export interface DatabaseOptions {
  readonly maxConnections?: number;
  readonly applicationName?: string;
}

export type Database = PostgresJsDatabase<typeof schema>;

export function createDatabase(databaseUrl: string, options: DatabaseOptions = {}) {
  if (!databaseUrl) throw new Error("databaseUrl is required");
  const connect = (max: number) =>
    postgres(databaseUrl, {
      max,
      connection: { application_name: options.applicationName ?? "roastbot" }
    });

  // Drizzle rewrites the date/json parsers and serializers of the postgres.js client it wraps,
  // which would make raw queries receive timestamptz as strings and reject Date parameters.
  // Raw SQL therefore gets its own pool; the Drizzle pool is small and created on first use.
  const client = connect(options.maxConnections ?? 10);
  let drizzleClient: postgres.Sql | undefined;
  let db: Database | undefined;

  return {
    client,
    get db(): Database {
      if (!db) {
        drizzleClient = connect(Math.min(2, options.maxConnections ?? 2));
        db = drizzle(drizzleClient, { schema, casing: "snake_case" });
      }
      return db;
    },
    async close(): Promise<void> {
      await Promise.all([client.end({ timeout: 5 }), drizzleClient?.end({ timeout: 5 })]);
    }
  };
}
