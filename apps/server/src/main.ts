/**
 * サーバー本体：HTTP と WebSocket（/ws）で受け付け、Hub に渡す。
 *
 *   pnpm dev:server                      ポート8787で起動（ファイルを変えると自動で再起動）
 *   PORT=9000 THINK_SEC=20 pnpm dev:server   ポートと出資受付時間を変える（動作確認用）
 */
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { Hub, type Conn } from "./hub.ts";
import { DEFAULT_ROOM_CONFIG } from "./room.ts";

const port = Number(process.env["PORT"] ?? 8787);
const thinkSec = Number(process.env["THINK_SEC"] ?? DEFAULT_ROOM_CONFIG.thinkMs / 1000);

const hub = new Hub({ roomConfig: { ...DEFAULT_ROOM_CONFIG, thinkMs: thinkSec * 1000 } });

const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }
  res.writeHead(404).end();
});

// 1メッセージは小さいJSONだけなので、大きすぎるものは受け付けない
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 4 * 1024 });

wss.on("connection", (ws) => {
  const conn: Conn = {
    send: (text) => {
      if (ws.readyState === ws.OPEN) ws.send(text);
    },
  };
  ws.on("message", (data) => hub.handle(conn, String(data), Date.now()));
  ws.on("close", () => hub.disconnect(conn));
  ws.on("error", () => hub.disconnect(conn));
});

setInterval(() => hub.tick(Date.now()), 250);

server.listen(port, () => {
  console.log(`サーバー起動：ws://localhost:${port}/ws（出資受付 ${thinkSec}秒）`);
});
