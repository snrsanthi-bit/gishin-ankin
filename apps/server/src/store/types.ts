/**
 * ストア：データをどう保存し、どう読むか（設計：claude/設計_epic-life.md 3・4章）
 *
 * - お金の計算はしない（Rules の仕事）。いつ・どの順番で処理するかも決めない（LifeService の仕事）
 * - 読み書きはすべてトランザクション（tx）の中で行う。tx の関数が例外を投げたら、何も書かれない
 * - メモリ版（テスト用）と PostgreSQL 版がある。同じ契約テスト（contract.ts）を通す
 */
import type { GameResult, LifeMoney } from "@gishin-ankin/rules";

export type Account = {
  id: string;
  discordId: string;
  displayName: string;
  createdAt: Date;
};

export type Session = {
  tokenHash: string;
  accountId: string;
  createdAt: Date;
  expiresAt: Date;
};

export type LifeStatus = "alive" | "ended";

export type Life = LifeMoney & {
  id: string;
  accountId: string;
  status: LifeStatus;
  /** 入っている試合。入場で埋め、試合後の処理（または無効）で空にする */
  currentMatchId: string | null;
  matchesPlayed: number;
  startedAt: Date;
  endedAt: Date | null;
};

export type MatchKind = "real" | "practice" | "tutorial";
export type MatchStatus = "in_progress" | "finished" | "void";

/** 牌譜。形を変えるときは v を上げ、古い版も読めるようにする */
export type MatchRecord = { v: 1; games: GameResult[] };

export type Match = {
  id: string;
  kind: MatchKind;
  status: MatchStatus;
  startedAt: Date;
  endedAt: Date | null;
  draw: boolean;
  bonusTotalYen: number;
  remainderYen: number;
  record: MatchRecord;
};

/** 試合の終わり方（終了・無効）に合わせて書く項目 */
export type MatchClose = {
  endedAt: Date;
  draw: boolean;
  bonusTotalYen: number;
  remainderYen: number;
  record: MatchRecord;
};

/** 入場前の人生の状態と、入場で払った・借りた額 */
export type SeatEntry = {
  cashBefore: number;
  debtBefore: number;
  interestAccYenBefore: number;
  fee: number;
  borrowed: number;
};

/** 試合後の処理の結果 */
export type SeatSettlement = {
  moneyOut: number;
  bonusReceivedYen: number;
  interestAdded: number;
  repaid: number;
  nextFee: number;
  lifeEnded: boolean;
  cashAfter: number;
  debtAfter: number;
  interestAccYenAfter: number;
};

export type MatchSeat = {
  matchId: string;
  seat: number;
  /** Botの席は null */
  accountId: string | null;
  /** 人生のお金が動かない席（練習試合・Bot）は null */
  lifeId: string | null;
  /** lifeId があるときは必ず入る */
  entry: SeatEntry | null;
  /** 試合後の処理が終わるまでは null */
  settlement: SeatSettlement | null;
};

export type ChatRecord = {
  id: number;
  matchId: string;
  seat: number;
  accountId: string | null;
  /** 伏せ字の後（表示用） */
  text: string;
  /** 伏せ字の前（運営用）。伏せ字がなかったときは null */
  original: string | null;
  createdAt: Date;
};

export type ChatHold = {
  matchId: string;
  reason: string;
  /** null なら期限なし */
  holdUntil: Date | null;
  createdAt: Date;
};

/** 一意の制約・CHECK制約に引っかかったとき */
export class StoreConflictError extends Error {
  readonly constraint: string;
  constructor(constraint: string, message?: string) {
    super(message ?? `制約に違反しました: ${constraint}`);
    this.name = "StoreConflictError";
    this.constraint = constraint;
  }
}

export interface Tx {
  // アカウント
  createAccount(account: Account): Promise<void>;
  getAccount(id: string): Promise<Account | null>;
  findAccountByDiscordId(discordId: string): Promise<Account | null>;
  updateAccountName(id: string, displayName: string): Promise<void>;

  // ログイン状態
  createSession(session: Session): Promise<void>;
  /** 期限内のセッションだけを返す */
  findSession(tokenHash: string, now: Date): Promise<Session | null>;
  deleteSession(tokenHash: string): Promise<void>;
  deleteExpiredSessions(now: Date): Promise<number>;

  // 人生
  createLife(life: Life): Promise<void>;
  getLife(id: string): Promise<Life | null>;
  findAliveLife(accountId: string): Promise<Life | null>;
  /**
   * 人生を固定して読む（同じ人生を読もうとする別のトランザクションは、このトランザクションが終わるまで待つ）。
   * 見つからない id は結果に含めない。順番は id の順
   */
  lockLives(ids: readonly string[]): Promise<Life[]>;
  updateLife(life: Life): Promise<void>;

  // 試合
  /** 同じ id がすでにあれば StoreConflictError */
  createMatch(match: Match): Promise<void>;
  getMatch(id: string): Promise<Match | null>;
  /**
   * 状態が from のときだけ to に変え、終わり方の項目を書く。変えたら true。
   * 試合の終了・無効を二重に処理しないために使う（設計 4-2）
   */
  closeMatch(id: string, from: MatchStatus, to: MatchStatus, close: MatchClose): Promise<boolean>;
  listMatchIds(status: MatchStatus, kinds: readonly MatchKind[]): Promise<string[]>;

  // 試合の席
  /** 同じ (試合, 席) か (試合, 人生) がすでにあれば StoreConflictError */
  createSeats(seats: readonly MatchSeat[]): Promise<void>;
  getSeats(matchId: string): Promise<MatchSeat[]>;
  setSeatSettlement(matchId: string, seat: number, settlement: SeatSettlement): Promise<void>;

  // チャット
  addChatMessage(message: Omit<ChatRecord, "id">): Promise<ChatRecord>;
  listChatMessages(matchId: string): Promise<ChatRecord[]>;
  addChatHold(hold: ChatHold): Promise<void>;
  /** before より前のチャットを消す。期限内（now より後、または期限なし）の印がある試合の分は残す */
  deleteExpiredChat(before: Date, now: Date): Promise<number>;
}

export interface Store {
  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
