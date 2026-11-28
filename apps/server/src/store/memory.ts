/**
 * メモリ版のストア（テスト用）。
 * トランザクションは1つずつ順番に実行し、始めた時点の状態の写しの上で動かす。
 * 例外が出たら写しを捨てるので、何も書かれない。DBの制約も同じものを確かめる
 */
import {
  StoreConflictError,
  type Account,
  type ChatHold,
  type ChatRecord,
  type Life,
  type Match,
  type MatchClose,
  type MatchKind,
  type MatchSeat,
  type MatchStatus,
  type SeatSettlement,
  type Session,
  type Store,
  type Tx,
} from "./types.ts";

type State = {
  accounts: Map<string, Account>;
  sessions: Map<string, Session>;
  lives: Map<string, Life>;
  matches: Map<string, Match>;
  seats: Map<string, MatchSeat>;
  chat: ChatRecord[];
  chatSeq: number;
  holds: Map<string, ChatHold>;
};

const seatKey = (matchId: string, seat: number) => `${matchId}\u0000${seat}`;
const holdKey = (matchId: string, reason: string) => `${matchId}\u0000${reason}`;

function emptyState(): State {
  return {
    accounts: new Map(),
    sessions: new Map(),
    lives: new Map(),
    matches: new Map(),
    seats: new Map(),
    chat: [],
    chatSeq: 0,
    holds: new Map(),
  };
}

const copy = <T>(value: T): T => structuredClone(value);

export class MemoryStore implements Store {
  private state = emptyState();
  private queue: Promise<unknown> = Promise.resolve();

  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const run = async () => {
      const draft = copy(this.state);
      const result = await fn(new MemoryTx(draft));
      this.state = draft;
      return result;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async close(): Promise<void> {
    await this.queue;
  }
}

class MemoryTx implements Tx {
  private readonly s: State;
  constructor(state: State) {
    this.s = state;
  }

  // アカウント

  async createAccount(account: Account): Promise<void> {
    if (this.s.accounts.has(account.id)) throw new StoreConflictError("accounts_pkey");
    for (const a of this.s.accounts.values()) {
      if (a.discordId === account.discordId) throw new StoreConflictError("accounts_discord_id_key");
    }
    this.s.accounts.set(account.id, copy(account));
  }

  async getAccount(id: string): Promise<Account | null> {
    const a = this.s.accounts.get(id);
    return a ? copy(a) : null;
  }

  async findAccountByDiscordId(discordId: string): Promise<Account | null> {
    for (const a of this.s.accounts.values()) if (a.discordId === discordId) return copy(a);
    return null;
  }

  async updateAccountName(id: string, displayName: string): Promise<void> {
    const a = this.s.accounts.get(id);
    if (!a) throw new Error(`アカウントがありません: ${id}`);
    a.displayName = displayName;
  }

  // ログイン状態

  async createSession(session: Session): Promise<void> {
    if (this.s.sessions.has(session.tokenHash)) throw new StoreConflictError("sessions_pkey");
    this.needAccount(session.accountId);
    this.s.sessions.set(session.tokenHash, copy(session));
  }

  async findSession(tokenHash: string, now: Date): Promise<Session | null> {
    const session = this.s.sessions.get(tokenHash);
    return session && session.expiresAt > now ? copy(session) : null;
  }

  async deleteSession(tokenHash: string): Promise<void> {
    this.s.sessions.delete(tokenHash);
  }

  async deleteExpiredSessions(now: Date): Promise<number> {
    let n = 0;
    for (const [key, session] of this.s.sessions) {
      if (session.expiresAt <= now) {
        this.s.sessions.delete(key);
        n++;
      }
    }
    return n;
  }

  // 人生

  async createLife(life: Life): Promise<void> {
    if (this.s.lives.has(life.id)) throw new StoreConflictError("lives_pkey");
    this.checkLife(life);
    this.s.lives.set(life.id, copy(life));
  }

  async getLife(id: string): Promise<Life | null> {
    const life = this.s.lives.get(id);
    return life ? copy(life) : null;
  }

  async findAliveLife(accountId: string): Promise<Life | null> {
    for (const life of this.s.lives.values()) {
      if (life.accountId === accountId && life.status === "alive") return copy(life);
    }
    return null;
  }

  async lockLives(ids: readonly string[]): Promise<Life[]> {
    return [...new Set(ids)]
      .sort()
      .flatMap((id) => {
        const life = this.s.lives.get(id);
        return life ? [copy(life)] : [];
      });
  }

  async updateLife(life: Life): Promise<void> {
    const old = this.s.lives.get(life.id);
    if (!old) throw new Error(`人生がありません: ${life.id}`);
    if (old.accountId !== life.accountId) throw new Error("人生のアカウントは変えられません");
    this.checkLife(life);
    this.s.lives.set(life.id, copy(life));
  }

