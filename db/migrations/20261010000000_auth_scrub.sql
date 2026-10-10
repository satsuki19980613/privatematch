-- 認証のメールアドレスを DB に残さない（運営者にも Neon の管理画面で見えないようにする。既存のマイグレーションは書き換えない）
--   Neon Auth は Google でログインした人を neon_auth."user"（email）と neon_auth.account（Google のトークン）に書く。
--   アプリはどちらも使わない（表示名は profiles.nickname。2 回目からのログインは account の "accountId" で本人を見つける）。
--   user.email: 書き込みのたびに <id>@privatematch.invalid に置き換える（一意のまま・実在しない宛先）
--   account:    "idToken"（中にメールアドレスが入っている）と "accessToken" / "refreshToken"（Google に聞けばメールアドレスが分かる）を空にする
--   すでに入っている分も置き換える（元に戻せない）

create function public.auth_user_scrub()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.email := new.id::text || '@privatematch.invalid';
  return new;
end $$;

create function public.auth_account_scrub()
returns trigger language plpgsql set search_path = '' as $$
begin
  new."idToken" := null;
  new."accessToken" := null;
  new."refreshToken" := null;
  return new;
end $$;

revoke all on function public.auth_user_scrub(), public.auth_account_scrub() from public, anonymous, authenticated;

create trigger auth_user_scrub before insert or update on neon_auth."user"
  for each row execute function public.auth_user_scrub();
create trigger auth_account_scrub before insert or update on neon_auth.account
  for each row execute function public.auth_account_scrub();

update neon_auth."user" set email = id::text || '@privatematch.invalid';
update neon_auth.account set "idToken" = null, "accessToken" = null, "refreshToken" = null
  where "idToken" is not null or "accessToken" is not null or "refreshToken" is not null;
