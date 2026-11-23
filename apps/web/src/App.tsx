import { useEffect, useState } from "react";
import type { ClientMessage, RoomView } from "@gishin-ankin/server/protocol";
import { useGame, type MoneyCheck, type Status } from "./useGame.ts";
import { clockwise, man, parseAmount, remainingSec, seatLabel, signedMan } from "./format.ts";

type MatchView = Extract<RoomView, { phase: "playing" | "finished" }>;

export function App() {
  const g = useGame();
  return (
    <main className="app">
      <header className="title">
        <h1>疑心暗金</h1>
        <ConnectionBadge status={g.status} />
      </header>
      {g.error && <p className="toast">{g.error}</p>}
      {!g.view ? (
        <Title status={g.status} onStart={g.start} />
      ) : g.view.phase === "waiting" ? (
        <Waiting joined={g.view.joined} players={g.view.players} />
      ) : (
        <Match view={g.view} offset={g.offset} checks={g.checks} send={g.send} />
      )}
    </main>
  );
}

function ConnectionBadge({ status }: { status: Status }) {
  if (status === "open" || status === "idle") return null;
  return <span className="badge warn">{status === "reconnecting" ? "再接続中…" : "接続中…"}</span>;
}

function Title({ status, onStart }: { status: Status; onStart: () => void }) {
  return (
    <section className="panel center">
      <p className="lead">4人で出資額を決め合う心理戦。全員が5回続けて全額を出せばDraw。</p>
      <button className="primary big" onClick={onStart} disabled={status !== "idle"}>
        試合を探す
      </button>
    </section>
  );
}

function Waiting({ joined, players }: { joined: number; players: number }) {
  return (
    <section className="panel center">
      <p className="lead">
        対戦相手を待っています（{joined}/{players}人）
      </p>
      <p className="hint">ひとりで試すときは、別のターミナルで pnpm bots を実行するとBotが入ってきます。</p>
    </section>
  );
}

/** 手元の時計をサーバーの時刻に合わせて、少しずつ進める */
function useServerNow(offset: number): number {
  const [now, setNow] = useState(() => Date.now() + offset);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() + offset), 250);
    return () => clearInterval(t);
  }, [offset]);
  return now;
}

function Match({
  view,
  offset,
  checks,
  send,
}: {
  view: MatchView;
  offset: number;
  checks: MoneyCheck[];
  send: (m: ClientMessage) => void;
}) {
  const now = useServerNow(offset);
  const left = remainingSec(view.deadline, now);
  const playing = view.phase === "playing" && !view.you.forfeited;

  return (
    <>
      <section className="panel status">
        <div>
          ゲーム <strong>{Math.min(view.game + 1, view.gamesPerMatch)}</strong>/{view.gamesPerMatch}
        </div>
        <Streak streak={view.streak} drawStreak={view.drawStreak} />
        {left !== null && <div className={left <= 10 ? "timer urgent" : "timer"}>残り {left}秒</div>}
      </section>

      <section className="panel mine">
        <div>
          あなた（{seatLabel(view.you.seat)}）の所持金
          <div className="money">{view.you.money}万</div>
        </div>
        {view.isTop && view.phase === "playing" && <span className="badge gold">★ あなたが1位です</span>}
        {view.you.forfeited && <span className="badge">棄権しました</span>}
      </section>

      <Seats view={view} checks={checks} send={send} />

      {view.last && <LastGame view={view} />}

      {playing && <ContributionForm key={view.game} view={view} send={send} />}

      {view.finished && <Finished view={view} send={send} />}
    </>
  );
}

function Streak({ streak, drawStreak }: { streak: number; drawStreak: number }) {
  return (
    <div className="streak" title="全員が全額出資した連続回数">
      全員全額の連続
      <span className="dots">
        {Array.from({ length: drawStreak }, (_, i) => (
          <span key={i} className={i < streak ? "dot on" : "dot"} />
        ))}
      </span>
      Drawまであと{drawStreak - streak}回
    </div>
  );
}

