import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, type RulesConfig } from "./config.ts";
import { newMatch, resolveGame, type Contribution, type MatchState } from "./game.ts";

const cfg: RulesConfig = { ...DEFAULT_CONFIG, alphaBp: 500, gammaBp: 1500, betaBp: 10000 };
const ALL = (s: MatchState): Contribution[] => s.seats.map((x) => x.money);

test("全員が全額出資すると、(α+γ) のボーナスで全員 120万になる", () => {
  const { state, result } = resolveGame(cfg, newMatch(cfg), [100, 100, 100, 100]);
  assert.equal(result.kind, "allIn");
  assert.deepEqual(state.seats.map((s) => s.money), [120, 120, 120, 120]);
  assert.equal(state.streak, 1);
  assert.equal(state.bonusTotalYen, 80 * 10000);
});

test("1人だけ出資しないと、その人だけ増える（囚人のジレンマ）", () => {
  const { state, result } = resolveGame(cfg, newMatch(cfg), [100, 100, 100, 0]);
  assert.equal(result.kind, "normal");
  // 出資者：100 − 100 + 75 + 5 = 80、非出資者：100 + 75 = 175
  assert.deepEqual(state.seats.map((s) => s.money), [80, 80, 80, 175]);
  assert.equal(state.streak, 0);
});

test("単独出資は β のボーナス", () => {
  const { state, result } = resolveGame(cfg, newMatch(cfg), [40, 0, 0, 0]);
  assert.equal(result.kind, "solo");
  // 出資者：100 − 40 + 10 + 40 = 110、他：110
  assert.deepEqual(state.seats.map((s) => s.money), [110, 110, 110, 110]);
});

test("誰も出資しないと何も起きない", () => {
  const { state, result } = resolveGame(cfg, newMatch(cfg), [0, 0, 0, 0]);
  assert.equal(result.kind, "none");
  assert.deepEqual(state.seats.map((s) => s.money), [100, 100, 100, 100]);
});

test("入力は所持金の範囲に丸め、未入力は0円として扱う", () => {
  const { result } = resolveGame(cfg, newMatch(cfg), [999, -5, null, 10.7]);
  assert.deepEqual(result.seats.map((s) => s?.contribution), [100, 0, 0, 10]);
});

test("1万円未満は切り捨てて端数の積立に入る", () => {
  // S = 10 → 1人あたり 2.5万。各席 0.5万（5,000円）ずつ切り捨て
  const { state } = resolveGame(cfg, newMatch(cfg), [10, 0, 0, 0]);
  // 単独出資なので出資者は +10（β×10）。分配 2.5万 → 全員 0.5万の端数
  assert.deepEqual(state.seats.map((s) => s.money), [102, 102, 102, 102]);
  assert.equal(state.remainderYen, 4 * 5000);
});

test("5連続で全員が全額出資すると Draw になり、平均にそろえて試合終了", () => {
  let s = newMatch(cfg);
  // 1ゲーム目だけ差をつける
  s = resolveGame(cfg, s, [100, 100, 100, 0]).state;
  for (let i = 0; i < 4; i++) {
    s = resolveGame(cfg, s, ALL(s)).state;
    assert.equal(s.draw, false);
  }
  s = resolveGame(cfg, s, ALL(s)).state;
  assert.equal(s.draw, true);
  assert.equal(s.finished, true);
  const m = s.seats.map((x) => x.money);
  assert.ok(m.every((x) => x === m[0]), "全員同じ額になる");
});

test("所持金0の席があると全員協力にならない", () => {
  let s = newMatch(cfg);
  s = resolveGame(cfg, s, [100, 0, 0, 0]).state; // 単独出資
  const seat0 = s.seats[0];
  assert.ok(seat0);
  seat0.money = 0;
  const { result } = resolveGame(cfg, s, ALL(s));
  assert.notEqual(result.kind, "allIn");
});

test("3ゲーム続けて不在で棄権。以降は残った人数で分配する", () => {
  let s = newMatch(cfg);
  for (let i = 0; i < 3; i++) s = resolveGame(cfg, s, [0, 0, 0, null]).state;
  assert.equal(s.seats[3]?.forfeited, true);
  const before = s.seats[3]?.money;
  const { state, result } = resolveGame(cfg, s, [90, 90, 90, 50]);
  assert.equal(result.seats[3], null);
  assert.equal(state.seats[3]?.money, before, "棄権した席の所持金は動かない");
  assert.equal(result.kind, "normal");
  // 残り3人で分配：S = 270 → 90ずつ。出資者：100 − 90 + 90 + 4.5 = 104.5 → 104
  assert.deepEqual(state.seats.slice(0, 3).map((x) => x.money), [104, 104, 104]);
});

test("棄権者がいても、残った全員の全額出資で全員協力・Drawになる", () => {
  let s = newMatch(cfg);
  for (let i = 0; i < 3; i++) s = resolveGame(cfg, s, [0, 0, 0, null]).state;
  for (let i = 0; i < 5; i++) s = resolveGame(cfg, s, [...ALL(s).slice(0, 3), 0]).state;
  assert.equal(s.draw, true);
});

test("規定のゲーム数で試合が終わる", () => {
  let s = newMatch(cfg);
  for (let i = 0; i < cfg.gamesPerMatch; i++) s = resolveGame(cfg, s, [10, 0, 10, 0]).state;
  assert.equal(s.finished, true);
  assert.throws(() => resolveGame(cfg, s, [0, 0, 0, 0]));
});

test("チュートリアルの台本（γ=0.15）の結果が設計書の試算と一致する", () => {
  // 席0 = 自分、席1 = 2ゲーム目に裏切るBot
  let s = newMatch(cfg);
  const mine: number[] = [];
  const step = (inputs: Contribution[]) => {
    s = resolveGame(cfg, s, inputs).state;
    mine.push(s.seats[0]?.money ?? -1);
  };
  step(ALL(s)); // 1：全員が全額出資
  step([s.seats[0]!.money, 0, s.seats[2]!.money, s.seats[3]!.money]); // 2：Botが0円
  step([0, s.seats[1]!.money, s.seats[2]!.money, s.seats[3]!.money]); // 3：自分が0円
  step(ALL(s)); // 4：全員が全額出資
  for (let i = 0; i < 4 && !s.finished; i++) step(ALL(s)); // 5〜8
  assert.deepEqual(mine.slice(0, 4), [120, 96, 196, 168]);
  assert.equal(s.draw, true);
  assert.equal(mine.at(-1), 318);
});
