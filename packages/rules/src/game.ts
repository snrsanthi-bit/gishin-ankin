/**
 * 1ゲームの計算と、1試合の進行（開発仕様 4章・6-3）。
 * 画面やサーバーに依存しない純粋な関数だけを置く。
 */
import { type RulesConfig, YEN_PER_MAN, BP } from "./config.ts";

export type Seat = {
  /** 試合内所持金（万円） */
  money: number;
  /** 連続で不在だったゲーム数 */
  absentStreak: number;
  /** 棄権済みか（以降の分配・Draw判定から外れる） */
  forfeited: boolean;
};

export type MatchState = {
  seats: Seat[];
  /** 何ゲーム目まで終わったか */
  gamesPlayed: number;
  /** 全員が全額出資した連続回数 */
  streak: number;
  /** ボーナス原資の合計（円）。次回参加費の上乗せ分に使う */
  bonusTotalYen: number;
  /** 切り捨てた端数の積立（円）。次回参加費の割引に使う */
  remainderYen: number;
  draw: boolean;
  finished: boolean;
};

/**
 * 1席分の入力。
 * - number：出資額（万円）。所持金を超える分・負の値は丸める
 * - null：締め切りまでに入力がなかった（不在を含む）→ 0円出資として扱う
 */
export type Contribution = number | null;

export type GameKind = "none" | "solo" | "allIn" | "normal";

export type SeatResult = {
  contribution: number;
  /** 受け取った分配（円。表示用） */
  distributionYen: number;
  /** 受け取ったボーナス（円。表示用） */
  bonusYen: number;
  moneyBefore: number;
  moneyAfter: number;
};

export type GameResult = {
  kind: GameKind;
  totalContribution: number;
  seats: (SeatResult | null)[];
  streakAfter: number;
  draw: boolean;
};

export function newMatch(config: RulesConfig, players = 4): MatchState {
  return {
    seats: Array.from({ length: players }, () => ({ money: config.stake, absentStreak: 0, forfeited: false })),
    gamesPlayed: 0,
    streak: 0,
    bonusTotalYen: 0,
    remainderYen: 0,
    draw: false,
    finished: false,
  };
}

/** 円 → 万円（切り捨て）と、切り捨てた端数（円） */
function splitYen(yen: number): [man: number, remainderYen: number] {
  const man = Math.floor(yen / YEN_PER_MAN);
  return [man, yen - man * YEN_PER_MAN];
}

/**
 * 1ゲームを解決する。state は変更せず、新しい state と結果を返す。
 *
 * 各席の新しい所持金 = ⌊ m − c ＋ S ÷ n ＋ 倍率 × c ⌋
 * （ボーナス原資 = 倍率 × S を出資比率 c/S で配るので、受け取るボーナスは 倍率 × c になる）
 * n は参加中（棄権していない）の人数。S ÷ n の1円未満は切り捨てる。
 */
export function resolveGame(
  config: RulesConfig,
  state: MatchState,
  inputs: Contribution[],
): { state: MatchState; result: GameResult } {
  if (state.finished) throw new Error("試合はすでに終了しています");
  if (inputs.length !== state.seats.length) throw new Error("入力の数が席の数と一致しません");

  const active = state.seats.map((s) => !s.forfeited);
  const n = active.filter(Boolean).length;
  if (n === 0) throw new Error("参加中の席がありません");

  const contributions = state.seats.map((s, i) => {
    if (!active[i]) return 0;
    const raw = inputs[i];
    if (raw === null || raw === undefined) return 0;
    return Math.max(0, Math.min(s.money, Math.floor(raw)));
  });

  const total = contributions.reduce((a, b) => a + b, 0);
  const contributors = contributions.filter((c) => c > 0).length;
  const allIn = state.seats.every((s, i) => !active[i] || (s.money >= 1 && contributions[i] === s.money));

  let kind: GameKind;
  let rateBp: number;
  if (contributors === 0) {
    kind = "none";
    rateBp = 0;
  } else if (contributors === 1) {
    kind = "solo";
    rateBp = config.betaBp;
  } else if (allIn) {
    kind = "allIn";
    rateBp = config.alphaBp + config.gammaBp;
  } else {
    kind = "normal";
    rateBp = config.alphaBp;
  }

  const distributionYen = Math.floor((total * YEN_PER_MAN) / n);
  let remainderYen = state.remainderYen;
  const seatResults: (SeatResult | null)[] = [];
  const seats: Seat[] = state.seats.map((s, i) => {
    if (!active[i]) {
      seatResults.push(null);
      return { ...s };
    }
    const c = contributions[i] ?? 0;
    const bonusYen = (c * rateBp * YEN_PER_MAN) / BP; // c は万円、rateBp/BP を掛けて円に
    const yen = (s.money - c) * YEN_PER_MAN + distributionYen + bonusYen;
    const [money, rem] = splitYen(yen);
    remainderYen += rem;
    const absent = inputs[i] === null || inputs[i] === undefined;
    const absentStreak = absent ? s.absentStreak + 1 : 0;
    seatResults.push({ contribution: c, distributionYen, bonusYen, moneyBefore: s.money, moneyAfter: money });
    return { money, absentStreak, forfeited: absentStreak >= config.absentForfeitGames };
  });

  const bonusTotalYen = state.bonusTotalYen + (total * rateBp * YEN_PER_MAN) / BP;
  const streak = kind === "allIn" ? state.streak + 1 : 0;
  const gamesPlayed = state.gamesPlayed + 1;

  let draw = false;
  if (streak >= config.drawStreak) {
    draw = true;
    const idx = seats.map((s, i) => (s.forfeited ? -1 : i)).filter((i) => i >= 0);
    const sumYen = idx.reduce((a, i) => a + (seats[i]?.money ?? 0), 0) * YEN_PER_MAN;
    const avg = Math.floor(sumYen / idx.length / YEN_PER_MAN);
    // 平均化で切り捨てた分（全員分の合計）を積立へ
    remainderYen += sumYen - avg * YEN_PER_MAN * idx.length;
    for (const i of idx) {
      const seat = seats[i];
      if (seat) seat.money = avg;
    }
  }

  const finished = draw || gamesPlayed >= config.gamesPerMatch || seats.every((s) => s.forfeited);

  return {
    state: { seats, gamesPlayed, streak, bonusTotalYen, remainderYen, draw, finished },
    result: { kind, totalContribution: total, seats: seatResults, streakAfter: streak, draw },
  };
}
