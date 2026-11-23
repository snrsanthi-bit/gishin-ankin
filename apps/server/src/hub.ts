/**
 * 接続と部屋の受付係。WebSocket ライブラリには依存しない（Conn は send だけを持つ）。
 * - 入室してきた人を、空きのある待機中の部屋に入れる（なければ作る）
 * - メッセージを部屋の操作に変える
 * - 状態が変わったら、その部屋の全員に、それぞれの見え方で画面情報を送る
 */
import { randomUUID } from "node:crypto";
import { DEFAULT_ROOM_CONFIG, Room, type RoomConfig } from "./room.ts";
import { parseClientMessage, type ServerMessage } from "./protocol.ts";

export interface Conn {
  send(text: string): void;
}

export type HubOptions = {
  roomConfig?: RoomConfig;
  /** 部屋ごとの乱数の種。テストで固定するときに使う */
  seed?: number;
  newId?: () => string;
};

export class Hub {
  private readonly roomConfig: RoomConfig;
  private seed: number;
  private readonly newId: () => string;
  private rooms: Room[] = [];
  private readonly roomOf = new Map<string, Room>();
  private readonly connsOf = new Map<string, Set<Conn>>();
  private readonly playerOf = new Map<Conn, string>();

  constructor(options: HubOptions = {}) {
    this.roomConfig = options.roomConfig ?? DEFAULT_ROOM_CONFIG;
    this.seed = options.seed ?? Math.floor(Math.random() * 1e9);
    this.newId = options.newId ?? randomUUID;
  }

  get roomCount(): number {
    return this.rooms.length;
  }

  handle(conn: Conn, raw: string, now: number): void {
    const msg = parseClientMessage(raw);
    if (!msg) return send(conn, { type: "error", message: "メッセージの形が正しくありません" });

    if (msg.type === "join") return this.join(conn, msg.playerId, now);

    const id = this.playerOf.get(conn);
    const room = id ? this.roomOf.get(id) : undefined;
    if (!id || !room) return send(conn, { type: "error", message: "先に入室してください" });

    switch (msg.type) {
      case "input": {
        const r = room.setInput(id, msg.amount);
        if (!r.ok) return send(conn, { type: "error", message: r.error });
        break;
      }
      case "confirm": {
        const r = room.confirm(id, msg.confirmed);
        if (!r.ok) return send(conn, { type: "error", message: r.error });
        room.tick(now); // 全員そろったらすぐ締め切る
        break;
      }
      case "checkMoney": {
        const r = room.checkMoney(id, msg.seat);
        if (!r.ok) return send(conn, { type: "error", message: r.error });
        send(conn, { type: "moneyCheck", seat: msg.seat, money: r.value });
        break;
      }
      case "next": {
        if (room.phase !== "finished") return send(conn, { type: "error", message: "試合はまだ終わっていません" });
        this.roomOf.delete(id);
        return this.join(conn, id, now);
      }
    }
    this.broadcast(room, now);
  }

  disconnect(conn: Conn): void {
    const id = this.playerOf.get(conn);
    this.playerOf.delete(conn);
    if (!id) return;
    const conns = this.connsOf.get(id);
    conns?.delete(conn);
    if (conns && conns.size > 0) return; // 別のタブでまだつながっている
    this.connsOf.delete(id);
    const room = this.roomOf.get(id);
    if (!room) return;
    room.leave(id);
    if (room.phase === "waiting") this.roomOf.delete(id);
    this.broadcast(room, Date.now());
    this.cleanup();
  }

  /** 定期的に呼ぶ。締め切りを過ぎたゲームを締め切り、全員に知らせる */
  tick(now: number): void {
    for (const room of this.rooms) {
      if (room.tick(now)) this.broadcast(room, now);
    }
    this.cleanup();
  }

  private join(conn: Conn, requestedId: string | undefined, now: number): void {
    const prev = this.playerOf.get(conn);
    if (prev && prev !== requestedId) this.disconnect(conn);

    // MVPではログインがないので、playerId を知っていれば入り直せる（推測されにくいランダムなidを使う）
    const id = requestedId ?? this.newId();
    let room = this.roomOf.get(id);
    if (room?.phase === "finished") {
      this.roomOf.delete(id);
      room = undefined;
    }
    if (room) {
      room.join(id, now); // 入り直し：前回の部屋がまだ続いていれば、同じ席へ戻す
    } else {
      // 待機中の部屋は4人そろった時点で試合が始まるので、待機中なら必ず空きがある
      room = this.rooms.find((r) => r.phase === "waiting") ?? this.createRoom();
      room.join(id, now);
      this.roomOf.set(id, room);
    }

    this.playerOf.set(conn, id);
    const conns = this.connsOf.get(id) ?? new Set<Conn>();
    conns.add(conn);
    this.connsOf.set(id, conns);

    send(conn, { type: "welcome", playerId: id });
    this.broadcast(room, now);
  }

  private createRoom(): Room {
    const room = new Room(this.roomConfig, this.seed++);
    this.rooms.push(room);
    return room;
  }

  private broadcast(room: Room, now: number): void {
    for (const id of room.playerIds()) {
      if (this.roomOf.get(id) !== room) continue; // もう次の部屋へ移った人には送らない
      const v = room.viewFor(id);
      if (!v.ok) continue;
      for (const conn of this.connsOf.get(id) ?? []) send(conn, { type: "view", view: v.value, now });
    }
  }

  /** 終わった部屋で、もう誰も見ていないものを片付ける */
  private cleanup(): void {
    this.rooms = this.rooms.filter((room) => {
      if (room.phase !== "finished") return true;
      const watching = room.playerIds().some((id) => this.roomOf.get(id) === room && this.connsOf.has(id));
      if (!watching) for (const id of room.playerIds()) if (this.roomOf.get(id) === room) this.roomOf.delete(id);
      return watching;
    });
  }
}

function send(conn: Conn, msg: ServerMessage): void {
  conn.send(JSON.stringify(msg));
}
