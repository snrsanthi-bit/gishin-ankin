/**
 * 試合の部屋（4人）。通信や時計に依存しない純粋な状態管理だけを置く。
 * 時刻は呼び出し側から now（ミリ秒）で渡す。WebSocket などのつなぎ込みは別ファイルで行う。
 *
 * 情報の見え方は開発仕様 6-4 に従う：
 * - 他人の所持金・入力中の出資額は見せない（所持金確認で、ゲーム開始時の額だけ見られる）
 * - 誰が確定済みか・誰が離席中かは全員に見せる
 * - 出資の内訳（牌譜）は試合が終わってから
 */
import {
  DEFAULT_CONFIG,
  createRng,
  newMatch,
  nextFeeOf,
  resolveGame,
  shuffled,
  type Contribution,
  type GameResult,
  type MatchState,
  type Rng,
  type RulesConfig,
} from "@gishin-ankin/rules";
import { DEFAULT_CHAT_CONFIG, RateLimiter, cleanChatText, type ChatConfig, type ChatMessage, type StoredChatMessage } from "./chat.ts";

export type RoomConfig = {
  players: number;
  /** 1ゲームの出資受付時間（ミリ秒） */
  thinkMs: number;
  /** 1試合あたりの所持金確認の回数 */
  moneyChecksPerMatch: number;
  rules: RulesConfig;
  chat: ChatConfig;
};

export const DEFAULT_ROOM_CONFIG: RoomConfig = {
  players: 4,
  thinkMs: 180_000,
  moneyChecksPerMatch: 1,
  rules: DEFAULT_CONFIG,
  chat: DEFAULT_CHAT_CONFIG,
};

export type RoomPhase = "waiting" | "playing" | "finished";

type Player = {
  id: string;
  /** 席番号（0から）。4人そろうまでは -1 */
  seat: number;
  connected: boolean;
  /** 入力中の出資額。一度も入力していなければ null（締め切りで不在＝0円扱い） */
  input: number | null;
  confirmed: boolean;
  moneyChecksLeft: number;
};

export type SeatView = { seat: number; connected: boolean; confirmed: boolean; forfeited: boolean };

export type LastGameView = {
  /** そのゲームの開始時の自分の所持金 */
  moneyBefore: number;
  contribution: number;
  distributionYen: number;
  bonusYen: number;
  moneyAfter: number;
  streakAfter: number;
};

export type FinishedView = {
  draw: boolean;
  /** 持ち帰る試合内所持金（万円） */
  money: number;
  /** 順位（同率は同じ順位） */
  rank: number;
  nextFee: number;
  /** 牌譜：各ゲームの席ごとの出資額（棄権した席は null） */
  record: (number | null)[][];
};

export type RoomView =
  | { phase: "waiting"; joined: number; players: number }
  | {
      phase: "playing" | "finished";
      you: { seat: number; money: number; input: number | null; confirmed: boolean; forfeited: boolean; moneyChecksLeft: number };
      game: number;
      gamesPerMatch: number;
      streak: number;
      drawStreak: number;
      /** 出資の締め切り（ミリ秒）。終了後は null */
      deadline: number | null;
      /** 自分が1位か（同率を含む） */
      isTop: boolean;
      seats: SeatView[];
      last: LastGameView | null;
      finished: FinishedView | null;
    };

export type Result<T = void> = { ok: true; value: T } | { ok: false; error: string };
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const err = (error: string): Result<never> => ({ ok: false, error });

export class Room {
  readonly config: RoomConfig;
  phase: RoomPhase = "waiting";
  private readonly rng: Rng;
  private readonly players: Player[] = [];
  private match: MatchState | null = null;
  private deadline: number | null = null;
  private readonly history: GameResult[] = [];
  private nextFee: number | null = null;
  private readonly chatLog: StoredChatMessage[] = [];
  private nextChatId = 1;
  private readonly chatLimiter: RateLimiter;

  constructor(config: RoomConfig = DEFAULT_ROOM_CONFIG, seed = Math.floor(Math.random() * 1e9)) {
    this.config = config;
    this.rng = createRng(seed);
    this.chatLimiter = new RateLimiter(config.chat.maxPerWindow, config.chat.windowMs);
  }

