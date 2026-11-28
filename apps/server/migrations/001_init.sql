-- 人生とお金の土台（設計：claude/設計_epic-life.md 3章）
-- お金：万円の整数。円の項目（*_yen）は円の整数。どちらも bigint で持つ

-- アカウント。人生をまたいで残る。Discordアカウント1つにつき1つ
CREATE TABLE accounts (
  id           text PRIMARY KEY,
  discord_id   text NOT NULL UNIQUE,
  display_name text NOT NULL,
  created_at   timestamptz NOT NULL
);

-- ログイン中の印。トークンそのものは持たず、ハッシュだけ持つ
CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts (id),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_expires_at ON sessions (expires_at);

-- 試合
CREATE TABLE matches (
  id              text PRIMARY KEY,
  kind            text NOT NULL CHECK (kind IN ('real', 'practice', 'tutorial')),
  status          text NOT NULL CHECK (status IN ('in_progress', 'finished', 'void')),
  started_at      timestamptz NOT NULL,
  ended_at        timestamptz,
  draw            boolean NOT NULL DEFAULT false,
  bonus_total_yen bigint NOT NULL DEFAULT 0,
  remainder_yen   bigint NOT NULL DEFAULT 0,
  -- 牌譜：{ "v": 1, "games": [GameResult, ...] }
  record          jsonb NOT NULL DEFAULT '{"v": 1, "games": []}',
  CHECK ((status = 'in_progress') = (ended_at IS NULL))
);
CREATE INDEX matches_in_progress ON matches (id) WHERE status = 'in_progress';

-- 人生。生存中は1アカウントにつき1つ
CREATE TABLE lives (
  id               text PRIMARY KEY,
  account_id       text NOT NULL REFERENCES accounts (id),
  status           text NOT NULL CHECK (status IN ('alive', 'ended')),
  cash             bigint NOT NULL CHECK (cash >= 0),
  debt             bigint NOT NULL CHECK (debt >= 0),
  interest_acc_yen bigint NOT NULL CHECK (interest_acc_yen >= 0),
  next_fee         bigint NOT NULL CHECK (next_fee >= 0),
  -- 入場で埋め、試合後の処理（または無効）で空にする。埋まっている人生は入場できない
  current_match_id text REFERENCES matches (id),
  matches_played   integer NOT NULL DEFAULT 0,
  started_at       timestamptz NOT NULL,
  ended_at         timestamptz,
  CHECK ((status = 'alive') = (ended_at IS NULL)),
  CHECK (status = 'alive' OR current_match_id IS NULL)
);
CREATE UNIQUE INDEX lives_one_alive_per_account ON lives (account_id) WHERE status = 'alive';

-- 試合の席ごとの記録。練習試合にも作る（お金の項目は空）
CREATE TABLE match_seats (
  match_id   text NOT NULL REFERENCES matches (id),
  seat       smallint NOT NULL CHECK (seat >= 0),
  account_id text REFERENCES accounts (id),           -- Botの席は空
  life_id    text REFERENCES lives (id),              -- 人生のお金が動かない席は空

  -- 入場前・入場（life_id があるときは必ず入る）
  cash_before             bigint,
  debt_before             bigint,
  interest_acc_yen_before bigint,
  fee                     bigint,
  borrowed                bigint,

  -- 試合後の処理（終わるまでは空）
  money_out              bigint,
  bonus_received_yen     bigint,
  interest_added         bigint,
  repaid                 bigint,
  next_fee               bigint,
  life_ended             boolean,
  cash_after             bigint,
  debt_after             bigint,
  interest_acc_yen_after bigint,

  PRIMARY KEY (match_id, seat),
  UNIQUE (match_id, life_id),
  CHECK (account_id IS NOT NULL OR life_id IS NULL),
  CHECK (
    (life_id IS NULL AND cash_before IS NULL AND debt_before IS NULL AND interest_acc_yen_before IS NULL
       AND fee IS NULL AND borrowed IS NULL)
    OR
    (life_id IS NOT NULL AND cash_before IS NOT NULL AND debt_before IS NOT NULL AND interest_acc_yen_before IS NOT NULL
       AND fee IS NOT NULL AND borrowed IS NOT NULL)
  ),
  CHECK (
    (money_out IS NULL AND bonus_received_yen IS NULL AND interest_added IS NULL AND repaid IS NULL
       AND next_fee IS NULL AND life_ended IS NULL AND cash_after IS NULL AND debt_after IS NULL
       AND interest_acc_yen_after IS NULL)
    OR
    (life_id IS NOT NULL AND money_out IS NOT NULL AND bonus_received_yen IS NOT NULL AND interest_added IS NOT NULL
       AND repaid IS NOT NULL AND next_fee IS NOT NULL AND life_ended IS NOT NULL AND cash_after IS NOT NULL
       AND debt_after IS NOT NULL AND interest_acc_yen_after IS NOT NULL)
  )
);
CREATE INDEX match_seats_life ON match_seats (life_id) WHERE life_id IS NOT NULL;

-- 運営用のチャット記録（6か月保存）
CREATE TABLE chat_messages (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  match_id   text NOT NULL REFERENCES matches (id),
  seat       smallint NOT NULL,
  account_id text REFERENCES accounts (id),
  text       text NOT NULL,       -- 伏せ字の後（表示用）
  original   text,                -- 伏せ字の前（運営用）。伏せ字がなかったときは空
  created_at timestamptz NOT NULL
);
CREATE INDEX chat_messages_created_at ON chat_messages (created_at);
CREATE INDEX chat_messages_match ON chat_messages (match_id);
CREATE INDEX chat_messages_account ON chat_messages (account_id, created_at);

-- 保存期間を過ぎても消さない試合の印（通報の作業で使う）。hold_until が空なら期限なし
CREATE TABLE chat_holds (
  match_id   text NOT NULL REFERENCES matches (id),
  reason     text NOT NULL,
  hold_until timestamptz,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (match_id, reason)
);
