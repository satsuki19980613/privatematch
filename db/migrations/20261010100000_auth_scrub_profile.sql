-- 認証で届く個人の情報をほかも DB に残さない（20261010000000_auth_scrub.sql の続き。既存のマイグレーションは書き換えない）
--   user:    name（Google の表示名）を 'Player' に、image（アイコン画像の URL）を空にする
--   session: "ipAddress" と "userAgent" を空にする
--   アプリはどれも使わない（表示名は profiles.nickname）。すでに入っている分も置き換える（元に戻せない）

create or replace function public.auth_user_scrub()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.email := new.id::text || '@privatematch.invalid';
  new.name := 'Player';
  new.image := null;
  return new;
end $$;

create function public.auth_session_scrub()
returns trigger language plpgsql set search_path = '' as $$
begin
  new."ipAddress" := null;
  new."userAgent" := null;
  return new;
end $$;

revoke all on function public.auth_session_scrub() from public, anonymous, authenticated;

create trigger auth_session_scrub before insert or update on neon_auth.session
  for each row execute function public.auth_session_scrub();

update neon_auth."user" set name = 'Player', image = null where name is distinct from 'Player' or image is not null;
update neon_auth.session set "ipAddress" = null, "userAgent" = null where "ipAddress" is not null or "userAgent" is not null;
