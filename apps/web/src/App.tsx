/**
 * 画面の配置は「claude/UI規則.md」に従う。
 * - 主役はチャット。真ん中に大きく置く。チャット欄には人間の言葉だけを流す
 * - 周りに4席（自分を下に、時計回り）、上に連続回数のランプと残り時間の輪、ゲームごとの●／×
 * - 出資の入力は下に固定。所持金確認など普段使わない操作はたたむ
 * - 状態は文字ではなく、形（封筒・ランプ・輪）で見せる。説明はカーソルを合わせたときだけ
 * 動き・音・カットインはまだ入れていない（次の作業）
 */
import { useEffect, useRef, useState } from "react";
import type { ChatMessage, ClientMessage, RoomView, SeatView } from "@gishin-ankin/server/protocol";
import { useGame, type MoneyCheck, type Status } from "./useGame.ts";
import { clockwise, man, parseAmount, remainingSec, seatLabel, seatShape, signedMan } from "./format.ts";

type MatchView = Extract<RoomView, { phase: "playing" | "finished" }>;
type Send = (m: ClientMessage) => void;

export function App() {
  const g = useGame();
  if (!g.view) return <Title status={g.status} onStart={g.start} />;
  if (g.view.phase === "waiting") return <Waiting joined={g.view.joined} players={g.view.players} status={g.status} />;
  return (
    <Table
      view={g.view}
      offset={g.offset}
      checks={g.checks}
      chat={g.chat}
      error={g.error}
      status={g.status}
      send={g.send}
      sendChat={g.sendChat}
    />
  );
}

function Title({ status, onStart }: { status: Status; onStart: () => void }) {
  return (
    <main className="screen center">
      <h1 className="logo">疑心暗金</h1>
      <p className="lead">4人で出資額を決め合う心理戦</p>
      <button className="primary big" onClick={onStart} disabled={status !== "idle"}>
        試合を探す
      </button>
    </main>
  );
}

function Waiting({ joined, players, status }: { joined: number; players: number; status: Status }) {
  return (
    <main className="screen center">
      <h1 className="logo">疑心暗金</h1>
      <div className="waiting-seats" title={`${joined}/${players}人`}>
        {Array.from({ length: players }, (_, i) => (
          <span key={i} className={i < joined ? "chair taken" : "chair"} />
        ))}
      </div>
      <p className="lead">対戦相手を待っています</p>
      {status === "reconnecting" && <p className="hint">再接続中…</p>}
    </main>
  );
}

/** 手元の時計をサーバーの時刻に合わせて進める */
function useServerNow(offset: number): number {
  const [now, setNow] = useState(() => Date.now() + offset);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() + offset), 200);
    return () => clearInterval(t);
  }, [offset]);
  return now;
}

function Table(props: {
  view: MatchView;
  offset: number;
  checks: MoneyCheck[];
  chat: ChatMessage[];
  error: string | null;
  status: Status;
  send: Send;
  sendChat: (text: string) => void;
}) {
  const { view, send } = props;
  const now = useServerNow(props.offset);
  const [, left, top, right] = clockwise(view.seats, view.you.seat);

  return (
    <main className="table">
      <header className="bar">
        <span className="logo small">疑心暗金</span>
        <GameMarks outcomes={view.outcomes} total={view.gamesPerMatch} current={view.game} finished={view.phase === "finished"} />
        <span className="bar-right">{props.status === "reconnecting" && <span className="badge warn">再接続中…</span>}</span>
      </header>

      <div className="area-top">{top && <Seat seat={top} view={view} checks={props.checks} send={send} />}</div>
      <div className="area-left">{left && <Seat seat={left} view={view} checks={props.checks} send={send} />}</div>
      <div className="area-right">{right && <Seat seat={right} view={view} checks={props.checks} send={send} />}</div>

      <section className="area-center">
        <div className="center-head">
          <Lamps streak={view.streak} drawStreak={view.drawStreak} draw={view.finished?.draw ?? false} />
          {view.phase === "playing" && <TimerRing deadline={view.deadline} thinkMs={view.thinkMs} now={now} />}
        </div>
        <Chat messages={props.chat} mySeat={view.you.seat} onSend={props.sendChat} />
      </section>

      <section className="area-me">
        <MyArea view={view} send={send} />
        {props.error && <p className="toast">{props.error}</p>}
      </section>
    </main>
  );
}

/** ゲーム1〜10のマス：●＝全員が全額出資、×＝途切れた */
function GameMarks({ outcomes, total, current, finished }: { outcomes: boolean[]; total: number; current: number; finished: boolean }) {
  return (
    <ol className="marks" title="ゲームごとの結果（●＝全員が全額出資／×＝途切れた）">
      {Array.from({ length: total }, (_, i) => {
        const o = outcomes[i];
        const cls = o === undefined ? (i === current && !finished ? "mark now" : "mark") : o ? "mark ok" : "mark ng";
        return (
          <li key={i} className={cls} aria-label={`ゲーム${i + 1}`}>
            {o === undefined ? "" : o ? "●" : "×"}
          </li>
        );
      })}
    </ol>
  );
}

