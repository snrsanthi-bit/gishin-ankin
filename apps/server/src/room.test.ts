import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ROOM_CONFIG, Room, type RoomView } from "./room.ts";

const IDS = ["a", "b", "c", "d"];
// 締め切りから結果表示までの間を0にした設定（間のテストは下で別に行う）
const CFG = { ...DEFAULT_ROOM_CONFIG, revealDelayMs: 0 };
const THINK = DEFAULT_ROOM_CONFIG.thinkMs;

function fullRoom(seed = 1): Room {
  const room = new Room(CFG, seed);
  for (const id of IDS) assert.ok(room.join(id, 0).ok);
  return room;
}
function view(room: Room, id: string): Extract<RoomView, { phase: "playing" | "finished" }> {
  const v = room.viewFor(id);
  assert.ok(v.ok);
  assert.notEqual(v.value.phase, "waiting");
  return v.value as Extract<RoomView, { phase: "playing" | "finished" }>;
}
function allIn(room: Room) {
  for (const id of IDS) {
    room.setInput(id, view(room, id).you.money);
    room.confirm(id);
  }
}

test("4人そろうまで待機し、そろったら試合が始まる。席番号はランダム", () => {
  const room = new Room(CFG, 3);
  room.join("a", 0);
  assert.deepEqual(room.viewFor("a"), { ok: true, value: { phase: "waiting", joined: 1, players: 4 } });
  room.join("b", 0);
  room.join("c", 0);
  room.join("d", 0);
  assert.equal(room.phase, "playing");
  const seats = IDS.map((id) => view(room, id).you.seat).sort();
  assert.deepEqual(seats, [0, 1, 2, 3]);
  assert.equal(room.join("e", 0).ok, false);
});

test("全員が確定したら、締め切りを待たずに次のゲームへ進む", () => {
  const room = fullRoom();
  allIn(room);
  assert.equal(room.tick(1000), true);
  const v = view(room, "a");
  assert.equal(v.game, 1);
  assert.equal(v.you.money, 120);
  assert.equal(v.streak, 1);
  assert.equal(v.deadline, 1000 + THINK);
});

test("確定していない人がいれば、締め切りまで進まない", () => {
  const room = fullRoom();
  for (const id of IDS.slice(0, 3)) room.confirm(id);
  assert.equal(room.tick(THINK - 1), false);
  assert.equal(room.tick(THINK), true);
});

test("締め切りでは入力中の額で確定し、未入力は不在（0円）として扱う", () => {
  const room = fullRoom();
  room.setInput("a", 40); // 確定していないが入力はある
  assert.equal(room.tick(THINK), true);
  const a = view(room, "a");
  assert.equal(a.last?.contribution, 40);
  // 単独出資：100 − 40 + 10 + 40 = 110
  assert.equal(a.you.money, 110);
  assert.equal(view(room, "b").last?.contribution, 0);
});

test("入力を変えると確定は取り消される。所持金を超える入力はできない", () => {
  const room = fullRoom();
  room.setInput("a", 50);
  room.confirm("a");
  assert.equal(view(room, "a").you.confirmed, true);
  room.setInput("a", 60);
  assert.equal(view(room, "a").you.confirmed, false);
  assert.equal(room.setInput("a", 101).ok, false);
  assert.equal(room.setInput("a", 1.5).ok, false);
});

test("他人の所持金や入力は見えない。確定済みかどうかは見える", () => {
  const room = fullRoom();
  room.setInput("b", 77);
  room.confirm("b");
  const v = view(room, "a");
  const json = JSON.stringify(v);
  assert.ok(!json.includes("77"), "他人の入力額が含まれない");
  const bSeat = view(room, "b").you.seat;
  assert.equal(v.seats.find((s) => s.seat === bSeat)?.confirmed, true);
});

test("所持金確認は1試合1回、ゲーム開始時の額を返す", () => {
  const room = fullRoom();
  const bSeat = view(room, "b").you.seat;
  room.setInput("b", 30); // 入力中の額は反映されない
  const r = room.checkMoney("a", bSeat);
  assert.deepEqual(r, { ok: true, value: 100 });
  assert.equal(room.checkMoney("a", bSeat).ok, false);
  assert.equal(room.checkMoney("b", view(room, "b").you.seat).ok, false, "自分は確認できない");
});

test("3ゲーム続けて不在で棄権。棄権した人がいても残りの全員確定で進む", () => {
  const room = fullRoom();
  for (let g = 0; g < 3; g++) {
    for (const id of IDS.slice(0, 3)) room.confirm(id);
    assert.equal(room.tick((g + 1) * THINK), true, "d が確定しないので締め切りまで待つ");
  }
  assert.equal(view(room, "d").you.forfeited, true);
  assert.equal(room.setInput("d", 10).ok, false);
  for (const id of IDS.slice(0, 3)) room.confirm(id);
  assert.equal(room.tick(3 * THINK + 1), true, "棄権者を除いた全員が確定したので進む");
});

