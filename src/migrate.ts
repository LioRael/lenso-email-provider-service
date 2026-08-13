import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import pg from "pg";

const { Pool } = pg;

export const migrate = async (databaseUrl: string): Promise<void> => {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const migrationUrl = new URL("../migrations/0001_email_provider.sql", import.meta.url);
  const sql = await readFile(fileURLToPath(migrationUrl), "utf8");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [1_917_347_135]);
    await client.query(sql);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
};

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  await migrate(databaseUrl);
  process.stdout.write("Email Provider database is ready\n");
}
