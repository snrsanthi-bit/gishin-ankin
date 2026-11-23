import { test } from "node:test";
import assert from "node:assert/strict";
import { Hub, type Conn } from "./hub.ts";
import { parseClientMessage, type ServerMessage } from "./protocol.ts";
import { DEFAULT_ROOM_CONFIG } from "./room.ts";

class FakeConn implements Conn {
  readonly inbox: ServerMessage[] = [];
  send(text: string): void {
    this.inbox.push(JSON.parse(text) as ServerMessage);
  }
  last<T extends ServerMessage["type"]>(type: T): Extract<ServerMessage, { type: T }> | undefined {
    for (let i = this.inbox.length - 1; i >= 0; i--) {
      const m = this.inbox[i];
      if (m?.type === type) return m as Extract<ServerMessage, { type: T }>;
    }
    return undefined;
  }
}

let n = 0;
const hubWith = () => new Hub({ seed: 1, newId: () => `p${++n}` });
const send = (hub: Hub, c: Conn, msg: object, now = 0) => hub.handle(c, JSON.stringify(msg), now);

function fourJoined(hub: Hub) {
  const conns = [0, 1, 2, 3].map(() => new FakeConn());
  for (const c of conns) send(hub, c, { type: "join" });
  return conns;
}

test("メッセージの形を確かめる", () => {
  assert.deepEqual(parseClientMessage('{"type":"input","amount":10}'), { type: "input", amount: 10 });
  assert.deepEqual(parseClientMessage('{"type":"join"}'), { type: "join" });
  assert.equal(parseClientMessage('{"type":"join","playerId":"../x"}'), null);
  assert.equal(parseClientMessage('{"type":"input","amount":"10"}'), null);
  assert.equal(parseClientMessage("not json"), null);
  assert.equal(parseClientMessage('{"type":"hack"}'), null);
});

test("入室するとidが渡され、4人そろうと全員に試合の画面が届く", () => {
  const hub = hubWith();
  const conns = fourJoined(hub);
  for (const c of conns) {
    assert.ok(c.last("welcome")?.playerId);
    assert.equal(c.last("view")?.view.phase, "playing");
  }
  assert.equal(hub.roomCount, 1);
});

test("5人目は新しい部屋で待つ", () => {
  const hub = hubWith();
  fourJoined(hub);
  const fifth = new FakeConn();
  send(hub, fifth, { type: "join" });
  assert.deepEqual(fifth.last("view")?.view, { phase: "waiting", joined: 1, players: 4 });
  assert.equal(hub.roomCount, 2);
});

test("全員が確定すると、その場で次のゲームの画面が全員に届く", () => {
  const hub = hubWith();
  const conns = fourJoined(hub);
  for (const c of conns) {
    send(hub, c, { type: "input", amount: 100 });
    send(hub, c, { type: "confirm", confirmed: true });
  }
  for (const c of conns) {
    const v = c.last("view")?.view;
    assert.ok(v && v.phase === "playing");
    assert.equal(v.game, 1);
    assert.equal(v.you.money, 120);
  }
});

test("締め切りは tick で進む", () => {
  const hub = hubWith();
  const conns = fourJoined(hub);
  hub.tick(DEFAULT_ROOM_CONFIG.thinkMs - 1);
  const v1 = conns[0]?.last("view")?.view;
  assert.ok(v1 && v1.phase === "playing" && v1.game === 0);
  hub.tick(DEFAULT_ROOM_CONFIG.thinkMs);
  const v2 = conns[0]?.last("view")?.view;
  assert.ok(v2 && v2.phase === "playing" && v2.game === 1);
});

test("所持金確認の結果は本人にだけ届く", () => {
  const hub = hubWith();
  const conns = fourJoined(hub);
  const [a, b] = conns;
  assert.ok(a && b);
  const bView = b.last("view")?.view;
  assert.ok(bView && bView.phase === "playing");
  send(hub, a, { type: "checkMoney", seat: bView.you.seat });
  assert.deepEqual(a.last("moneyCheck"), { type: "moneyCheck", seat: bView.you.seat, money: 100 });
  assert.equal(b.last("moneyCheck"), undefined);
});

test("切断してもidを渡せば同じ席に戻れる", () => {
  const hub = hubWith();
  const conns = fourJoined(hub);
  const c = conns[2];
  assert.ok(c);
  const id = c.last("welcome")?.playerId;
  const seat = (() => {
    const v = c.last("view")?.view;
    return v && v.phase !== "waiting" ? v.you.seat : -1;
  })();
  hub.disconnect(c);
  const other = conns[0]?.last("view")?.view;
  assert.ok(other && other.phase === "playing");
  assert.equal(other.seats.find((s) => s.seat === seat)?.connected, false);

  const again = new FakeConn();
  send(hub, again, { type: "join", playerId: id });
  const v = again.last("view")?.view;
  assert.ok(v && v.phase === "playing");
  assert.equal(v.you.seat, seat);
});

test("待機中に切断すると部屋から外れる", () => {
  const hub = hubWith();
  const a = new FakeConn();
  const b = new FakeConn();
  send(hub, a, { type: "join" });
  send(hub, b, { type: "join" });
  hub.disconnect(a);
  assert.deepEqual(b.last("view")?.view, { phase: "waiting", joined: 1, players: 4 });
});

test("入室前の操作や、試合中の next はエラーになる", () => {
  const hub = hubWith();
  const c = new FakeConn();
  send(hub, c, { type: "input", amount: 1 });
  assert.equal(c.last("error")?.type, "error");
  const conns = fourJoined(hub);
  const a = conns[0];
  assert.ok(a);
  send(hub, a, { type: "next" });
  assert.match(a.last("error")?.message ?? "", /まだ終わっていません/);
});

test("試合が終わったら next で次の部屋へ。誰も見ていない部屋は片付く", () => {
  const hub = hubWith();
  const conns = fourJoined(hub);
  for (let g = 0; g < 5; g++) {
    for (const c of conns) {
      const v = c.last("view")?.view;
      assert.ok(v && v.phase !== "waiting");
      send(hub, c, { type: "input", amount: v.you.money });
      send(hub, c, { type: "confirm", confirmed: true });
    }
  }
  const done = conns[0]?.last("view")?.view;
  assert.ok(done && done.phase === "finished" && done.finished?.draw === true);
  for (const c of conns) send(hub, c, { type: "next" });
  const v = conns[3]?.last("view")?.view;
  assert.ok(v && v.phase === "playing" && v.game === 0, "4人そろって次の試合");
  hub.tick(1);
  assert.equal(hub.roomCount, 1, "終わった部屋は片付いた");
});