/** 連続回数：5つのランプ */
function Lamps({ streak, drawStreak, draw }: { streak: number; drawStreak: number; draw: boolean }) {
  return (
    <div className={draw ? "lamps draw" : "lamps"} title={`全員が全額出資した連続回数（${drawStreak}回でDraw）`}>
      {Array.from({ length: drawStreak }, (_, i) => (
        <span key={i} className={i < streak || draw ? "lamp on" : "lamp"} />
      ))}
    </div>
  );
}

/** 残り時間：縮んでいく輪 */
function TimerRing({ deadline, thinkMs, now }: { deadline: number | null; thinkMs: number; now: number }) {
  const left = remainingSec(deadline, now);
  if (left === null || deadline === null) return null;
  const ratio = Math.max(0, Math.min(1, (deadline - now) / thinkMs));
  const r = 18;
  const c = 2 * Math.PI * r;
  return (
    <svg className={left <= 10 ? "ring urgent" : "ring"} viewBox="0 0 44 44" width="44" height="44" aria-label={`残り${left}秒`}>
      <title>{`残り${left}秒`}</title>
      <circle cx="22" cy="22" r={r} className="ring-bg" />
      <circle cx="22" cy="22" r={r} className="ring-fg" strokeDasharray={c} strokeDashoffset={c * (1 - ratio)} />
    </svg>
  );
}

/** 席の印：色・形・P番号をまとめたもの。席とチャットで同じものを使う */
function SeatMark({ seat }: { seat: number }) {
  return (
    <span className={`seat-mark s${seat}`}>
      <span className="shape">{seatShape(seat)}</span>
      {seatLabel(seat)}
    </span>
  );
}

function seatState(s: SeatView, playing: boolean): { icon: string; label: string; cls: string } {
  if (s.forfeited) return { icon: "✕", label: "棄権", cls: "forfeited" };
  if (!s.connected) return { icon: "💤", label: "離席中", cls: "away" };
  if (playing && s.confirmed) return { icon: "✉", label: "確定済み", cls: "confirmed" };
  return { icon: "", label: playing ? "考え中" : "", cls: "" };
}

function Seat({ seat, view, checks, send }: { seat: SeatView; view: MatchView; checks: MoneyCheck[]; send: Send }) {
  const state = seatState(seat, view.phase === "playing");
  const mine = checks.filter((c) => c.seat === seat.seat);
  const canCheck = view.phase === "playing" && view.you.moneyChecksLeft > 0 && !view.you.forfeited && !seat.forfeited;
  return (
    <div className={`seat ${state.cls}`} title={state.label}>
      <div className="seat-name">
        <SeatMark seat={seat.seat} />
      </div>
      <div className="envelope" aria-label={state.label}>
        {state.icon}
      </div>
      {mine.map((c, i) => (
        <div key={i} className="checked" title={`ゲーム${c.game + 1}開始時の所持金`}>
          {c.money}万
        </div>
      ))}
      {canCheck && (
        <details className="fold">
          <summary title="所持金を確認" aria-label="所持金を確認">
            🔍
          </summary>
          <button className="small" onClick={() => send({ type: "checkMoney", seat: seat.seat })}>
            所持金を確認（残り{view.you.moneyChecksLeft}回）
          </button>
        </details>
      )}
    </div>
  );
}

function Chat({ messages, mySeat, onSend }: { messages: ChatMessage[]; mySeat: number; onSend: (t: string) => void }) {
  const [text, setText] = useState("");
  const [unread, setUnread] = useState(false);
  const listRef = useRef<HTMLOListElement | null>(null);
  /** いちばん下を見ているか（読み返している最中は false） */
  const atBottom = useRef(true);
  const prevCount = useRef(0);

  const scrollToBottom = () => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottom.current = true;
    setUnread(false);
  };

  // 初回表示・入り直しで履歴をまとめて受け取ったとき・自分が送ったときは、いちばん下へ。
  // それ以外の新着は、いちばん下を見ているときだけ追いかける（読み返しの邪魔をしない）
  useEffect(() => {
    const added = messages.length - prevCount.current;
    const bulk = prevCount.current === 0 || added > 1 || added < 0;
    prevCount.current = messages.length;
    if (added === 0) return;
    const mine = messages.at(-1)?.seat === mySeat;
    if (bulk || mine || atBottom.current) scrollToBottom();
    else setUnread(true);
  }, [messages, mySeat]);

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText("");
  };

  return (
    <div className="chat">
      <ol
        className="chat-list"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          if (atBottom.current) setUnread(false);
        }}
      >
        {messages.map((m, i) => {
          // LINEのように、自分の発言は右、ほかの人は左。席ごとの色と形の印で誰かが分かる。
          // 同じ人が続けて話したときは、印を最初の1回だけ出す
          const mine = m.seat === mySeat;
          const first = messages[i - 1]?.seat !== m.seat;
          return (
            <li key={m.id} className={`msg s${m.seat} ${mine ? "mine" : "other"} ${first ? "first" : "cont"}`}>
              {!mine && (
                <span className="avatar" aria-label={seatLabel(m.seat)} title={seatLabel(m.seat)}>
                  {first ? <SeatMark seat={m.seat} /> : null}
                </span>
              )}
              <span className="bubble">{m.text}</span>
            </li>
          );
        })}
      </ol>
      {unread && (
        <button className="unread" onClick={scrollToBottom}>
          ↓ 新しい発言
        </button>
      )}
      <div className="chat-input">
        <input
          value={text}
          maxLength={200}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            // 日本語の変換を確定する Enter は IME に任せ、何もしない（送らない・止めない）。
            // Safari は確定の Enter で isComposing が false になることがあるので、keyCode 229 も見る
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            e.preventDefault();
            submit();
          }}
          placeholder="話しかける"
          aria-label="チャット"
        />
        <button onClick={submit} disabled={text.trim() === ""}>
          送る
        </button>
      </div>
    </div>
  );
}