function Seats({ view, checks, send }: { view: MatchView; checks: MoneyCheck[]; send: (m: ClientMessage) => void }) {
  const canCheck = view.phase === "playing" && view.you.moneyChecksLeft > 0 && !view.you.forfeited;
  return (
    <section className="seats">
      {clockwise(view.seats, view.you.seat).map((s) => {
        const me = s.seat === view.you.seat;
        const checked = checks.filter((c) => c.seat === s.seat);
        return (
          <div key={s.seat} className={me ? "seat me" : "seat"}>
            <div className="seat-name">
              {seatLabel(s.seat)}
              {me && "（あなた）"}
            </div>
            <div className="seat-state">
              {s.forfeited ? (
                <span className="badge">棄権</span>
              ) : !s.connected ? (
                <span className="badge warn">離席中</span>
              ) : view.phase === "playing" ? (
                <span className={s.confirmed ? "badge ok" : "badge"}>{s.confirmed ? "確定済み" : "考え中"}</span>
              ) : null}
            </div>
            {checked.map((c, i) => (
              <div key={i} className="hint">
                ゲーム{c.game + 1}開始時：{c.money}万
              </div>
            ))}
            {!me && canCheck && !s.forfeited && (
              <button className="small" onClick={() => send({ type: "checkMoney", seat: s.seat })}>
                所持金を確認（残り{view.you.moneyChecksLeft}回）
              </button>
            )}
          </div>
        );
      })}
    </section>
  );
}

function LastGame({ view }: { view: MatchView }) {
  const l = view.last;
  if (!l) return null;
  const message =
    l.streakAfter > 0
      ? `全員が全額出資！ 連続${l.streakAfter}回`
      : l.distributionYen === 0
        ? "誰も出資しませんでした"
        : "連続が途切れました（誰かが全額出資しなかった）";
  return (
    <section className="panel last">
      <div className="label">前のゲーム</div>
      <div className="row">
        <span>出資 {l.contribution}万</span>
        <span>分配 {man(l.distributionYen)}</span>
        <span>ボーナス {man(l.bonusYen)}</span>
        <span>
          所持金 {l.moneyBefore}万 → <strong>{l.moneyAfter}万</strong>
        </span>
      </div>
      <div className={l.streakAfter > 0 ? "good" : "bad"}>{message}</div>
    </section>
  );
}

function ContributionForm({ view, send }: { view: MatchView; send: (m: ClientMessage) => void }) {
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
    <section className="panel form">
      <label className="label" htmlFor="amount">
        出資額（0〜{money}万）
      </label>
      <div className="row">
        <input
          id="amount"
          inputMode="numeric"
          value={text}
          disabled={confirmed}
          onChange={(e) => onText(e.target.value)}
          placeholder="0"
        />
        <span>万</span>
        <button onClick={() => set(0)} disabled={confirmed}>
          0円
        </button>
        <button onClick={() => set(Math.floor(money / 2))} disabled={confirmed}>
          半分
        </button>
        <button onClick={() => set(money)} disabled={confirmed}>
          全額
        </button>
      </div>
      {text !== "" && amount === null && <div className="bad">0〜{money}の整数で入力してください</div>}
      <div className="row">
        {confirmed ? (
          <button onClick={() => send({ type: "confirm", confirmed: false })}>確定を取り消す</button>
        ) : (
          <button className="primary" onClick={() => send({ type: "confirm", confirmed: true })} disabled={text !== "" && amount === null}>
            {amount === null ? "0円で確定" : `${amount}万で確定`}
          </button>
        )}
      </div>
      <p className="hint">締め切りまで何度でも変えられます。確定しなくても、締め切りの時点で入力している額が出資になります。何も入力しないと不在（0円）扱いです。</p>
    </section>
  );
}

function Finished({ view, send }: { view: MatchView; send: (m: ClientMessage) => void }) {
  const [showRecord, setShowRecord] = useState(false);
  const f = view.finished;
  if (!f) return null;
  return (
    <section className="panel finished">
      <h2>{f.draw ? "🤝 Draw成立" : "試合終了"}</h2>
      <div className="row">
        <span>
          持ち帰り <strong>{f.money}万</strong>
        </span>
        <span>{f.rank}位</span>
        <span>次の参加費 {f.nextFee}万</span>
        <span>
          実質 <strong>{signedMan(f.money - f.nextFee)}</strong>
        </span>
      </div>
      <div className="row">
        <button onClick={() => setShowRecord((s) => !s)}>{showRecord ? "牌譜を閉じる" : "牌譜を見る"}</button>
        <button className="primary" onClick={() => send({ type: "next" })}>
          次の試合へ
        </button>
      </div>
      {showRecord && (
        <table className="record">
          <thead>
            <tr>
              <th />
              {view.seats.map((s) => (
                <th key={s.seat} className={s.seat === view.you.seat ? "me" : ""}>
                  {seatLabel(s.seat)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {f.record.map((row, gi) => (
              <tr key={gi}>
                <th>G{gi + 1}</th>
                {row.map((c, si) => (
                  <td key={si} className={si === view.you.seat ? "me" : ""}>
                    {c === null ? "棄権" : c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
