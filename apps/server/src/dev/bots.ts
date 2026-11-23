/**
 * 動作確認用：サーバーにBotをつなぐ。ブラウザ1つ＋Bot3体で、ひとりでも試合を試せる。
 *
 *   pnpm bots                       Botを3体つなぐ（種類はランダム）
 *   pnpm bots --n=4                 4体（Botだけで1試合）
 *   pnpm bots --kinds=smart,grudger,allIn
 *   pnpm bots --url=ws://localhost:9000/ws --loop   試合が終わったら次の試合へ
 */
import WebSocket from "ws";
import { BOT_KINDS, createBot, createRng, type BotKind, type BotView } from "@gishin-ankin/rules";
import type { ClientMessage, ServerMessage } from "../protocol.ts";

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k ?? "", v ?? "true"] as const;
  }),
);
const url = args.get("url") ?? "ws://localhost:8787/ws";
const count = Number(args.get("n") ?? 3);
const loop = args.has("loop");
const rng = createRng(Number(args.get("seed") ?? Date.now()));
const kinds = (args.get("kinds") ?? "").split(",").filter(Boolean) as BotKind[];

for (let i = 0; i < count; i++) {
  const kind = kinds[i] ?? BOT_KINDS[Math.floor(rng() * BOT_KINDS.length)] ?? "allIn";
  connectBot(`Bot${i + 1}`, kind);
}

function connectBot(name: string, kind: BotKind) {
  const bot = createBot(kind, rng);
  const ws = new WebSocket(url);
  const send = (m: ClientMessage) => ws.send(JSON.stringify(m));
  let decidedGame = -1;

  ws.on("open", () => send({ type: "join" }));
  ws.on("error", (e) => console.error(`${name}：接続できません（${e.message}）`));
  ws.on("message", (data) => {
    const msg = JSON.parse(String(data)) as ServerMessage;
    if (msg.type === "error") console.log(`${name}：${msg.message}`);
    if (msg.type !== "view") return;
    const v = msg.view;
    if (v.phase === "waiting") return;

    if (v.phase === "finished" && v.finished) {
      if (decidedGame !== -2) {
        console.log(`${name}（${bot.label}）：${v.finished.draw ? "Draw" : "終了"} 持ち帰り${v.finished.money}万 ${v.finished.rank}位`);
        decidedGame = -2;
        if (loop) setTimeout(() => send({ type: "next" }), 3000);
      }
      return;
    }
    if (v.game === decidedGame || v.you.forfeited) return;
    decidedGame = v.game;

    const view: BotView = {
      game: v.game,
      gamesPerMatch: v.gamesPerMatch,
      drawStreak: v.drawStreak,
      money: v.you.money,
      streak: v.streak,
      isTop: v.isTop,
      streakBroken: v.last !== null && v.last.streakAfter === 0,
      myLastAllIn: v.last !== null && v.last.moneyBefore >= 1 && v.last.contribution === v.last.moneyBefore,
    };
    const amount = bot.decide(view) ?? 0;
    // 人間らしく、少し考えてから出す
    setTimeout(() => {
      send({ type: "input", amount });
      send({ type: "confirm", confirmed: true });
    }, 500 + rng() * 2000);
  });
}
