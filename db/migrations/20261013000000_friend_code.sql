-- FRIEND MATCH：番号での確認（Discord のアプリだけで済む確認）。
--   アプリが 6 桁の番号を出し、本人が専用の Discord サーバーの中で /link 番号 と打つと、Discord が Function "game" を呼ぶ。
--   Function は Discord の署名を確かめ、その番号を出した人を friend_members に入れる（server/game/discord.js・db.js）。
--   friend_codes: 出した番号。1 人 1 つ・10 分だけ使える・1 回使ったら消す。期限切れは次に誰かが番号を出すときに消す。
--                 読み書きするのは Function（データベースの所有者）だけで、ブラウザからは見えない。

create table public.friend_codes (
  code        text primary key check (code ~ '^[0-9]{6}$'),
  uid         uuid not null unique references neon_auth."user"(id) on delete cascade,
  expires_at  timestamptz not null
);

alter table public.friend_codes enable row level security;
revoke all on table public.friend_codes from public, anonymous, authenticated;
