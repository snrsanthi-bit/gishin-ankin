/**
 * ストアのテスト。メモリ版はいつも流す。
 * PostgreSQL 版は DATABASE_URL があるときだけ流す（手元：pnpm db:up のあと DATABASE_URL を付けて pnpm test。CIでも流す）
 */
import { storeContract } from "./contract.ts";
import { MemoryStore } from "./memory.ts";

storeContract("メモリ版", {
  open: async () => new MemoryStore(),
  dispose: (store) => store.close(),
});

const url = process.env.DATABASE_URL;
if (url) {
  const { PostgresStore } = await import("./postgres.ts");
  const { migrate } = await import("./migrate.ts");
  await migrate(url);
  storeContract("PostgreSQL版", {
    open: async () => {
      const store = new PostgresStore(url);
      await store.truncateAll();
      return store;
    },
    dispose: (store) => store.close(),
  });
}