  /** 入室。試合中に同じ id で入り直すと再接続になる */
  join(id: string, now: number): Result {
    const existing = this.players.find((p) => p.id === id);
    if (existing) {
      existing.connected = true;
      return ok(undefined);
    }
    if (this.phase !== "waiting") return err("試合はすでに始まっています");
    if (this.players.length >= this.config.players) return err("満員です");
    this.players.push({ id, seat: -1, connected: true, input: null, confirmed: false, moneyChecksLeft: 0 });
    if (this.players.length === this.config.players) this.start(now);
    return ok(undefined);
  }

  /** 退室・切断。待機中なら部屋から外し、試合中なら離席中として扱う */
  leave(id: string): void {
    const i = this.players.findIndex((p) => p.id === id);
    if (i < 0) return;
    if (this.phase === "waiting") this.players.splice(i, 1);
    else {
      const p = this.players[i];
      if (p) p.connected = false;
    }
  }

  private start(now: number): void {
    // 席番号は入室順ではなくランダム（番号から相手を推測されにくくする）
    const seats = shuffled(
      this.players.map((_, i) => i),
      this.rng,
    );
    this.players.forEach((p, i) => {
      p.seat = seats[i] ?? i;
      p.moneyChecksLeft = this.config.moneyChecksPerMatch;
    });
    this.players.sort((a, b) => a.seat - b.seat);
    this.match = newMatch(this.config.rules, this.config.players);
    this.phase = "playing";
    this.deadline = now + this.config.thinkMs;
  }

  private playing(id: string): Result<{ player: Player; match: MatchState }> {
    const player = this.players.find((p) => p.id === id);
    if (!player) return err("この部屋の参加者ではありません");
    if (this.phase !== "playing" || !this.match) return err("試合中ではありません");
    if (this.match.seats[player.seat]?.forfeited) return err("棄権しています");
    return ok({ player, match: this.match });
  }

  /** 出資額の入力。締め切りまで何度でも変えられる。変えたら確定は取り消し */
  setInput(id: string, amount: number): Result {
    const r = this.playing(id);
    if (!r.ok) return r;
    const money = r.value.match.seats[r.value.player.seat]?.money ?? 0;
    if (!Number.isInteger(amount) || amount < 0 || amount > money) return err(`出資額は0〜${money}万の整数です`);
    r.value.player.input = amount;
    r.value.player.confirmed = false;
    return ok(undefined);
  }

  /** 確定・確定の取り消し。入力していなければ0円で確定する */
  confirm(id: string, confirmed = true): Result {
    const r = this.playing(id);
    if (!r.ok) return r;
    if (confirmed && r.value.player.input === null) r.value.player.input = 0;
    r.value.player.confirmed = confirmed;
    return ok(undefined);
  }

  /** 所持金確認：相手の「ゲーム開始時の」所持金。入力中の出資額は反映しない。相手には通知しない */
  checkMoney(id: string, targetSeat: number): Result<number> {
    const r = this.playing(id);
    if (!r.ok) return r;
    const { player, match } = r.value;
    if (player.moneyChecksLeft <= 0) return err("所持金確認は、この試合ではもう使いました");
    const target = match.seats[targetSeat];
    if (!target || targetSeat === player.seat) return err("確認できない席です");
    player.moneyChecksLeft--;
    return ok(target.money);
  }

  /**
   * 時間を進める。締め切りを過ぎたか、参加中の全員が確定していたら、ゲームを締め切る。
   * 締め切ったら true。
   */
  tick(now: number): boolean {
    if (this.phase !== "playing" || !this.match || this.deadline === null) return false;
    const match = this.match;
    const active = this.players.filter((p) => !match.seats[p.seat]?.forfeited);
    const allConfirmed = active.length > 0 && active.every((p) => p.confirmed);
    if (!allConfirmed && now < this.deadline) return false;
    this.resolve(now);
    return true;
  }

