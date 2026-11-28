/**
 * 表の作成・変更：migrations/ の SQL ファイルを番号順に流す。流したものは schema_migrations に記録し、2回は流さない
 *   使い方：pnpm db:migrate（DATABASE_URL がなければ docker-compose の開発用DB）
 */
import { readdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { DEFAULT_DATABASE_URL } from "./postgres.ts";

const MIGRATIONS_DIR = new URL("../../migrations/", import.meta.url);

export async function migrate(connectionString: string, log: (line: string) => void = () => {}): Promise<string[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const done = new Set((await client.query<{ version: string }>("SELECT version FROM schema_migrations")).rows.map((r) => r.version));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
    const applied: string[] = [];
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(new URL(file, MIGRATIONS_DIR), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`${file} を流せませんでした`, { cause: error });
      }
      applied.push(file);
      log(`流しました：${file}`);
    }
    if (applied.length === 0) log("新しい変更はありません");
    return applied;
  } finally {
    await client.end();
  }
}

// pnpm db:migrate から呼ばれたとき
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await migrate(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL, (line) => console.log(line));
}