test("切断しても試合は続き、同じidで入り直せる", () => {
  const room = fullRoom();
  room.leave("c");
  const cSeat = view(room, "c").you.seat;
  assert.equal(view(room, "a").seats.find((s) => s.seat === cSeat)?.connected, false);
  assert.ok(room.join("c", 10).ok);
  assert.equal(view(room, "a").seats.find((s) => s.seat === cSeat)?.connected, true);
});

test("5連続の全員全額でDraw。試合後に牌譜と次の参加費が見られる", () => {
  const room = fullRoom();
  for (let g = 0; g < 5; g++) {
    allIn(room);
    room.tick(g);
  }
  assert.equal(room.phase, "finished");
  const f = view(room, "a").finished;
  assert.ok(f);
  assert.equal(f.draw, true);
  assert.equal(f.money, 247);
  assert.equal(f.rank, 1);
  assert.equal(f.nextFee, 100);
  assert.equal(f.record.length, 5);
  assert.deepEqual(f.record[0], [100, 100, 100, 100]);
  assert.equal(view(room, "a").deadline, null);
});

test("試合中でないときの操作はエラーになる", () => {
  const room = new Room(CFG, 1);
  room.join("a", 0);
  assert.equal(room.setInput("a", 10).ok, false);
  assert.equal(room.viewFor("zz").ok, false);
});

test("運営用の記録には元の文章と送った人が残る", () => {
  const room = fullRoom();
  const r = room.sendChat("a", "死ね", 1);
  assert.ok(r.ok);
  assert.equal(r.value.text, "＊＊＊");
  const rec = room.chatRecordForOperator()[0];
  assert.equal(rec?.original, "死ね");
  assert.equal(rec?.playerId, "a");
  assert.deepEqual(room.chatHistory().map((m) => m.text), ["＊＊＊"]);
  assert.ok(!("original" in (room.chatHistory()[0] ?? {})), "参加者向けの履歴に元の文章は入らない");
});

test("ゲームごとの結果（全員全額か）が画面情報に並ぶ", () => {
  const room = fullRoom();
  allIn(room);
  room.tick(1);
  room.setInput("a", 0);
  for (const id of IDS) room.confirm(id);
  room.tick(2);
  assert.deepEqual(view(room, "b").outcomes, [true, false]);
  assert.equal(view(room, "b").thinkMs, THINK);
});

test("締め切ってから結果の表示まで間を置き、その間は結果を画面情報に出さない", () => {
  const DELAY = 2500;
  const room = new Room({ ...DEFAULT_ROOM_CONFIG, revealDelayMs: DELAY }, 1);
  for (const id of IDS) room.join(id, 0);
  allIn(room);
  assert.equal(room.tick(1000), true, "全員確定で締め切る");
  const during = view(room, "a");
  assert.equal(during.stage, "revealing");
  assert.equal(during.revealAt, 1000 + DELAY);
  assert.equal(during.deadline, null);
  assert.equal(during.game, 0, "まだ次のゲームにならない");
  assert.equal(during.you.money, 100, "所持金はまだ前のまま");
  assert.deepEqual(during.outcomes, [], "●／×もまだ出さない");
  assert.equal(during.last, null);
  assert.ok(during.seats.every((s) => !s.confirmed), "封筒は回収される");

  assert.equal(room.setInput("a", 1).ok, false, "集計中は出資できない");
  assert.equal(room.confirm("a").ok, false);
  assert.equal(room.checkMoney("a", (view(room, "a").you.seat + 1) % 4).ok, false);
  assert.equal(room.sendChat("a", "どうだ", 1500).ok, true, "集計中もチャットはできる");

  assert.equal(room.tick(1000 + DELAY - 1), false);
  assert.equal(room.tick(1000 + DELAY + 200), true);
  const after = view(room, "a");
  assert.equal(after.stage, "accepting");
  assert.equal(after.game, 1);
  assert.equal(after.you.money, 120);
  assert.deepEqual(after.outcomes, [true]);
  assert.equal(after.deadline, 1000 + DELAY + DEFAULT_ROOM_CONFIG.thinkMs, "次の締め切りは表示の時刻から数える");
});

test("連続が途切れたときも、つながったときも、間の長さは同じ", () => {
  const DELAY = 2500;
  const room = new Room({ ...DEFAULT_ROOM_CONFIG, revealDelayMs: DELAY }, 1);
  for (const id of IDS) room.join(id, 0);
  room.setInput("a", 0);
  for (const id of IDS) room.confirm(id);
  room.tick(500);
  assert.equal(view(room, "b").revealAt, 500 + DELAY);
});
