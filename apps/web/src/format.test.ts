import { test } from "node:test";
import assert from "node:assert/strict";
import { clockwise, man, parseAmount, remainingSec, seatLabel, signedMan } from "./format.ts";

test("円を万円で表示する", () => {
  assert.equal(man(750000), "75万");
  assert.equal(man(775000), "77.5万");
  assert.equal(man(1250), "0.13万");
  assert.equal(man(0), "0万");
});

test("自分を先頭に時計回りで並べる", () => {
  const seats = [0, 1, 2, 3].map((seat) => ({ seat }));
  assert.deepEqual(clockwise(seats, 2).map((s) => s.seat), [2, 3, 0, 1]);
  assert.deepEqual(clockwise(seats, 0).map((s) => s.seat), [0, 1, 2, 3]);
  assert.equal(seatLabel(2), "P3");
});

test("残り時間は切り上げ、0未満にならない", () => {
  assert.equal(remainingSec(10_000, 0), 10);
  assert.equal(remainingSec(10_000, 9_001), 1);
  assert.equal(remainingSec(10_000, 20_000), 0);
  assert.equal(remainingSec(null, 0), null);
});

test("入力欄の読み取り", () => {
  assert.equal(parseAmount(" 30 ", 100), 30);
  assert.equal(parseAmount("101", 100), null);
  assert.equal(parseAmount("1.5", 100), null);
  assert.equal(parseAmount("", 100), null);
  assert.equal(signedMan(147), "+147万");
  assert.equal(signedMan(-23), "−23万");
});