  private resolve(now: number): void {
    if (!this.match) return;
    const inputs: Contribution[] = this.players.map((p) => p.input);
    const { state, result } = resolveGame(this.config.rules, this.match, inputs);
    this.match = state;
    this.history.push(result);
    for (const p of this.players) {
      p.input = null;
      p.confirmed = false;
    }
    if (state.finished) {
      this.phase = "finished";
      this.deadline = null;
      this.nextFee = nextFeeOf(this.config.rules, {
        money: 0,
        draw: state.draw,
        bonusTotalYen: state.bonusTotalYen,
        remainderYen: state.remainderYen,
      }).fee;
    } else {
      this.deadline = now + this.config.thinkMs;
    }
  }

  /** 参加者ごとの画面に出す情報 */
  viewFor(id: string): Result<RoomView> {
    if (this.phase === "waiting") {
      if (!this.players.some((p) => p.id === id)) return err("この部屋の参加者ではありません");
      return ok({ phase: "waiting", joined: this.players.length, players: this.config.players });
    }
    const player = this.players.find((p) => p.id === id);
    const match = this.match;
    if (!player || !match) return err("この部屋の参加者ではありません");
    const mySeat = match.seats[player.seat];
    const money = mySeat?.money ?? 0;
    const activeMoney = match.seats.filter((s) => !s.forfeited).map((s) => s.money);
    const lastResult = this.history.at(-1);
    const lastMine = lastResult?.seats[player.seat];

    let finished: FinishedView | null = null;
    if (this.phase === "finished") {
      finished = {
        draw: match.draw,
        money,
        rank: 1 + match.seats.filter((s) => s.money > money).length,
        nextFee: this.nextFee ?? this.config.rules.stake,
        record: this.history.map((g) => g.seats.map((s) => (s ? s.contribution : null))),
      };
    }

    return ok({
      phase: this.phase,
      you: {
        seat: player.seat,
        money,
        input: player.input,
        confirmed: player.confirmed,
        forfeited: mySeat?.forfeited ?? false,
        moneyChecksLeft: player.moneyChecksLeft,
      },
      game: match.gamesPlayed,
      gamesPerMatch: this.config.rules.gamesPerMatch,
      streak: match.streak,
      drawStreak: this.config.rules.drawStreak,
      deadline: this.deadline,
      isTop: !mySeat?.forfeited && money >= Math.max(...activeMoney),
      seats: this.players.map((p) => ({
        seat: p.seat,
        connected: p.connected,
        confirmed: p.confirmed,
        forfeited: match.seats[p.seat]?.forfeited ?? false,
      })),
      last:
        lastResult && lastMine
          ? {
              moneyBefore: lastMine.moneyBefore,
              contribution: lastMine.contribution,
              distributionYen: lastMine.distributionYen,
              bonusYen: lastMine.bonusYen,
              moneyAfter: lastMine.moneyAfter,
              streakAfter: lastResult.streakAfter,
            }
          : null,
      finished,
    });
  }

  /**
   * チャットを送る。試合中と、試合後の結果発表中に使える（席番号が決まっている間）。
   * 参加者に見せるのは伏せ字の後の文章だけ。元の文章は運営用に残す
   */
  sendChat(id: string, raw: string, now: number): Result<ChatMessage> {
    const player = this.players.find((p) => p.id === id);
    if (!player) return err("この部屋の参加者ではありません");
    if (this.phase === "waiting") return err("試合が始まってから話せます");
    const cleaned = cleanChatText(raw, this.config.chat);
    if (!cleaned.ok) return cleaned;
    if (!this.chatLimiter.take(id, now)) return err("少し間をあけてから送ってください");
    const message: ChatMessage = { id: this.nextChatId++, seat: player.seat, text: cleaned.text, at: now };
    this.chatLog.push({ ...message, original: raw, playerId: id });
    if (this.chatLog.length > this.config.chat.maxHistory) this.chatLog.shift();
    return ok(message);
  }

  /** 参加者に見せるチャットの履歴（伏せ字の後） */
  chatHistory(): ChatMessage[] {
    return this.chatLog.map(({ id, seat, text, at }) => ({ id, seat, text, at }));
  }

  /** 運営用：元の文章と送った人を含む記録（モデレーション・保存用） */
  chatRecordForOperator(): readonly StoredChatMessage[] {
    return this.chatLog;
  }

  /** 部屋にいる参加者の id */
  playerIds(): string[] {
    return this.players.map((p) => p.id);
  }
}
