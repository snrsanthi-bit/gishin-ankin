/**
 * ストアの契約テスト。メモリ版と PostgreSQL 版に同じテストを流し、同じふるまいをすることを確かめる
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { StoreConflictError, type Account, type Life, type Match, type MatchSeat, type Store } from "./types.ts";

export type StoreFactory = {
  /** 空のストアを用意する */
  open(): Promise<Store>;
  /** 後片づけ */
  dispose(store: Store): Promise<void>;
};

const T0 = new Date("2026-11-28T00:00:00Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

const account = (n: number): Account => ({
  id: `acc-${n}`,
  discordId: `discord-${n}`,
  displayName: `name-${n}`,
  createdAt: T0,
});

const life = (n: number, over: Partial<Life> = {}): Life => ({
  id: `life-${n}`,
  accountId: `acc-${n}`,
  status: "alive",
  cash: 300,
  debt: 0,
  interestAccYen: 0,
  nextFee: 100,
  currentMatchId: null,
  matchesPlayed: 0,
  startedAt: T0,
  endedAt: null,
  ...over,
});

const match = (id: string, over: Partial<Match> = {}): Match => ({
  id,
  kind: "real",
  status: "in_progress",
  startedAt: T0,
  endedAt: null,
  draw: false,
  bonusTotalYen: 0,
  remainderYen: 0,
  record: { v: 1, games: [] },
  ...over,
});

const lifeSeat = (matchId: string, n: number): MatchSeat => ({
  matchId,
  seat: n - 1,
  accountId: `acc-${n}`,
  lifeId: `life-${n}`,
  entry: { cashBefore: 300, debtBefore: 0, interestAccYenBefore: 0, fee: 100, borrowed: 0 },
  settlement: null,
});

const conflict = (error: unknown) => error instanceof StoreConflictError;

export function storeContract(name: string, factory: StoreFactory): void {
  describe(`ストアの契約：${name}`, () => {
    let store: Store;

    beforeEach(async () => {
      store = await factory.open();
    });
    afterEach(async () => {
      await factory.dispose(store);
    });

    /** アカウント1〜n と、その生存中の人生を作る */
    const seed = (n: number) =>
      store.tx(async (tx) => {
        for (let i = 1; i <= n; i++) {
          await tx.createAccount(account(i));
          await tx.createLife(life(i));
        }
      });

    describe("アカウント", () => {
      test("作って、id と Discord の id で探せる", async () => {
        await store.tx((tx) => tx.createAccount(account(1)));
        const [byId, byDiscord, none] = await store.tx(async (tx) => [
          await tx.getAccount("acc-1"),
          await tx.findAccountByDiscordId("discord-1"),
          await tx.findAccountByDiscordId("discord-9"),
        ]);
        assert.deepEqual(byId, account(1));
        assert.deepEqual(byDiscord, account(1));
        assert.equal(none, null);
      });

      test("同じ Discord の id のアカウントは2つ作れない", async () => {
        await store.tx((tx) => tx.createAccount(account(1)));
        await assert.rejects(
          store.tx((tx) => tx.createAccount({ ...account(2), discordId: "discord-1" })),
          conflict,
        );
      });

      test("名前を変えられる", async () => {
        await store.tx((tx) => tx.createAccount(account(1)));
        await store.tx((tx) => tx.updateAccountName("acc-1", "新しい名前"));
        const a = await store.tx((tx) => tx.getAccount("acc-1"));
        assert.equal(a?.displayName, "新しい名前");
      });
    });

    describe("ログイン状態", () => {
      test("期限内のセッションだけ見つかり、期限切れはまとめて消せる", async () => {
        await store.tx(async (tx) => {
          await tx.createAccount(account(1));
          await tx.createSession({ tokenHash: "h1", accountId: "acc-1", createdAt: T0, expiresAt: at(10) });
          await tx.createSession({ tokenHash: "h2", accountId: "acc-1", createdAt: T0, expiresAt: at(30) });
        });
        const [before, after] = await store.tx(async (tx) => [
          await tx.findSession("h1", at(5)),
          await tx.findSession("h1", at(10)),
        ]);
        assert.equal(before?.accountId, "acc-1");
        assert.equal(after, null);

        assert.equal(await store.tx((tx) => tx.deleteExpiredSessions(at(20))), 1);
        assert.notEqual(await store.tx((tx) => tx.findSession("h2", at(20))), null);

        await store.tx((tx) => tx.deleteSession("h2"));
        assert.equal(await store.tx((tx) => tx.findSession("h2", at(20))), null);
      });

      test("ないアカウントのセッションは作れない", async () => {
        await assert.rejects(
          store.tx((tx) => tx.createSession({ tokenHash: "h", accountId: "acc-9", createdAt: T0, expiresAt: at(1) })),
          conflict,
        );
      });
    });

    describe("人生", () => {
      test("作って読み、書き換えられる", async () => {
        await seed(1);
        const read = await store.tx((tx) => tx.getLife("life-1"));
        assert.deepEqual(read, life(1));

        await store.tx((tx) => tx.updateLife({ ...life(1), cash: 120, debt: 30, interestAccYen: 5000, matchesPlayed: 1 }));
        const alive = await store.tx((tx) => tx.findAliveLife("acc-1"));
        assert.deepEqual(alive, { ...life(1), cash: 120, debt: 30, interestAccYen: 5000, matchesPlayed: 1 });
      });

      test("生存中の人生は、1アカウントにつき1つだけ", async () => {
        await seed(1);
        await assert.rejects(
          store.tx((tx) => tx.createLife(life(1, { id: "life-1b" }))),
          conflict,
        );
      });

      test("前の人生が終わっていれば、新しい人生を作れる", async () => {
        await seed(1);
        await store.tx(async (tx) => {
          await tx.updateLife({ ...life(1), status: "ended", endedAt: at(60) });
          await tx.createLife(life(1, { id: "life-1b", startedAt: at(61) }));
        });
        const alive = await store.tx((tx) => tx.findAliveLife("acc-1"));
        assert.equal(alive?.id, "life-1b");
      });

      test("終わった人生は試合に入っていられない", async () => {
        await seed(1);
        await store.tx((tx) => tx.createMatch(match("m1")));
        await assert.rejects(
          store.tx((tx) =>
            tx.updateLife({ ...life(1), status: "ended", endedAt: at(1), currentMatchId: "m1" }),
          ),
          conflict,
        );
      });

      test("ない試合には入れない", async () => {
        await seed(1);
        await assert.rejects(
          store.tx((tx) => tx.updateLife({ ...life(1), currentMatchId: "nope" })),
          conflict,
        );
      });

      test("お金はマイナスにできない", async () => {
        await seed(1);
        await assert.rejects(store.tx((tx) => tx.updateLife({ ...life(1), cash: -1 })), conflict);
      });

      test("固定して読むと id の順に返り、ない id は含まない", async () => {
        await seed(3);
        const lives = await store.tx((tx) => tx.lockLives(["life-3", "life-1", "life-9", "life-1"]));
        assert.deepEqual(
          lives.map((l) => l.id),
          ["life-1", "life-3"],
        );
      });

      test("同じ人生を同時に書き換えても、取りこぼさない", async () => {
        await seed(1);
        const addOne = () =>
          store.tx(async (tx) => {
            const [l] = await tx.lockLives(["life-1"]);
            assert.ok(l);
            await new Promise((resolve) => setTimeout(resolve, 20));
            await tx.updateLife({ ...l, cash: l.cash + 1 });
          });
        await Promise.all([addOne(), addOne(), addOne()]);
        const l = await store.tx((tx) => tx.getLife("life-1"));
        assert.equal(l?.cash, 303);
      });
    });

    describe("トランザクション", () => {
      test("途中で失敗したら、何も書かれない", async () => {
        await assert.rejects(
          store.tx(async (tx) => {
            await tx.createAccount(account(1));
            await tx.createLife(life(1));
            throw new Error("わざと失敗");
          }),
          /わざと失敗/,
        );
        assert.equal(await store.tx((tx) => tx.getAccount("acc-1")), null);
      });

      test("制約違反で失敗したら、それまでの書き込みも戻る", async () => {
        await seed(1);
        await assert.rejects(
          store.tx(async (tx) => {
            await tx.updateLife({ ...life(1), cash: 999 });
            await tx.createAccount({ ...account(2), discordId: "discord-1" });
          }),
          conflict,
        );
        const l = await store.tx((tx) => tx.getLife("life-1"));
        assert.equal(l?.cash, 300);
      });
    });

    describe("試合", () => {
      test("同じ id の試合は2回作れない（試合の開始を二重にしない）", async () => {
        await store.tx((tx) => tx.createMatch(match("m1")));
        await assert.rejects(store.tx((tx) => tx.createMatch(match("m1"))), conflict);
      });

      test("終了は、進行中のときだけ1回だけできる", async () => {
        await store.tx((tx) => tx.createMatch(match("m1")));
        const close = {
          endedAt: at(30),
          draw: true,
          bonusTotalYen: 1_234_567,
          remainderYen: 89_999,
          record: { v: 1 as const, games: [] },
        };
        assert.equal(await store.tx((tx) => tx.closeMatch("m1", "in_progress", "finished", close)), true);
        assert.equal(await store.tx((tx) => tx.closeMatch("m1", "in_progress", "finished", close)), false);
        assert.equal(await store.tx((tx) => tx.closeMatch("m1", "in_progress", "void", close)), false);
        assert.equal(await store.tx((tx) => tx.closeMatch("nope", "in_progress", "void", close)), false);

        const m = await store.tx((tx) => tx.getMatch("m1"));
        assert.deepEqual(m, { ...match("m1"), ...close, status: "finished" });
      });

      test("牌譜をそのまま保存して読める", async () => {
        const record = {
          v: 1 as const,
          games: [
            {
              kind: "normal" as const,
              totalContribution: 150,
              seats: [
                { contribution: 100, distributionYen: 375_000, bonusYen: 50_000, moneyBefore: 100, moneyAfter: 42 },
                null,
                { contribution: 50, distributionYen: 375_000, bonusYen: 25_000, moneyBefore: 100, moneyAfter: 90 },
                { contribution: 0, distributionYen: 375_000, bonusYen: 0, moneyBefore: 100, moneyAfter: 137 },
              ],
              streakAfter: 0,
              draw: false,
            },
          ],
        };
        await store.tx((tx) => tx.createMatch(match("m1", { record })));
        const m = await store.tx((tx) => tx.getMatch("m1"));
        assert.deepEqual(m?.record, record);
      });

      test("状態と種類で試合の id を探せる", async () => {
        await store.tx(async (tx) => {
          await tx.createMatch(match("a"));
          await tx.createMatch(match("b", { kind: "practice" }));
          await tx.createMatch(match("c", { kind: "tutorial" }));
          await tx.createMatch(match("d", { status: "finished", endedAt: at(1) }));
        });
        const ids = await store.tx((tx) => tx.listMatchIds("in_progress", ["real", "tutorial"]));
        assert.deepEqual(ids, ["a", "c"]);
      });

      test("進行中なのに終了時刻がある試合は作れない", async () => {
        await assert.rejects(store.tx((tx) => tx.createMatch(match("m1", { endedAt: at(1) }))), conflict);
      });
    });

    describe("試合の席", () => {
      test("人生の席・練習の席・Botの席を作って読める", async () => {
        await seed(2);
        await store.tx(async (tx) => {
          await tx.createMatch(match("m1"));
          await tx.createSeats([
            lifeSeat("m1", 1),
            { matchId: "m1", seat: 1, accountId: "acc-2", lifeId: null, entry: null, settlement: null },
            { matchId: "m1", seat: 2, accountId: null, lifeId: null, entry: null, settlement: null },
          ]);
        });
        const seats = await store.tx((tx) => tx.getSeats("m1"));
        assert.deepEqual(seats, [
          lifeSeat("m1", 1),
          { matchId: "m1", seat: 1, accountId: "acc-2", lifeId: null, entry: null, settlement: null },
          { matchId: "m1", seat: 2, accountId: null, lifeId: null, entry: null, settlement: null },
        ]);
      });

      test("試合後の処理の結果を書ける", async () => {
        await seed(1);
        await store.tx(async (tx) => {
          await tx.createMatch(match("m1"));
          await tx.createSeats([lifeSeat("m1", 1)]);
        });
        const settlement = {
          moneyOut: 137,
          bonusReceivedYen: 75_000,
          interestAdded: 0,
          repaid: 0,
          nextFee: 112,
          lifeEnded: false,
          cashAfter: 337,
          debtAfter: 0,
          interestAccYenAfter: 0,
        };
        await store.tx((tx) => tx.setSeatSettlement("m1", 0, settlement));
        const [seat] = await store.tx((tx) => tx.getSeats("m1"));
        assert.deepEqual(seat, { ...lifeSeat("m1", 1), settlement });
      });

      test("同じ席・同じ人生は、1つの試合に2回入れない", async () => {
        await seed(2);
        await store.tx(async (tx) => {
          await tx.createMatch(match("m1"));
          await tx.createSeats([lifeSeat("m1", 1)]);
        });
        await assert.rejects(store.tx((tx) => tx.createSeats([{ ...lifeSeat("m1", 2), seat: 0 }])), conflict);
        await assert.rejects(store.tx((tx) => tx.createSeats([{ ...lifeSeat("m1", 1), seat: 3 }])), conflict);
      });

      test("人生の席には入場の記録が要り、人生のない席には入れられない", async () => {
        await seed(1);
        await store.tx((tx) => tx.createMatch(match("m1")));
        await assert.rejects(store.tx((tx) => tx.createSeats([{ ...lifeSeat("m1", 1), entry: null }])), conflict);
        await assert.rejects(
          store.tx((tx) => tx.createSeats([{ ...lifeSeat("m1", 1), lifeId: null }])),
          conflict,
        );
        await assert.rejects(
          store.tx((tx) => tx.createSeats([{ ...lifeSeat("m1", 1), accountId: null }])),
          conflict,
        );
      });

      test("人生のない席には、試合後の処理の結果を書けない", async () => {
        await seed(1);
        await store.tx(async (tx) => {
          await tx.createMatch(match("m1"));
          await tx.createSeats([{ matchId: "m1", seat: 0, accountId: "acc-1", lifeId: null, entry: null, settlement: null }]);
        });
        await assert.rejects(
          store.tx((tx) =>
            tx.setSeatSettlement("m1", 0, {
              moneyOut: 1,
              bonusReceivedYen: 0,
              interestAdded: 0,
              repaid: 0,
              nextFee: 100,
              lifeEnded: false,
              cashAfter: 1,
              debtAfter: 0,
              interestAccYenAfter: 0,
            }),
          ),
          conflict,
        );
      });
    });

    describe("チャット", () => {
      test("保存して試合ごとに読める", async () => {
        await seed(1);
        await store.tx((tx) => tx.createMatch(match("m1")));
        const saved = await store.tx(async (tx) => [
          await tx.addChatMessage({ matchId: "m1", seat: 0, accountId: "acc-1", text: "よろしく", original: null, createdAt: at(1) }),
          await tx.addChatMessage({ matchId: "m1", seat: 0, accountId: "acc-1", text: "＊＊＊", original: "死ね", createdAt: at(2) }),
        ]);
        assert.ok(saved[0] && saved[1] && saved[0].id < saved[1].id);
        const list = await store.tx((tx) => tx.listChatMessages("m1"));
        assert.deepEqual(list, saved);
      });

      test("保存期間を過ぎたものを消す。印のある試合の分は、印の期限まで残す", async () => {
        await seed(1);
        await store.tx(async (tx) => {
          for (const id of ["old", "held", "heldExpired", "heldForever", "new"]) await tx.createMatch(match(id));
          const add = (matchId: string, minutes: number) =>
            tx.addChatMessage({ matchId, seat: 0, accountId: "acc-1", text: "x", original: null, createdAt: at(minutes) });
          await add("old", 0);
          await add("held", 0);
          await add("held", 100); // 印のある試合は、新しいものも含めて全部残す
          await add("heldExpired", 0);
          await add("heldForever", 0);
          await add("new", 100);
          await tx.addChatHold({ matchId: "held", reason: "report", holdUntil: at(1000), createdAt: at(1) });
          await tx.addChatHold({ matchId: "heldExpired", reason: "report", holdUntil: at(50), createdAt: at(1) });
          await tx.addChatHold({ matchId: "heldForever", reason: "sanction", holdUntil: null, createdAt: at(1) });
        });

        const removed = await store.tx((tx) => tx.deleteExpiredChat(at(10), at(60)));
        assert.equal(removed, 2); // old と heldExpired
        const counts = await store.tx(async (tx) => {
          const out: Record<string, number> = {};
          for (const id of ["old", "held", "heldExpired", "heldForever", "new"]) {
            out[id] = (await tx.listChatMessages(id)).length;
          }
          return out;
        });
        assert.deepEqual(counts, { old: 0, held: 2, heldExpired: 0, heldForever: 1, new: 1 });
      });
    });
  });
}
