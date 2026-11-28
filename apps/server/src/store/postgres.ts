/**
 * PostgreSQL 版のストア。表は migrations/*.sql（pnpm db:migrate で作る）
 */
import pg from "pg";
import type { ClientBase, Pool, QueryResult, QueryResultRow } from "pg";
import {
  StoreConflictError,
  type Account,
  type ChatHold,
  type ChatRecord,
  type Life,
  type Match,
  type MatchClose,
  type MatchKind,
  type MatchRecord,
  type MatchSeat,
  type MatchStatus,
  type SeatSettlement,
  type Session,
  type Store,
  type Tx,
} from "./types.ts";

export const DEFAULT_DATABASE_URL = "postgres://gishin_ankin:gishin_ankin@localhost:5432/gishin_ankin";

// bigint（int8）を number で受け取る。お金は Number.MAX_SAFE_INTEGER に届かない前提で、届いたら止める
pg.types.setTypeParser(20, (value: string) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`bigint が大きすぎます: ${value}`);
  return n;
});

type Queryable = ClientBase;

/** 制約違反の SQLSTATE：一意 23505、外部キー 23503、CHECK 23514、NOT NULL 23502 */
const CONFLICT_CODES = new Set(["23505", "23503", "23514", "23502"]);

function toStoreError(error: unknown): unknown {
  if (typeof error === "object" && error !== null && "code" in error && CONFLICT_CODES.has(String(error.code))) {
    const constraint = "constraint" in error && typeof error.constraint === "string" ? error.constraint : "unknown";
    const message = error instanceof Error ? error.message : undefined;
    return new StoreConflictError(constraint, message);
  }
  return error;
}

export class PostgresStore implements Store {
  private readonly pool: Pool;

  constructor(connectionString: string = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL) {
    this.pool = new pg.Pool({ connectionString });
  }

