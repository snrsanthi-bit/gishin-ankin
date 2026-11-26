import { test } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter, cleanChatText, maskText } from "./chat.ts";

test("出資額の話は伏せない", () => {
  for (const t of ["次は100出す", "全額いくよ 120万", "P3は0円だったと思う", "5連続でDraw！", "1ゲーム目 100 100 100 0"]) {
    assert.equal(maskText(t), t);
  }
});

test("電話番号を伏せる（ハイフン・全角も）", () => {
  assert.equal(maskText("電話して 090-1234-5678 まで"), "電話して ＊＊＊ まで");
  assert.equal(maskText("09012345678"), "＊＊＊");
  assert.equal(maskText("０３１２３４５６７８"), "＊＊＊");
  assert.equal(maskText("+81 90 1234 5678"), "＊＊＊");
});

test("メールアドレスとURLを伏せる", () => {
  assert.equal(maskText("連絡は foo.bar@example.com へ"), "連絡は ＊＊＊ へ");
  assert.equal(maskText("ここ見て https://example.com/abc"), "ここ見て ＊＊＊");
  assert.equal(maskText("www.example.jp"), "＊＊＊");
  assert.equal(maskText("discord.gg/abcd に来て"), "＊＊＊ に来て");
});

test("暴言を伏せる", () => {
  assert.equal(maskText("お前死ね"), "お前＊＊＊");
  assert.equal(maskText("殺すぞマジで"), "＊＊＊マジで");
});

test("整形：前後の空白・制御文字・空行を取り除き、長さと行数を制限する", () => {
  assert.deepEqual(cleanChatText("  信じてる  "), { ok: true, text: "信じてる", masked: false });
  assert.deepEqual(cleanChatText("a\u0000b​c"), { ok: true, text: "abc", masked: false });
  assert.deepEqual(cleanChatText("1行目\r\n\r\n\r\n2行目"), { ok: true, text: "1行目\n2行目", masked: false });
  assert.equal(cleanChatText("   ").ok, false);
  assert.equal(cleanChatText("あ".repeat(201)).ok, false);
  assert.equal(cleanChatText("あ".repeat(200)).ok, true);
  assert.equal(cleanChatText("1\n2\n3\n4\n5").ok, false);
  assert.deepEqual(cleanChatText("死ね"), { ok: true, text: "＊＊＊", masked: true });
});

test("連投の制限：10秒に5件まで", () => {
  const rl = new RateLimiter(5, 10_000);
  for (let i = 0; i < 5; i++) assert.equal(rl.take("a", i * 100), true);
  assert.equal(rl.take("a", 600), false);
  assert.equal(rl.take("b", 600), true, "人ごとに数える");
  assert.equal(rl.take("a", 10_001), true, "時間がたてばまた送れる");
});
