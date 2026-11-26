/** 画面表示用の小さな計算。React に依存しないのでテストしやすい */

/** 円 → 「12.5万」のような表示 */
export function man(yen: number): string {
  const v = yen / 10000;
  if (Number.isInteger(v)) return `${v}万`;
  return `${v.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}万`;
}

/** 席番号（0から）→ 「P1」 */
export const seatLabel = (seat: number): string => `P${seat + 1}`;

/** 自分を先頭に、時計回り（席番号の順）に並べる */
export function clockwise<T extends { seat: number }>(seats: readonly T[], mySeat: number): T[] {
  const n = seats.length;
  return [...seats].sort((a, b) => ((a.seat - mySeat + n) % n) - ((b.seat - mySeat + n) % n));
}

/** 締め切りまでの残り秒（切り上げ、0未満にしない） */
export function remainingSec(deadline: number | null, serverNow: number): number | null {
  if (deadline === null) return null;
  return Math.max(0, Math.ceil((deadline - serverNow) / 1000));
}

/** 入力欄の文字列を出資額にする。読めなければ null */
export function parseAmount(text: string, max: number): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n <= max ? n : null;
}

/** 実質の増減の表示（+147万 / −23万） */
export function signedMan(v: number): string {
  return v >= 0 ? `+${v}万` : `−${-v}万`;
}

/** 席ごとの形。色だけに頼らず、形でも見分けられるようにする（UI規則 8） */
export const SEAT_SHAPES = ["●", "▲", "■", "◆"] as const;
export const seatShape = (seat: number): string => SEAT_SHAPES[seat % SEAT_SHAPES.length] ?? "●";
