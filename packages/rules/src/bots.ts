/**
 * Bot（練習試合・チュートリアル・試算用）。
 *
 * 公平のため、Bot は人間の画面に出る情報だけを見て決める（将来構想「Bot住人」の方針）：
 * 自分の所持金、連続回数、何ゲーム目か、自分が1位か、直前のゲームで自分が受け取った分配とボーナス。
 * 他人の所持金や出資額は見ない。
 */
import type { RulesConfig } from "./config.ts";
import type { Contribution, GameResult, MatchState } from "./game.ts";
import type { Rng } from "./random.ts";

export type BotView = {
  /** 何ゲーム目か（0から） */
  game: number;
  gamesPerMatch: number;
  drawStreak: number;
  /** 自分の試合内所持金（万円） */
  money: number;
  /** 全員が全額出資した連続回数 */
  streak: number;
  /** 自分が1位か（同率を含む）。人間には「あなたが1位です」の通知で見える */
  isTop: boolean;
  /** 直前のゲームで連続が途切れたか（誰かが全額出資しなかった） */
  streakBroken: boolean;
  /** 直前のゲームで自分が全額出資したか。自分は出したのに途切れた＝誰かに裏切られた */
  myLastAllIn: boolean;
};

export type Bot = {
  /** 表示用の名前（試合後に明かす） */
  readonly label: string;
  decide(view: BotView): Contribution;
};

export type BotKind = "allIn" | "freeRider" | "random" | "grudger" | "smart";

export const BOT_LABELS: Record<BotKind, string> = {
  allIn: "お人好し（毎回全額）",
  freeRider: "ただ乗り（毎回0円）",
  random: "気まぐれ（毎回ばらばら）",
  grudger: "仕返し（裏切られたら1回だけ出さない）",
  smart: "策士（協力しつつ、Draw直前に裏切ることがある）",
};

export function createBot(kind: BotKind, rng: Rng): Bot {
  const label = BOT_LABELS[kind];
  switch (kind) {
    case "allIn":
      return { label, decide: (v) => v.money };
    case "freeRider":
      return { label, decide: () => 0 };
    case "random":
      return { label, decide: (v) => Math.floor(v.money * rng()) };
    case "grudger": {
      return { label, decide: (v) => (v.streakBroken && v.myLastAllIn ? 0 : v.money) };
    }
    case "smart": {
      // 裏切られたら2ゲームは様子を見る。Draw直前（あと1回）は 35% で裏切る。1位なら少し裏切りやすい
      let grudge = 0;
      return {
        label,
        decide: (v) => {
          if (v.streakBroken && v.myLastAllIn) grudge = 2;
          if (grudge > 0) {
            grudge--;
            return 0;
          }
          const lastStep = v.streak === v.drawStreak - 1;
          const greed = lastStep ? (v.isTop ? 0.5 : 0.35) : v.isTop ? 0.1 : 0.03;
          return rng() < greed ? 0 : v.money;
        },
      };
    }
  }
}

export const BOT_KINDS: readonly BotKind[] = ["allIn", "freeRider", "random", "grudger", "smart"];

/** 試合の状態から、その席のBotに見せる情報を作る */
export function botViewOf(config: RulesConfig, state: MatchState, seat: number, last: GameResult | null): BotView {
  const money = state.seats[seat]?.money ?? 0;
  const active = state.seats.filter((s) => !s.forfeited).map((s) => s.money);
  return {
    game: state.gamesPlayed,
    gamesPerMatch: config.gamesPerMatch,
    drawStreak: config.drawStreak,
    money,
    streak: state.streak,
    isTop: money >= Math.max(...active),
    streakBroken: last !== null && last.streakAfter === 0,
    myLastAllIn: (() => {
      const me = last?.seats[seat];
      return !!me && me.moneyBefore >= 1 && me.contribution === me.moneyBefore;
    })(),
  };
}
