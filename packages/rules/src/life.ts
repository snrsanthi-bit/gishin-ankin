/**
 * 試合終了から次の試合への入場まで（開発仕様 5章、決定事項 5-3）。
 * 手順 1〜5 を settleMatch、手順 7 を enterMatch で行う（手順 6 のロビーは市場側）。
 */
import { type RulesConfig, YEN_PER_MAN } from "./config.ts";

export type LifeMoney = {
  /** 人生所持金（万円） */
  cash: number;
  /** 借金（万円） */
  debt: number;
  /** 利息の端数（円）。1万円未満をためておく。完済しても持ち越す */
  interestAccYen: number;
  /** 次の参加費（万円） */
  nextFee: number;
};

export type MatchOutcome = {
  /** この人が持ち帰る試合内所持金（万円） */
  money: number;
  draw: boolean;
  /** 部屋のボーナス原資の合計（円） */
  bonusTotalYen: number;
  /** 部屋の端数の積立（円） */
  remainderYen: number;
};

export type SettleResult = {
  life: LifeMoney;
  /** 手順2で借金に加えた利息（万円） */
  interestAdded: number;
  /** 手順3で返済した額（万円） */
  repaid: number;
  /** 上乗せ分（万円。Drawなら0） */
  surcharge: number;
  /** 端数の割引（万円。Drawなら0） */
  discount: number;
  /** 手順5の判定：次の参加費を払えない → 人生終了 */
  lifeEnded: boolean;
};

export function newLife(config: RulesConfig): LifeMoney {
  return { cash: config.lifeInitialCash, debt: 0, interestAccYen: 0, nextFee: config.stake };
}

/** 借入の上限（基本の限度額＋担保評価の合計） */
export function borrowingCap(config: RulesConfig, collateral: number): number {
  return config.baseLimit + collateral;
}

/** 次の参加費を、現金と残りの借入枠で払えるか */
export function canPayNextFee(config: RulesConfig, life: LifeMoney, collateral: number): boolean {
  return life.debt + Math.max(0, life.nextFee - life.cash) <= borrowingCap(config, collateral);
}

/** 安全／危険：借金が基本の限度額を超えていたら、担保分で耐えている「危険」 */
export function isInDanger(config: RulesConfig, life: LifeMoney): boolean {
  return life.debt > config.baseLimit;
}

/** 次の参加費（手順4）。上乗せ分 − 端数の割引（0未満にしない）。Drawなら元手ちょうど */
export function nextFeeOf(config: RulesConfig, outcome: MatchOutcome) {
  if (outcome.draw) return { fee: config.stake, surcharge: 0, discount: 0 };
  const surcharge = Math.floor(outcome.bonusTotalYen / 4 / YEN_PER_MAN);
  const discount = Math.floor(outcome.remainderYen / 4 / YEN_PER_MAN);
  return { fee: config.stake + Math.max(0, surcharge - discount), surcharge, discount };
}

/**
 * 手順1〜5。
 * collateral は保有鉱石の担保評価額の合計（万円）。ロビーでの売買の前の値を渡す。
 */
export function settleMatch(
  config: RulesConfig,
  before: LifeMoney,
  outcome: MatchOutcome,
  collateral: number,
): SettleResult {
  // 1. 試合内所持金を人生所持金に戻す
  let cash = before.cash + outcome.money;
  let debt = before.debt;
  let acc = before.interestAccYen;

  // 2. 利息（担保の範囲内は担保内金利、超えた分は通常の金利）。1万円未満は端数としてためる
  let interestAdded = 0;
  if (debt > 0) {
    const secured = Math.min(debt, collateral);
    acc += secured * config.securedInterestBp + (debt - secured) * config.interestBp; // 万円×bp = 円
    interestAdded = Math.floor(acc / YEN_PER_MAN);
    debt += interestAdded;
    acc -= interestAdded * YEN_PER_MAN;
  }

  // 3. 自動返済
  const repaid = Math.min(cash, debt);
  cash -= repaid;
  debt -= repaid;

  // 4. 次の参加費
  const { fee, surcharge, discount } = nextFeeOf(config, outcome);
  const life: LifeMoney = { cash, debt, interestAccYen: acc, nextFee: fee };

  // 5. 人生終了の判定
  const lifeEnded = !canPayNextFee(config, life, collateral);

  return { life, interestAdded, repaid, surcharge, discount, lifeEnded };
}

/** 手順7：入場。参加費を払い、足りない分を借りる。払えない場合はエラー（手順5で判定済みのはず） */
export function enterMatch(config: RulesConfig, life: LifeMoney, collateral: number): { life: LifeMoney; borrowed: number } {
  if (!canPayNextFee(config, life, collateral)) throw new Error("参加費を払えません（人生終了の判定漏れ）");
  const pay = Math.min(life.cash, life.nextFee);
  const borrowed = life.nextFee - pay;
  return { life: { ...life, cash: life.cash - pay, debt: life.debt + borrowed }, borrowed };
}