  private checkLife(life: Life): void {
    this.needAccount(life.accountId);
    for (const key of ["cash", "debt", "interestAccYen", "nextFee"] as const) {
      if (!Number.isInteger(life[key]) || life[key] < 0) throw new StoreConflictError(`lives_${key}_check`);
    }
    if ((life.status === "alive") !== (life.endedAt === null)) throw new StoreConflictError("lives_check");
    if (life.status !== "alive" && life.currentMatchId !== null) throw new StoreConflictError("lives_check");
    if (life.currentMatchId !== null && !this.s.matches.has(life.currentMatchId)) {
      throw new StoreConflictError("lives_current_match_id_fkey");
    }
    if (life.status === "alive") {
      for (const other of this.s.lives.values()) {
        if (other.id !== life.id && other.accountId === life.accountId && other.status === "alive") {
          throw new StoreConflictError("lives_one_alive_per_account");
        }
      }
    }
  }

  // 試合

  async createMatch(match: Match): Promise<void> {
    if (this.s.matches.has(match.id)) throw new StoreConflictError("matches_pkey");
    if ((match.status === "in_progress") !== (match.endedAt === null)) throw new StoreConflictError("matches_check");
    this.s.matches.set(match.id, copy(match));
  }

  async getMatch(id: string): Promise<Match | null> {
    const match = this.s.matches.get(id);
    return match ? copy(match) : null;
  }

  async closeMatch(id: string, from: MatchStatus, to: MatchStatus, close: MatchClose): Promise<boolean> {
    const match = this.s.matches.get(id);
    if (!match || match.status !== from) return false;
    if (to === "in_progress") throw new StoreConflictError("matches_check");
    Object.assign(match, copy(close), { status: to });
    return true;
  }

  async listMatchIds(status: MatchStatus, kinds: readonly MatchKind[]): Promise<string[]> {
    return [...this.s.matches.values()]
      .filter((m) => m.status === status && kinds.includes(m.kind))
      .map((m) => m.id)
      .sort();
  }

  // 試合の席

  async createSeats(seats: readonly MatchSeat[]): Promise<void> {
    for (const seat of seats) {
      if (!this.s.matches.has(seat.matchId)) throw new StoreConflictError("match_seats_match_id_fkey");
      if (!Number.isInteger(seat.seat) || seat.seat < 0) throw new StoreConflictError("match_seats_seat_check");
      if (this.s.seats.has(seatKey(seat.matchId, seat.seat))) throw new StoreConflictError("match_seats_pkey");
      if (seat.accountId !== null) this.needAccount(seat.accountId);
      if (seat.accountId === null && seat.lifeId !== null) throw new StoreConflictError("match_seats_check");
      if (seat.lifeId !== null) {
        if (!this.s.lives.has(seat.lifeId)) throw new StoreConflictError("match_seats_life_id_fkey");
        for (const other of this.s.seats.values()) {
          if (other.matchId === seat.matchId && other.lifeId === seat.lifeId) {
            throw new StoreConflictError("match_seats_match_id_life_id_key");
          }
        }
      }
      if ((seat.lifeId === null) !== (seat.entry === null)) throw new StoreConflictError("match_seats_check1");
      if (seat.settlement !== null && seat.lifeId === null) throw new StoreConflictError("match_seats_check2");
      this.s.seats.set(seatKey(seat.matchId, seat.seat), copy(seat));
    }
  }

  async getSeats(matchId: string): Promise<MatchSeat[]> {
    return [...this.s.seats.values()]
      .filter((s) => s.matchId === matchId)
      .sort((a, b) => a.seat - b.seat)
      .map(copy);
  }

  async setSeatSettlement(matchId: string, seat: number, settlement: SeatSettlement): Promise<void> {
    const row = this.s.seats.get(seatKey(matchId, seat));
    if (!row) throw new Error(`席がありません: ${matchId} ${seat}`);
    if (row.lifeId === null) throw new StoreConflictError("match_seats_check2");
    row.settlement = copy(settlement);
  }

  // チャット

  async addChatMessage(message: Omit<ChatRecord, "id">): Promise<ChatRecord> {
    if (!this.s.matches.has(message.matchId)) throw new StoreConflictError("chat_messages_match_id_fkey");
    if (message.accountId !== null) this.needAccount(message.accountId);
    const record: ChatRecord = { id: ++this.s.chatSeq, ...copy(message) };
    this.s.chat.push(record);
    return copy(record);
  }

  async listChatMessages(matchId: string): Promise<ChatRecord[]> {
    return this.s.chat.filter((m) => m.matchId === matchId).map(copy);
  }

  async addChatHold(hold: ChatHold): Promise<void> {
    if (!this.s.matches.has(hold.matchId)) throw new StoreConflictError("chat_holds_match_id_fkey");
    const key = holdKey(hold.matchId, hold.reason);
    if (this.s.holds.has(key)) throw new StoreConflictError("chat_holds_pkey");
    this.s.holds.set(key, copy(hold));
  }

  async deleteExpiredChat(before: Date, now: Date): Promise<number> {
    const held = new Set(
      [...this.s.holds.values()].filter((h) => h.holdUntil === null || h.holdUntil > now).map((h) => h.matchId),
    );
    const keep = this.s.chat.filter((m) => m.createdAt >= before || held.has(m.matchId));
    const removed = this.s.chat.length - keep.length;
    this.s.chat = keep;
    return removed;
  }

  private needAccount(id: string): void {
    if (!this.s.accounts.has(id)) throw new StoreConflictError("account_id_fkey");
  }
}
