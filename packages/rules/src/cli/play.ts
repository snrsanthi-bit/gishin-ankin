/**
 * ターミナルで1試合遊ぶ（あなた1人＋Bot3体）。人生のお金は動かない練習用。
 *
 *   pnpm play                         Botはランダムに3体
 *   pnpm play --seed=42               同じ並びをもう一度
 *   pnpm play --bots=smart,grudger,allIn
 *
 * Botの種類：allIn / freeRider / random / grudger / smart
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { DEFAULT_CONFIG, YEN_PER_MAN } from "../config.ts";
import type { Contribution, GameResult, MatchState } from "../game.ts";
import { BOT_KINDS, BOT_LABELS, botViewOf, createBot, type Bot, type BotKind } from "../bots.ts";
import { createRng, shuffled } from "../random.ts";
import { playMatch, type Decider } from "../match.ts";

const config = DEFAULT_CONFIG;
const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k ?? "", v ?? ""] as const;
  }),
);
const seed = args.has("seed") ? Number(args.get("seed")) : Math.floor(Math.random() * 1e9);
const rng = createRng(seed);

const requested = (args.get("bots") ?? "").split(",").filter(Boolean) as BotKind[];
for (const k of requested) {
  if (!BOT_KINDS.includes(k)) {
    console.error(`知らないBotの種類です：${k}（使えるもの：${BOT_KINDS.join(", ")}）`);
    process.exit(1);
  }
}
const kinds: BotKind[] = requested.length === 3 ? requested : shuffled(BOT_KINDS, rng).slice(0, 3);

// 席はランダム。あなたの席番号も毎回変わる
const seatOrder = shuffled(["you", ...kinds] as const, rng);
const youSeat = seatOrder.indexOf("you");
const bots = new Map<number, Bot>();
seatOrder.forEach((k, i) => {
  if (k !== "you") bots.set(i, createBot(k, rng));
});

const man = (yen: number) => {
  const v = yen / YEN_PER_MAN;
  return Number.isInteger(v) ? `${v}万` : `${v.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}万`;
};
const P = (i: number) => `P${i + 1}`;

// 1行ずつ読む（貼り付けやパイプで複数行まとめて入っても取りこぼさないよう、行を順番に受け取る）
const rl = createInterface({ input: stdin });
const lines = rl[Symbol.asyncIterator]();
async function ask(prompt: string): Promise<string> {
  stdout.write(prompt);
  const next = await lines.next();
  if (next.done) {
    console.log("\n入力が終わったので、試合を中断します");
    process.exit(0);
  }
  return next.value;
}
let moneyCheckUsed = false;

const help = `
  数字      その額を出資（1万円単位、0〜所持金）
  a / 全    全額出資
  c 番号    所持金確認（1試合1回。例：c 3 → P3 のゲーム開始時の所持金）
  ?         このヘルプ
`;

async function askHuman(state: MatchState): Promise<Contribution> {
  const seat = state.seats[youSeat];
  if (!seat) return 0;
  const active = state.seats.filter((s) => !s.forfeited).map((s) => s.money);
  console.log(`\n── ゲーム ${state.gamesPlayed + 1}/${config.gamesPerMatch} ──`);
  console.log(`あなた（${P(youSeat)}）の所持金：${seat.money}万`);
  console.log(`全員全額の連続：${state.streak}回（Drawまであと${config.drawStreak - state.streak}回）`);
  if (seat.money >= Math.max(...active)) console.log("★ あなたが1位です");
  for (;;) {
    const line = (await ask(`出資額（0〜${seat.money}、a=全額、?=ヘルプ）> `)).trim();
    if (line === "?") {
      console.log(help);
      continue;
    }
    if (line === "a" || line === "全") return seat.money;
    const check = line.match(/^c\s*(\d)$/);
    if (check) {
      const t = Number(check[1]) - 1;
      if (moneyCheckUsed) console.log("所持金確認は、この試合ではもう使いました");
      else if (t === youSeat || !state.seats[t]) console.log("確認できない番号です");
      else {
        moneyCheckUsed = true;
        console.log(`${P(t)} のゲーム開始時の所持金：${state.seats[t]?.money}万`);
      }
      continue;
    }
    if (/^\d+$/.test(line)) {
      const n = Number(line);
      if (n <= seat.money) return n;
      console.log("所持金を超えています");
      continue;
    }
    console.log("入力が読めませんでした（? でヘルプ）");
  }
}

const deciders: Decider[] = seatOrder.map((_, i) => {
  if (i === youSeat) return (state) => askHuman(state);
  const bot = bots.get(i);
  return (state, seat, last) => (bot ? bot.decide(botViewOf(config, state, seat, last)) : 0);
});

function showResult(r: GameResult, state: MatchState) {
  const me = r.seats[youSeat];
  if (!me) return;
  console.log(`→ 出資 ${me.contribution}万 ／ 分配 ${man(me.distributionYen)} ／ ボーナス ${man(me.bonusYen)} ／ 所持金 ${me.moneyAfter}万`);
  if (r.kind === "none") console.log("  誰も出資しませんでした");
  else if (r.kind === "allIn") console.log(`  全員が全額出資！ 連続 ${state.streak}回`);
  else console.log("  連続が途切れました（誰かが全額出資しなかった）");
  if (state.draw) console.log("\n🤝 Draw成立！ 全員の所持金を平均にそろえました");
}

console.log(`疑心暗金 — 練習試合（seed=${seed}）`);
console.log(`あなたは ${P(youSeat)} です。他の3人はBotです。? でヘルプ`);

const record = await playMatch(config, deciders, showResult);
const finalMoney = record.final.seats.map((s) => s.money);
const mine = finalMoney[youSeat] ?? 0;
const rank = 1 + finalMoney.filter((m) => m > mine).length;

console.log(`\n══ 試合終了（${record.games.length}ゲーム${record.final.draw ? "・Draw" : ""}）══`);
console.log(`持ち帰り：${mine}万 ／ 順位：${rank}位`);
console.log(`次の参加費：${record.nextFee}万 → 実質 ${mine - record.nextFee >= 0 ? "+" : ""}${mine - record.nextFee}万`);

const see = (await ask("\n牌譜を見ますか？（y/N）> ")).trim().toLowerCase();
if (see === "y") {
  console.log(`\n      ${seatOrder.map((_, i) => P(i).padStart(6)).join("")}`);
  record.games.forEach((g, gi) => {
    const cells = g.seats.map((s) => (s ? `${s.contribution}`.padStart(6) : "  棄権"));
    console.log(`G${String(gi + 1).padStart(2)}   ${cells.join("")}   ${g.kind === "allIn" ? "全員全額" : ""}`);
  });
  console.log(`最終  ${finalMoney.map((m) => `${m}`.padStart(6)).join("")}`);
  console.log("\nBotの正体：");
  seatOrder.forEach((k, i) => {
    if (k !== "you") console.log(`  ${P(i)}：${BOT_LABELS[k]}`);
  });
}
rl.close();
