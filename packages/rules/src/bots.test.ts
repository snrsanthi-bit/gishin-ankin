import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "./config.ts";
import { BOT_KINDS, botViewOf, createBot, type BotKind } from "./bots.ts";
import { playMatch, type Decider } from "./match.ts";
import { createRng } from "./random.ts";

const cfg = DEFAULT_CONFIG;

function botDeciders(kinds: BotKind[], seed = 1): Decider[] {
  const rng = createRng(seed);
  return kinds.map((k) => {
    const bot = createBot(k, rng);
    return (state, seat, last) => bot.decide(botViewOf(cfg, state, seat, last));
  });
}

test("お人好し4体は5ゲームでDrawになる", async () => {
  const r = await playMatch(cfg, botDeciders(["allIn", "allIn", "allIn", "allIn"]));
  assert.equal(r.final.draw, true);
  assert.equal(r.games.length, 5);
  assert.equal(r.nextFee, 100);
  assert.deepEqual(r.final.seats.map((s) => s.money), [247, 247, 247, 247]);
});

test("ただ乗り1体とお人好し3体：ただ乗りが勝ち、Drawにはならない", async () => {
  const r = await playMatch(cfg, botDeciders(["allIn", "allIn", "allIn", "freeRider"]));
  assert.equal(r.final.draw, false);
  assert.equal(r.games.length, 10);
  assert.deepEqual(r.final.seats.map((s) => s.money), [9, 9, 9, 429]);
});

test("仕返しBotは、自分が出したのに裏切られた次のゲームだけ出さない", async () => {
  const r = await playMatch(cfg, botDeciders(["grudger", "grudger", "grudger", "freeRider"]));
  const c = (g: number) => r.games[g]?.seats.slice(0, 3).map((s) => s?.contribution);
  assert.deepEqual(c(0), [100, 100, 100]); // 1：全額
  assert.deepEqual(c(1), [0, 0, 0]); // 2：裏切られたので仕返し
  assert.ok(c(2)?.every((x) => (x ?? 0) > 0), "3：自分が出さなかったゲームの後は、また出す");
});

test("どのBotの組み合わせでも、試合は最後まで進み、所持金は0以上", async () => {
  for (let seed = 1; seed <= 30; seed++) {
    const rng = createRng(seed);
    const kinds = [0, 1, 2, 3].map(() => BOT_KINDS[Math.floor(rng() * BOT_KINDS.length)] as BotKind);
    const r = await playMatch(cfg, botDeciders(kinds, seed));
    assert.equal(r.final.finished, true);
    assert.ok(r.final.seats.every((s) => s.money >= 0));
    assert.ok(r.nextFee >= cfg.stake);
  }
});

test("同じseedなら同じ試合になる", async () => {
  const a = await playMatch(cfg, botDeciders(["smart", "random", "smart", "grudger"], 7));
  const b = await playMatch(cfg, botDeciders(["smart", "random", "smart", "grudger"], 7));
  assert.deepEqual(a.final, b.final);
});