function MyArea({ view, send }: { view: MatchView; send: Send }) {
  const l = view.last;
  return (
    <div className="me-row">
      <div className="me-seat">
        <div className="seat-name">
          <SeatMark seat={view.you.seat} />
          {view.isTop && view.phase === "playing" && (
            <span className="crown" title="あなたが1位です">
              ♛
            </span>
          )}
        </div>
        <div className="coins" title="あなたの試合内所持金">
          <span className="coin-icon">◎</span>
          <span className="money">{view.you.money}</span>
          <span className="unit">万</span>
        </div>
        {l && (
          <div className="last" title="前のゲーム：出資／分配／ボーナス">
            −{l.contribution} ＋{man(l.distributionYen)} ＋{man(l.bonusYen)}
          </div>
        )}
      </div>
      {view.phase === "playing" && !view.you.forfeited && <ContributionForm key={view.game} view={view} send={send} />}
      {view.phase === "playing" && view.you.forfeited && <div className="note">棄権しました</div>}
      {view.finished && <Finished view={view} send={send} />}
    </div>
  );
}

function ContributionForm({ view, send }: { view: MatchView; send: Send }) {
  const money = view.you.money;
  const [text, setText] = useState(view.you.input === null ? "" : String(view.you.input));
  const amount = parseAmount(text, money);
  const confirmed = view.you.confirmed;

  const set = (v: number) => {
    setText(String(v));
    send({ type: "input", amount: v });
  };
  const onText = (t: string) => {
    setText(t);
    const a = parseAmount(t, money);
    if (a !== null) send({ type: "input", amount: a });
  };

  return (
    <div className="contribute">
      <div className="amount">
        <input
          inputMode="numeric"
          value={text}
          disabled={confirmed}
          onChange={(e) => onText(e.target.value)}
          placeholder="0"
          aria-label={`出資額（0〜${money}万）`}
          className={text !== "" && amount === null ? "invalid" : ""}
        />
        <span className="unit">/ {money}万</span>
      </div>
      <div className="quick">
        <button onClick={() => set(0)} disabled={confirmed}>
          0
        </button>
        <button onClick={() => set(Math.floor(money / 2))} disabled={confirmed}>
          半分
        </button>
        <button onClick={() => set(money)} disabled={confirmed}>
          全額
        </button>
      </div>
      {confirmed ? (
        <button className="confirm done" onClick={() => send({ type: "confirm", confirmed: false })} title="確定を取り消す">
          ✉ 確定済み
        </button>
      ) : (
        <button
          className="confirm primary"
          onClick={() => send({ type: "confirm", confirmed: true })}
          disabled={text !== "" && amount === null}
          title="締め切りまでは取り消せます。確定しなくても、締め切りの時点で入力している額が出資になります"
        >
          確定
        </button>
      )}
    </div>
  );
}

function Finished({ view, send }: { view: MatchView; send: Send }) {
  const [showRecord, setShowRecord] = useState(false);
  const f = view.finished;
  if (!f) return null;
  return (
    <div className="finished">
      <div className="result">
        <span className="result-title">{f.draw ? "Draw" : "終了"}</span>
        <strong>{f.money}万</strong>
        <span>{f.rank}位</span>
        <span title={`次の参加費 ${f.nextFee}万`}>実質 {signedMan(f.money - f.nextFee)}</span>
      </div>
      <div className="quick">
        <button onClick={() => setShowRecord((s) => !s)}>{showRecord ? "牌譜を閉じる" : "牌譜を見る"}</button>
        <button className="primary" onClick={() => send({ type: "next" })}>
          次の試合へ
        </button>
      </div>
      {showRecord && (
        <div className="overlay" onClick={() => setShowRecord(false)}>
          <table className="record" onClick={(e) => e.stopPropagation()}>
            <thead>
              <tr>
                <th />
                {view.seats.map((s) => (
                  <th key={s.seat} className={s.seat === view.you.seat ? "me" : ""}>
                    {seatLabel(s.seat)}
                  </th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {f.record.map((row, gi) => (
                <tr key={gi}>
                  <th>{gi + 1}</th>
                  {row.map((c, si) => (
                    <td key={si} className={si === view.you.seat ? "me" : ""}>
                      {c === null ? "✕" : c}
                    </td>
                  ))}
                  <td>{view.outcomes[gi] ? "●" : "×"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
