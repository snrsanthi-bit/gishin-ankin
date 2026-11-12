import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "./config.ts";
import { canPayNextFee, enterMatch, newLife, nextFeeOf, settleMatch, type LifeMoney } from "./life.ts";

const cfg = DEFAULT_CONFIG;
const noBonus = { draw: false, bonusTotalYen: 0, remainderYen: 0 };

test("利息の1万円未満はためておき、1万円に達したら借金に加える", () => {
  // 決定事項3-2の例：借金25万・金利10% → 2万を加え、0.5万を端数としてためる
  const life: LifeMoney = { cash: 0, debt: 25, interestAccYen: 0, nextFee: 100 };
  const r1 = settleMatch(cfg, life, { ...noBonus, money: 0 }, 0);
  assert.equal(r1.interestAdded, 2);
  assert.equal(r1.life.debt, 27);
  assert.equal(r1.life.interestAccYen, 5000);
});

test("担保の範囲内は担保内金利、超えた分は通常の金利", () => {
  const life: LifeMoney = { cash: 0, debt: 100, interestAccYen: 0, nextFee: 100 };
  // 担保50：50×2% + 50×10% = 1 + 5 = 6万
  const r = settleMatch(cfg, life, { ...noBonus, money: 0 }, 50);
  assert.equal(r.interestAdded, 6);
});

test("完済しても利息の端数は持ち越す", () => {
  const life: LifeMoney = { cash: 0, debt: 5, interestAccYen: 0, nextFee: 100 };
  const r = settleMatch(cfg, life, { ...noBonus, money: 200 }, 0);
  assert.equal(r.life.debt, 0);
  assert.equal(r.life.interestAccYen, 5000); // 5万×10% = 0.5万
  assert.equal(r.life.cash, 195);
});

test("次の参加費：上乗せ分 − 端数の割引。Drawなら元手ちょうど", () => {
  assert.deepEqual(nextFeeOf(cfg, { money: 0, draw: false, bonusTotalYen: 900000, remainderYen: 170000 }), {
    fee: 100 + 22 - 4,
    surcharge: 22, // ⌊90万 ÷ 4⌋
    discount: 4, // ⌊17万 ÷ 4⌋
  });
  assert.equal(nextFeeOf(cfg, { money: 0, draw: false, bonusTotalYen: 10000, remainderYen: 400000 }).fee, 100);
  assert.equal(nextFeeOf(cfg, { money: 0, draw: true, bonusTotalYen: 900000, remainderYen: 0 }).fee, 100);
});

test("人生終了：借金＋参加費の不足分が、限度額＋担保を超えたら終了", () => {
  const ok: LifeMoney = { cash: 0, debt: 200, interestAccYen: 0, nextFee: 100 };
  assert.equal(canPayNextFee(cfg, ok, 0), true); // 200 + 100 = 300 ≤ 300
  const ng: LifeMoney = { ...ok, debt: 201 };
  assert.equal(canPayNextFee(cfg, ng, 0), false);
  assert.equal(canPayNextFee(cfg, ng, 27), true); // 担保で耐える
});

test("settleMatch は利息→返済→参加費→判定の順で処理する", () => {
  // 借金290で試合に入り、0で持ち帰った → 利息29 → 319。次の参加費100 → 419 > 300 で人生終了
  const life: LifeMoney = { cash: 0, debt: 290, interestAccYen: 0, nextFee: 100 };
  const r = settleMatch(cfg, life, { ...noBonus, money: 0 }, 0);
  assert.equal(r.life.debt, 319);
  assert.equal(r.lifeEnded, true);
  // 同じ状況でも、持ち帰りがあれば先に返済される
  const r2 = settleMatch(cfg, life, { ...noBonus, money: 250 }, 0);
  assert.equal(r2.repaid, 250);
  assert.equal(r2.life.debt, 69);
  assert.equal(r2.lifeEnded, false);
});

test("入場：足りない分だけ借りる", () => {
  const { life, borrowed } = enterMatch(cfg, { cash: 30, debt: 0, interestAccYen: 0, nextFee: 120 }, 0);
  assert.equal(borrowed, 90);
  assert.deepEqual(life, { cash: 0, debt: 90, interestAccYen: 0, nextFee: 120 });
});

test("新しい人生はチュートリアルの参加費でちょうど0円になる", () => {
  const { life, borrowed } = enterMatch(cfg, newLife(cfg), 0);
  assert.equal(borrowed, 0);
  assert.equal(life.cash, 0);
});
