-- 終局後の再戦（20261005000000_init.sql などは書き換えない）
--   rooms.rematch: { stay: [席]（席に残った順）, gone: [席]（Menu へ去った）, next: { id, code } | null（始まった再戦の部屋） }。
--   書き込みは Neon Function "game"（op stay / leave / rematch）だけ。ブラウザへは views の rematch で渡す
alter table public.rooms add column rematch jsonb;
