-- Function への連打も DB で数える（20261010200000_rate_limit.sql の続き。既存のマイグレーションは書き換えない）
--   Neon Function はリクエストごとにメモリが分かれるので、メモリの中では数えられない。
--   req: Function "game" へのリクエスト（ログイン済みの分。成功も失敗も数える）。1 分に 300 回
--        手番・時間切れの進行・チャットを合わせても 1 人で毎秒 1〜2 回なので、ふつうに遊ぶ分には届かない

alter table public.rate_limits drop constraint rate_limits_kind_check;
alter table public.rate_limits add constraint rate_limits_kind_check check (kind in ('code', 'create', 'req'));

create or replace function public.rate_rule(p_kind text, out max_n int, out win interval)
language sql immutable set search_path = '' as $$
  select case p_kind when 'code' then 10 when 'create' then 10 when 'req' then 300 end,
         case p_kind when 'req' then interval '1 minute' else interval '10 minutes' end
$$;
