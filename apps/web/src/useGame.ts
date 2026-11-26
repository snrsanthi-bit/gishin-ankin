/**
 * サーバーとの接続と、受け取った画面情報を持つフック。
 * - 「試合を探す」で接続して入室する
 * - もらった playerId をブラウザに保存し、切れたら自動でつなぎ直して同じ席に戻る
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage, ClientMessage, RoomView, ServerMessage } from "@gishin-ankin/server/protocol";

const ID_KEY = "gishin-ankin:playerId";

function loadId(): string | undefined {
  try {
    return localStorage.getItem(ID_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}
function saveId(id: string): void {
  try {
    localStorage.setItem(ID_KEY, id);
  } catch {
    // 保存できなくても遊べる（つなぎ直しで同じ席に戻れないだけ）
  }
}

export type MoneyCheck = { game: number; seat: number; money: number };
export type Status = "idle" | "connecting" | "open" | "reconnecting";

export function useGame() {
  const [status, setStatus] = useState<Status>("idle");
  const [view, setView] = useState<RoomView | null>(null);
  const [checks, setChecks] = useState<MoneyCheck[]>([]);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** サーバー時刻 − 手元の時刻（残り時間の計算用） */
  const [offset, setOffset] = useState(0);

  const ws = useRef<WebSocket | null>(null);
  const wanted = useRef(false); // 利用者が「試合を探す」を押していて、つながっていてほしい状態か
  const viewRef = useRef<RoomView | null>(null);

  const connect = useCallback(() => {
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    const sock = new WebSocket(url);
    ws.current = sock;

    sock.onopen = () => {
      setStatus("open");
      const playerId = loadId();
      const msg: ClientMessage = playerId ? { type: "join", playerId } : { type: "join" };
      sock.send(JSON.stringify(msg));
    };
    sock.onmessage = (e: MessageEvent<string>) => {
      const msg = JSON.parse(e.data) as ServerMessage;
      switch (msg.type) {
        case "welcome":
          saveId(msg.playerId);
          break;
        case "view": {
          setOffset(msg.now - Date.now());
          const prev = viewRef.current;
          // 新しい試合が始まったら、前の試合の所持金確認の結果とチャットは消す
          const newMatch =
            msg.view.phase === "waiting" ||
            (prev !== null && prev.phase !== "waiting" && (msg.view.game < prev.game || prev.phase === "finished") && msg.view.phase === "playing");
          if (newMatch) {
            setChecks([]);
            setChat([]);
          }
          viewRef.current = msg.view;
          setView(msg.view);
          break;
        }
        case "moneyCheck": {
          const v = viewRef.current;
          const game = v && v.phase !== "waiting" ? v.game : 0;
          setChecks((c) => [...c, { game, seat: msg.seat, money: msg.money }]);
          break;
        }
        case "chat":
          setChat((c) => (c.some((m) => m.id === msg.message.id) ? c : [...c, msg.message]));
          break;
        case "chatHistory":
          setChat(msg.messages);
          break;
        case "error":
          setError(msg.message);
          setTimeout(() => setError((cur) => (cur === msg.message ? null : cur)), 4000);
          break;
      }
    };
    sock.onclose = () => {
      if (ws.current !== sock) return;
      ws.current = null;
      if (wanted.current) {
        setStatus("reconnecting");
        setTimeout(() => {
          if (wanted.current && !ws.current) connect();
        }, 1500);
      } else {
        setStatus("idle");
      }
    };
  }, []);

  const start = useCallback(() => {
    wanted.current = true;
    setStatus("connecting");
    if (!ws.current) connect();
  }, [connect]);

  const send = useCallback((msg: ClientMessage) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(msg));
  }, []);

  useEffect(
    () => () => {
      wanted.current = false;
      ws.current?.close();
    },
    [],
  );

  const sendChat = useCallback((text: string) => send({ type: "chat", text }), [send]);

  return { status, view, checks, chat, error, offset, start, send, sendChat };
}
