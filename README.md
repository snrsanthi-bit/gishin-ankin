# 疑心暗金（gishin-ankin）

4人で出資額を決め合う、オンラインの心理戦・経済ゲーム。仕様はプロジェクトの「決定事項」「開発仕様_MVP」を参照。

## 構成

```
packages/
  rules/   ルールエンジン（1ゲームの計算、試合終了から次の入場までの処理）、Bot、1試合の進行、ターミナル版。画面・サーバーに依存しない
apps/
  server/  サーバー。試合の部屋（room.ts）、接続の受付（hub.ts）、WebSocket（main.ts）
  web/     （これから）React の画面
```

- 言語：TypeScript。Node.js 22 の型の取り除き機能で、ビルドせずにそのまま実行する
- テスト：Node.js 標準の `node:test`
- 開発用DB：PostgreSQL（Docker）

## 使い方

```sh
pnpm install
pnpm test        # 全パッケージのテスト
pnpm typecheck   # 型チェック
pnpm db:up       # 開発用DBを起動（Docker）
pnpm db:down     # 停止
pnpm play        # ターミナルで練習試合（あなた1人＋Bot3体）
pnpm dev:server  # サーバーを起動（ws://localhost:8787/ws）
pnpm bots        # 起動中のサーバーにBotを3体つなぐ（--n=4 でBotだけの試合）
```

動作確認のときは `THINK_SEC=20 pnpm dev:server` のように、出資受付の時間を短くできる。

`pnpm play --seed=42` で同じ試合をもう一度、`pnpm play --bots=smart,grudger,allIn` でBotを指定できる。
Botの種類：`allIn`（毎回全額）、`freeRider`（毎回0円）、`random`（ばらばら）、`grudger`（裏切られたら1回仕返し）、`smart`（協力しつつDraw直前に裏切ることがある）

## お金の扱い（packages/rules）

- ゲーム内のお金は「万円」単位の整数。1万円未満は切り捨て
- 端数の積立・利息の端数・ボーナス総額は「円」単位の整数で持つ（小数の誤差を避けるため）
- 倍率・金利は bp（1万分の1）の整数。例：α = 0.05 → 500
- 金額・倍率はすべて `RulesConfig` から読む（コードに直書きしない）

## ブランチ

| ブランチ | 役割 | 配信先 |
|---|---|---|
| main | 安定版 | Steam（将来） |
| ブラウザ版のブランチ | 先行版 | ブラウザ |
| epic/* | まとまった機能の開発・結合 | ローカル |
| 作業ブランチ | 個々の作業 | ― |

作業 → epic → ブラウザ版 → main の順に上げる。CI（GitHub Actions）はすべてのブランチで型チェックとテストを実行する。
