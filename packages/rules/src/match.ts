/**
 * 1試合を最後まで進める。席ごとに「出資額の決め方」を渡す。
 * 人間の入力（画面やターミナル）を待てるように、決め方は非同期でもよい。
 */
import type { RulesConfig } from "./config.ts";
import { newMatch, resolveGame, type Contribution, type GameResult, type MatchState } from "./game.ts";
import { nextFeeOf } from "./life.ts";

export type Decider = (state: MatchState, seat: number, last: GameResult | null) => Contribution | Promise<Contribution>;

export type MatchRecord = {
  final: MatchState;
  /** 牌譜：各ゲームの結果 */
  games: GameResult[];
  /** 次の参加費（万円）。全員共通 */
  nextFee: number;
};

export async function playMatch(
  config: RulesConfig,
  deciders: Decider[],
  onGame?: (result: GameResult, state: MatchState) => void | Promise<void>,
): Promise<MatchRecord> {
  let state = newMatch(config, deciders.length);
  let last: GameResult | null = null;
  const games: GameResult[] = [];
  while (!state.finished) {
    const inputs: Contribution[] = [];
    for (let i = 0; i < deciders.length; i++) {
      const d = deciders[i];
      inputs.push(state.seats[i]?.forfeited || !d ? 0 : await d(state, i, last));
    }
    const r = resolveGame(config, state, inputs);
    state = r.state;
    last = r.result;
    games.push(r.result);
    if (onGame) await onGame(r.result, state);
  }
  const { fee } = nextFeeOf(config, {
    money: 0,
    draw: state.draw,
    bonusTotalYen: state.bonusTotalYen,
    remainderYen: state.remainderYen,
  });
  return { final: state, games, nextFee: fee };
}
