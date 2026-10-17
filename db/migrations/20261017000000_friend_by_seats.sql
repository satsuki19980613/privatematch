-- FRIEND MATCH：正式な開催の前に、これまでの結果を消す。スタッツを卓の人数ごとに見られるようにする。
--   friend_results: 開催前の試しの結果をすべて消す（このマイグレーションを当てた時点のもの。メンバーの確認 friend_members はそのまま）
--   friend_stats:   agg を「シーズン × 人 × 卓の人数（p）」で返し、games にも p を足す。ほかは 20261012000000_friend.sql のまま
--                   順位（平均順位・1 位率・順位の分布）は人数の違う卓どうしでは比べられないので、ブラウザが人数ごとに分けて出す。
--                   pt は人数によらず公平（src/structure.js の payoutsFor）なので、人数をまたいで足してよい

delete from public.friend_results;

create or replace function public.friend_stats(p_mode text, p_season text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid     uuid := public.current_uid();
  v_seasons jsonb;
  v_season  text;
begin
  if v_uid is null or not public.friend_ok(v_uid) then perform public.fail('not_friend'); end if;
  select coalesce(jsonb_agg(x.s order by x.s), '[]'::jsonb) into v_seasons
    from (select distinct public.friend_season(r.ended_at) as s from public.friend_results r where r.mode = p_mode) x;
  v_season := case when p_season is not null and v_seasons ? p_season then p_season else v_seasons ->> -1 end;
  return jsonb_build_object(
    'me', public.friend_key(v_uid), 'mode', p_mode, 'season', v_season, 'seasons', v_seasons,
    'members', coalesce((select jsonb_agg(jsonb_build_object('k', public.friend_key(p.uid), 'name', p.nickname) order by lower(p.nickname))
      from public.profiles p where exists (select 1 from public.friend_results r where r.uid = p.uid and r.mode = p_mode)), '[]'::jsonb),
    'agg', coalesce((select jsonb_agg(to_jsonb(a)) from (
      select public.friend_season(r.ended_at) as s, public.friend_key(r.uid) as k, r.players as p, count(*)::int as n, sum(r.pt)::float8 as pt,
             (count(*) filter (where r.pt > 0))::int as plus, (count(*) filter (where r.place = 1))::int as first, sum(r.place)::int as place,
             jsonb_build_array(count(*) filter (where r.place = 1), count(*) filter (where r.place = 2), count(*) filter (where r.place = 3),
                               count(*) filter (where r.place = 4), count(*) filter (where r.place = 5), count(*) filter (where r.place = 6)) as dist,
             sum(r.hands)::int as hands, sum(r.vpip)::int as vpip, sum(r.pfr)::int as pfr
      from public.friend_results r where r.mode = p_mode group by 1, 2, 3) a), '[]'::jsonb),
    'games', coalesce((select jsonb_agg(jsonb_build_object('k', public.friend_key(g.uid), 'at', floor(extract(epoch from g.ended_at) * 1000)::bigint,
                                                           'p', g.players, 'place', g.place, 'pt', g.pt::float8) order by g.ended_at, g.room, g.place)
      from (select r.* from public.friend_results r where r.mode = p_mode and public.friend_season(r.ended_at) = v_season
            order by r.ended_at desc limit 5000) g), '[]'::jsonb));
end $$;

revoke all on function public.friend_stats(text, text) from public, anonymous, authenticated;
grant execute on function public.friend_stats(text, text) to authenticated;
