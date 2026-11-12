/**
 * 設定値（開発仕様 2章）。
 *
 * お金の単位：
 * - ゲーム内のお金は「万円」単位の整数で扱う（1万円未満は切り捨て）。
 * - 端数の積立・利息の端数・ボーナス総額だけは「円」単位の整数で持つ（小数の誤差を避けるため）。
 * - 倍率・金利は「bp（1万分の1）」の整数で持つ。例：0.05 → 500、10% → 1000。
 *
 * 金額や倍率をコードに直書きせず、必ずこの設定から読む
 * （テストプレイ後の調整や、将来のランクマッチで元手を変えるため）。
 */
export type RulesConfig = {
  /** 1試合のゲーム数 */
  gamesPerMatch: number;
  /** 試合内の初期資金（参加費の元手部分）。万円 */
  stake: number;
  /** 通常ボーナス倍率 α（bp） */
  alphaBp: number;
  /** 協力ボーナスの上乗せ倍率 γ（bp） */
  gammaBp: number;
  /** 単独出資ボーナス倍率 β（bp） */
  betaBp: number;
  /** Drawに必要な連続回数 */
  drawStreak: number;
  /** 棄権になる連続不在ゲーム数 */
  absentForfeitGames: number;
  /** 金利（1試合ごと、bp） */
  interestBp: number;
  /** 担保内金利（bp） */
  securedInterestBp: number;
  /** 基本の借入限度額。万円 */
  baseLimit: number;
  /** 人生の初期資金。万円 */
  lifeInitialCash: number;
};

export const DEFAULT_CONFIG: RulesConfig = {
  gamesPerMatch: 10,
  stake: 100,
  alphaBp: 500,
  gammaBp: 1500,
  betaBp: 10000,
  drawStreak: 5,
  absentForfeitGames: 3,
  interestBp: 1000,
  securedInterestBp: 200,
  baseLimit: 300,
  lifeInitialCash: 100,
};

/** 1万円 = 10,000円 */
export const YEN_PER_MAN = 10000;
/** bpの分母 */
export const BP = 10000;
