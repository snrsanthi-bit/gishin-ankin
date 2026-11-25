/**
 * チャット：送られた文章の整形・伏せ字・連投の制限。通信や部屋には依存しない。
 *
 * 伏せ字にするのは「明らかな暴言・差別語」と「個人情報（電話番号・メールアドレス・URL）」だけ（開発仕様 11章）。
 * それ以外の判断は運営が目で見て行うので、ここでは自動で止めたりしない。
 * 元の文章は運営用に残し、参加者には伏せ字の後の文章だけを見せる。
 *
 * 出資額の話（「100出す」「120万」など）はゲームの中心なので、ふつうの数字は伏せない。
 */

export type ChatConfig = {
  /** 1メッセージの最大文字数（整形後） */
  maxLength: number;
  /** 1メッセージの最大行数 */
  maxLines: number;
  /** 連投の制限：windowMs の間に maxPerWindow 件まで */
  maxPerWindow: number;
  windowMs: number;
  /** 部屋ごとに残すメッセージの上限 */
  maxHistory: number;
  /** 伏せ字にする言葉（暴言・差別語）。運営が増やしていく */
  blockedWords: readonly string[];
};

export const DEFAULT_CHAT_CONFIG: ChatConfig = {
  maxLength: 200,
  maxLines: 4,
  maxPerWindow: 5,
  windowMs: 10_000,
  maxHistory: 500,
  // 最小限の初期値。誤って普通の言葉まで伏せないよう、はっきりしたものだけにしている
  blockedWords: ["死ね", "氏ね", "殺すぞ", "殺してやる"],
};

const MASK = "＊＊＊";

export type ChatMessage = {
  id: number;
  seat: number;
  /** 伏せ字の後の文章（参加者に見せるもの） */
  text: string;
  /** サーバーの時刻（ミリ秒） */
  at: number;
};

/** 運営用：元の文章も持つ */
export type StoredChatMessage = ChatMessage & { original: string; playerId: string };

export type CleanResult = { ok: true; text: string; masked: boolean } | { ok: false; error: string };

/** 送られた文章を整えて伏せ字にする。空や長すぎるものはエラー */
export function cleanChatText(raw: string, config: ChatConfig = DEFAULT_CHAT_CONFIG): CleanResult {
  // 制御文字を取り除き、改行をそろえ、行末と前後の空白を落とす
  const normalized = raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/g, "")
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
  if (normalized === "") return { ok: false, error: "空のメッセージは送れません" };
  if ([...normalized].length > config.maxLength) return { ok: false, error: `${config.maxLength}文字までです` };
  if (normalized.split("\n").length > config.maxLines) return { ok: false, error: `${config.maxLines}行までです` };

  const text = maskText(normalized, config.blockedWords);
  return { ok: true, text, masked: text !== normalized };
}

/** 個人情報と暴言を伏せ字にする */
export function maskText(text: string, blockedWords: readonly string[] = DEFAULT_CHAT_CONFIG.blockedWords): string {
  let t = text;
  // 全角英数字・全角記号も同じように見つけられるよう、判定は半角にそろえた文字列で行う
  const ranges: [number, number][] = [];
  const probe = toHalfWidth(t);

  const patterns: RegExp[] = [
    // メールアドレス
    /[\w.+-]+@[\w-]+(\.[\w-]+)+/g,
    // URL（http/https、www.、よくあるドメインの形）
    /\b(?:https?:\/\/|www\.)\S+/gi,
    /\b[\w-]+(?:\.[\w-]+)*\.(?:com|net|org|jp|io|me|co|info|xyz|app|dev|gg|tv|link|ly)(?:\/\S*)?\b/gi,
    // 電話番号：0から始まる10〜11桁（区切りのハイフン・空白は可）、+81 から始まるもの
    /(?<!\d)0\d(?:[-\s]?\d){8,9}(?!\d)/g,
    /\+\s?81(?:[-\s]?\d){9,10}(?!\d)/g,
  ];
  for (const re of patterns) {
    for (const m of probe.matchAll(re)) ranges.push([m.index, m.index + m[0].length]);
  }
  for (const w of blockedWords) {
    if (!w) continue;
    let i = probe.indexOf(toHalfWidth(w));
    while (i >= 0) {
      ranges.push([i, i + w.length]);
      i = probe.indexOf(toHalfWidth(w), i + w.length);
    }
  }
  if (ranges.length === 0) return t;

  // 重なりをまとめて、後ろから置き換える（toHalfWidth は文字数を変えないので位置はそのまま使える）
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged.at(-1);
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  for (let k = merged.length - 1; k >= 0; k--) {
    const [s, e] = merged[k] as [number, number];
    t = t.slice(0, s) + MASK + t.slice(e);
  }
  return t;
}

/** 全角の英数字・記号を半角にする（1文字は1文字のまま） */
function toHalfWidth(s: string): string {
  return s.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/\u3000/g, " ");
}

/** 連投の制限（参加者ごと） */
export class RateLimiter {
  private readonly sent = new Map<string, number[]>();
  private readonly max: number;
  private readonly windowMs: number;

  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }

  /** 送ってよければ記録して true */
  take(key: string, now: number): boolean {
    const recent = (this.sent.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.sent.set(key, recent);
      return false;
    }
    recent.push(now);
    this.sent.set(key, recent);
    return true;
  }
}
