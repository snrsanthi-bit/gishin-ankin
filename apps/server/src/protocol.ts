/**
 * ブラウザとサーバーの間でやり取りするメッセージ（JSON）。
 * 画面側もこの型を使う。
 */
import type { RoomView } from "./room.ts";

export type { RoomView, SeatView, LastGameView, FinishedView } from "./room.ts";

/** ブラウザ → サーバー */
export type ClientMessage =
  /** 入室。前回もらった playerId を渡すと、同じ席に入り直せる */
  | { type: "join"; playerId?: string }
  | { type: "input"; amount: number }
  | { type: "confirm"; confirmed: boolean }
  | { type: "checkMoney"; seat: number }
  /** 試合が終わった部屋を出て、次の試合を探す */
  | { type: "next" };

/** サーバー → ブラウザ */
export type ServerMessage =
  /** 入室できた。playerId は保存しておき、再接続のときに渡す */
  | { type: "welcome"; playerId: string }
  /** 画面に出す情報。now はサーバーの時刻（締め切りまでの残り時間の計算用） */
  | { type: "view"; view: RoomView; now: number }
  | { type: "moneyCheck"; seat: number; money: number }
  | { type: "error"; message: string };

/** 受け取った文字列を ClientMessage として読む。形がおかしければ null */
export function parseClientMessage(raw: string): ClientMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const m = data as Record<string, unknown>;
  switch (m["type"]) {
    case "join": {
      const id = m["playerId"];
      if (id === undefined) return { type: "join" };
      return typeof id === "string" && /^[\w-]{1,64}$/.test(id) ? { type: "join", playerId: id } : null;
    }
    case "input":
      return typeof m["amount"] === "number" ? { type: "input", amount: m["amount"] } : null;
    case "confirm":
      return typeof m["confirmed"] === "boolean" ? { type: "confirm", confirmed: m["confirmed"] } : null;
    case "checkMoney":
      return typeof m["seat"] === "number" ? { type: "checkMoney", seat: m["seat"] } : null;
    case "next":
      return { type: "next" };
    default:
      return null;
  }
}