  async tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(new PostgresTx(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** テスト用：表を空にする */
  async truncateAll(): Promise<void> {
    await this.pool.query(
      "TRUNCATE chat_holds, chat_messages, match_seats, lives, matches, sessions, accounts RESTART IDENTITY CASCADE",
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

// 行 → 値

type AccountRow = { id: string; discord_id: string; display_name: string; created_at: Date };
const toAccount = (r: AccountRow): Account => ({
  id: r.id,
  discordId: r.discord_id,
  displayName: r.display_name,
  createdAt: r.created_at,
});

type SessionRow = { token_hash: string; account_id: string; created_at: Date; expires_at: Date };
const toSession = (r: SessionRow): Session => ({
  tokenHash: r.token_hash,
  accountId: r.account_id,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
});

type LifeRow = {
  id: string;
  account_id: string;
  status: Life["status"];
  cash: number;
  debt: number;
  interest_acc_yen: number;
  next_fee: number;
  current_match_id: string | null;
  matches_played: number;
  started_at: Date;
  ended_at: Date | null;
};
const toLife = (r: LifeRow): Life => ({
  id: r.id,
  accountId: r.account_id,
  status: r.status,
  cash: r.cash,
  debt: r.debt,
  interestAccYen: r.interest_acc_yen,
  nextFee: r.next_fee,
  currentMatchId: r.current_match_id,
  matchesPlayed: r.matches_played,
  startedAt: r.started_at,
  endedAt: r.ended_at,
});

type MatchRow = {
  id: string;
  kind: MatchKind;
  status: MatchStatus;
  started_at: Date;
  ended_at: Date | null;
  draw: boolean;
  bonus_total_yen: number;
  remainder_yen: number;
  record: MatchRecord;
};
const toMatch = (r: MatchRow): Match => ({
  id: r.id,
  kind: r.kind,
  status: r.status,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  draw: r.draw,
  bonusTotalYen: r.bonus_total_yen,
  remainderYen: r.remainder_yen,
  record: r.record,
});

type SeatRow = {
  match_id: string;
  seat: number;
  account_id: string | null;
  life_id: string | null;
  cash_before: number | null;
  debt_before: number | null;
  interest_acc_yen_before: number | null;
  fee: number | null;
  borrowed: number | null;
  money_out: number | null;
  bonus_received_yen: number | null;
  interest_added: number | null;
  repaid: number | null;
  next_fee: number | null;
  life_ended: boolean | null;
  cash_after: number | null;
  debt_after: number | null;
  interest_acc_yen_after: number | null;
};
function toSeat(r: SeatRow): MatchSeat {
  const entry =
    r.cash_before === null ||
    r.debt_before === null ||
    r.interest_acc_yen_before === null ||
    r.fee === null ||
    r.borrowed === null
      ? null
      : {
          cashBefore: r.cash_before,
          debtBefore: r.debt_before,
          interestAccYenBefore: r.interest_acc_yen_before,
          fee: r.fee,
          borrowed: r.borrowed,
        };
  const settlement =
    r.money_out === null ||
    r.bonus_received_yen === null ||
    r.interest_added === null ||
    r.repaid === null ||
    r.next_fee === null ||
    r.life_ended === null ||
    r.cash_after === null ||
    r.debt_after === null ||
    r.interest_acc_yen_after === null
      ? null
      : {
          moneyOut: r.money_out,
          bonusReceivedYen: r.bonus_received_yen,
          interestAdded: r.interest_added,
          repaid: r.repaid,
          nextFee: r.next_fee,
          lifeEnded: r.life_ended,
          cashAfter: r.cash_after,
          debtAfter: r.debt_after,
          interestAccYenAfter: r.interest_acc_yen_after,
        };
  return { matchId: r.match_id, seat: r.seat, accountId: r.account_id, lifeId: r.life_id, entry, settlement };
}

type ChatRow = {
  id: number;
  match_id: string;
  seat: number;
  account_id: string | null;
  text: string;
  original: string | null;
  created_at: Date;
};
const toChat = (r: ChatRow): ChatRecord => ({
  id: r.id,
  matchId: r.match_id,
  seat: r.seat,
  accountId: r.account_id,
  text: r.text,
  original: r.original,
  createdAt: r.created_at,
});

class PostgresTx implements Tx {
  private readonly db: Queryable;
  constructor(db: Queryable) {
    this.db = db;
  }

  private async query<R extends QueryResultRow>(text: string, values: unknown[] = []): Promise<QueryResult<R>> {
    try {
      return await this.db.query<R>(text, values);
    } catch (error) {
      throw toStoreError(error);
    }
  }

  private async one<R extends QueryResultRow>(text: string, values: unknown[]): Promise<R | null> {
    return (await this.query<R>(text, values)).rows[0] ?? null;
  }

  private async mustUpdate(what: string, text: string, values: unknown[]): Promise<void> {
    const r = await this.query(text, values);
    if (r.rowCount !== 1) throw new Error(`${what}がありません`);
  }

  // アカウント

  async createAccount(a: Account): Promise<void> {
    await this.query("INSERT INTO accounts (id, discord_id, display_name, created_at) VALUES ($1, $2, $3, $4)", [
      a.id,
      a.discordId,
      a.displayName,
      a.createdAt,
    ]);
  }

  async getAccount(id: string): Promise<Account | null> {
    const r = await this.one<AccountRow>("SELECT * FROM accounts WHERE id = $1", [id]);
    return r && toAccount(r);
  }

  async findAccountByDiscordId(discordId: string): Promise<Account | null> {
    const r = await this.one<AccountRow>("SELECT * FROM accounts WHERE discord_id = $1", [discordId]);
    return r && toAccount(r);
  }

  async updateAccountName(id: string, displayName: string): Promise<void> {
    await this.mustUpdate("アカウント", "UPDATE accounts SET display_name = $2 WHERE id = $1", [id, displayName]);
  }

  // ログイン状態

  async createSession(s: Session): Promise<void> {
    await this.query("INSERT INTO sessions (token_hash, account_id, created_at, expires_at) VALUES ($1, $2, $3, $4)", [
      s.tokenHash,
      s.accountId,
      s.createdAt,
      s.expiresAt,
    ]);
  }

  async findSession(tokenHash: string, now: Date): Promise<Session | null> {
    const r = await this.one<SessionRow>("SELECT * FROM sessions WHERE token_hash = $1 AND expires_at > $2", [
      tokenHash,
      now,
    ]);
    return r && toSession(r);
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash]);
  }

  async deleteExpiredSessions(now: Date): Promise<number> {
    return (await this.query("DELETE FROM sessions WHERE expires_at <= $1", [now])).rowCount ?? 0;
  }

  // 人生

  async createLife(l: Life): Promise<void> {
    await this.query(
      `INSERT INTO lives (id, account_id, status, cash, debt, interest_acc_yen, next_fee,
                          current_match_id, matches_played, started_at, ended_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        l.id,
        l.accountId,
        l.status,
        l.cash,
        l.debt,
        l.interestAccYen,
        l.nextFee,
        l.currentMatchId,
        l.matchesPlayed,
        l.startedAt,
        l.endedAt,
      ],
    );
  }

  async getLife(id: string): Promise<Life | null> {
    const r = await this.one<LifeRow>("SELECT * FROM lives WHERE id = $1", [id]);
    return r && toLife(r);
  }

  async findAliveLife(accountId: string): Promise<Life | null> {
    const r = await this.one<LifeRow>("SELECT * FROM lives WHERE account_id = $1 AND status = 'alive'", [accountId]);
    return r && toLife(r);
  }

  async lockLives(ids: readonly string[]): Promise<Life[]> {
    if (ids.length === 0) return [];
    // いつも id の順に固定する（行の取り合いで止まり合わないように）
    const r = await this.query<LifeRow>("SELECT * FROM lives WHERE id = ANY($1) ORDER BY id FOR UPDATE", [[...ids]]);
    return r.rows.map(toLife);
  }

  async updateLife(l: Life): Promise<void> {
    await this.mustUpdate(
      "人生",
      `UPDATE lives SET status = $3, cash = $4, debt = $5, interest_acc_yen = $6, next_fee = $7,
                        current_match_id = $8, matches_played = $9, started_at = $10, ended_at = $11
       WHERE id = $1 AND account_id = $2`,
      [
        l.id,
        l.accountId,
        l.status,
        l.cash,
        l.debt,
        l.interestAccYen,
        l.nextFee,
        l.currentMatchId,
        l.matchesPlayed,
        l.startedAt,
        l.endedAt,
      ],
    );
  }

  // 試合

  async createMatch(m: Match): Promise<void> {
    await this.query(
      `INSERT INTO matches (id, kind, status, started_at, ended_at, draw, bonus_total_yen, remainder_yen, record)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [m.id, m.kind, m.status, m.startedAt, m.endedAt, m.draw, m.bonusTotalYen, m.remainderYen, JSON.stringify(m.record)],
    );
  }

  async getMatch(id: string): Promise<Match | null> {
    const r = await this.one<MatchRow>("SELECT * FROM matches WHERE id = $1", [id]);
    return r && toMatch(r);
  }

  async closeMatch(id: string, from: MatchStatus, to: MatchStatus, c: MatchClose): Promise<boolean> {
    const r = await this.query(
      `UPDATE matches SET status = $3, ended_at = $4, draw = $5, bonus_total_yen = $6, remainder_yen = $7, record = $8
       WHERE id = $1 AND status = $2`,
      [id, from, to, c.endedAt, c.draw, c.bonusTotalYen, c.remainderYen, JSON.stringify(c.record)],
    );
    return r.rowCount === 1;
  }

  async listMatchIds(status: MatchStatus, kinds: readonly MatchKind[]): Promise<string[]> {
    const r = await this.query<{ id: string }>(
      "SELECT id FROM matches WHERE status = $1 AND kind = ANY($2) ORDER BY id",
      [status, [...kinds]],
    );
    return r.rows.map((row) => row.id);
  }

  // 試合の席

  async createSeats(seats: readonly MatchSeat[]): Promise<void> {
    for (const s of seats) {
      await this.query(
        `INSERT INTO match_seats (match_id, seat, account_id, life_id,
                                  cash_before, debt_before, interest_acc_yen_before, fee, borrowed)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          s.matchId,
          s.seat,
          s.accountId,
          s.lifeId,
          s.entry?.cashBefore ?? null,
          s.entry?.debtBefore ?? null,
          s.entry?.interestAccYenBefore ?? null,
          s.entry?.fee ?? null,
          s.entry?.borrowed ?? null,
        ],
      );
      if (s.settlement) await this.setSeatSettlement(s.matchId, s.seat, s.settlement);
    }
  }

  async getSeats(matchId: string): Promise<MatchSeat[]> {
    const r = await this.query<SeatRow>("SELECT * FROM match_seats WHERE match_id = $1 ORDER BY seat", [matchId]);
    return r.rows.map(toSeat);
  }

  async setSeatSettlement(matchId: string, seat: number, s: SeatSettlement): Promise<void> {
    await this.mustUpdate(
      "席",
      `UPDATE match_seats SET money_out = $3, bonus_received_yen = $4, interest_added = $5, repaid = $6,
                              next_fee = $7, life_ended = $8, cash_after = $9, debt_after = $10,
                              interest_acc_yen_after = $11
       WHERE match_id = $1 AND seat = $2`,
      [
        matchId,
        seat,
        s.moneyOut,
        s.bonusReceivedYen,
        s.interestAdded,
        s.repaid,
        s.nextFee,
        s.lifeEnded,
        s.cashAfter,
        s.debtAfter,
        s.interestAccYenAfter,
      ],
    );
  }

  // チャット

  async addChatMessage(m: Omit<ChatRecord, "id">): Promise<ChatRecord> {
    const r = await this.one<ChatRow>(
      `INSERT INTO chat_messages (match_id, seat, account_id, text, original, created_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [m.matchId, m.seat, m.accountId, m.text, m.original, m.createdAt],
    );
    if (!r) throw new Error("チャットを保存できませんでした");
    return toChat(r);
  }

  async listChatMessages(matchId: string): Promise<ChatRecord[]> {
    const r = await this.query<ChatRow>("SELECT * FROM chat_messages WHERE match_id = $1 ORDER BY id", [matchId]);
    return r.rows.map(toChat);
  }

  async addChatHold(h: ChatHold): Promise<void> {
    await this.query("INSERT INTO chat_holds (match_id, reason, hold_until, created_at) VALUES ($1, $2, $3, $4)", [
      h.matchId,
      h.reason,
      h.holdUntil,
      h.createdAt,
    ]);
  }

  async deleteExpiredChat(before: Date, now: Date): Promise<number> {
    const r = await this.query(
      `DELETE FROM chat_messages m
       WHERE m.created_at < $1
         AND NOT EXISTS (
           SELECT 1 FROM chat_holds h
           WHERE h.match_id = m.match_id AND (h.hold_until IS NULL OR h.hold_until > $2)
         )`,
      [before, now],
    );
    return r.rowCount ?? 0;
  }
}
