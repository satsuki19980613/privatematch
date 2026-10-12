-- FRIEND MATCH（専用の Discord サーバーのメンバーだけが遊べる部屋。既存のマイグレーションは書き換えない）
--   rooms.kind:      'friend' を足す（部屋番号・招待 URL で入る。チャットと演出 GIF は PRIVATE MATCH と同じ）
--   friend_members:  Discord で確認できた人。Discord の利用者 ID そのものは残さず、鍵付きハッシュ（discord_key）だけを持つ
--                    （同じ Discord アカウントを 2 人が使えないようにするため）。確認は 30 日で切れ、もう一度 Discord で確かめる
--   friend_results:  FRIEND MATCH の結果（1 試合 × 1 人）。スタッツとランキングの元で、部屋が消えても残る
--   書き込みはどちらも Neon Function "game" だけ（op discord_link と、FRIEND MATCH の終局）
--   rate_limits:     discord（Discord での確認。10 分に 10 回）
--   me:              返り値に friend（{ ok, until } | null）を足す。ほかは 20261006000000_hardening.sql のまま
--   room_chat:       FRIEND MATCH の発言も返す（FREE MATCH だけ []）。ほかは 20261007000000_chat.sql のまま
--   friend_stats:    RPC。ゲームモードごとの、メンバー全員の集計（シーズン = 日本時間の暦月）と、選んだシーズンの 1 試合ごとの結果

alter table public.rooms drop constraint rooms_kind_check;
alter table public.rooms add constraint rooms_kind_check check (kind in ('private', 'free', 'friend'));

create table public.friend_members (
  uid         uuid primary key references neon_auth."user"(id) on delete cascade,
  discord_key text not null unique,
  verified_at timestamptz not null default now()
);

create table public.friend_results (
  room     uuid not null,                                            -- 部屋は終局から 3 日で消えるので参照にしない
  uid      uuid not null references public.profiles(uid) on delete cascade,
  mode     text not null,                                            -- ゲームモード（config.mode）
  players  int  not null check (players between 2 and 6),
  place    int  not null check (place between 1 and 6),
  pt       numeric not null,
  hands    int  not null default 0,                                  -- 配られたハンド数
  vpip     int  not null default 0,                                  -- そのうち VPIP したハンド数
  pfr      int  not null default 0,                                  -- そのうち PFR したハンド数
  ended_at timestamptz not null default now(),
  primary key (room, uid)
);
create index friend_results_mode_idx on public.friend_results (mode, ended_at);
create index friend_results_uid_idx on public.friend_results (uid);

alter table public.friend_members enable row level security;
alter table public.friend_results enable row level security;
revoke all on table public.friend_members, public.friend_results from public, anonymous, authenticated;

alter table public.rate_limits drop constraint rate_limits_kind_check;
alter table public.rate_limits add constraint rate_limits_kind_check check (kind in ('code', 'create', 'req', 'discord'));

create or replace function public.rate_rule(p_kind text, out max_n int, out win interval)
language sql immutable set search_path = '' as $$
  select case p_kind when 'code' then 10 when 'create' then 10 when 'req' then 300 when 'discord' then 10 end,
         case p_kind when 'req' then interval '1 minute' else interval '10 minutes' end
$$;

-- Discord での確認が有効な期間
create function public.friend_ttl()
returns interval language sql immutable set search_path = '' as $$
  select interval '30 days'
$$;

-- その人が FRIEND MATCH に入れるか（確認が切れていない）
create function public.friend_ok(p_uid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.friend_members f where f.uid = p_uid and f.verified_at > now() - public.friend_ttl())
$$;

-- ほかのメンバーに見せる識別子（uid そのものは見せない）
create function public.friend_key(p_uid uuid)
returns text language sql immutable set search_path = '' as $$
  select substr(encode(sha256(convert_to(p_uid::text, 'UTF8')), 'hex'), 1, 12)
$$;

-- シーズン（日本時間の暦月。'2026-10'）
create function public.friend_season(p_at timestamptz)
returns text language sql stable set search_path = '' as $$
  select to_char(p_at at time zone 'Asia/Tokyo', 'YYYY-MM')
$$;

create or replace function public.me()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid  uuid := public.current_uid();
  v_p    public.profiles;
  v_room uuid;
  n      int := 0;
begin
  if v_uid is null or not exists (select 1 from neon_auth."user" u where u.id = v_uid) then
    perform public.fail('not_authenticated');
  end if;
  perform public.purge_rooms();
  select * into v_p from public.profiles where uid = v_uid;
  while not found loop
    n := n + 1;
    if n > 20 then perform public.fail('nickname_exhausted'); end if;
    insert into public.profiles (uid, nickname)
      values (v_uid, 'Player-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 4)))
      on conflict do nothing;
    select * into v_p from public.profiles where uid = v_uid;
  end loop;
  v_room := public.active_room(v_uid);
  return jsonb_build_object(
    'nickname', v_p.nickname,
    'room', (select jsonb_build_object('id', r.id, 'code', r.code, 'kind', r.kind, 'status', r.status, 'started', r.started)
             from public.rooms r where r.id = v_room),
    'recent', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'endedAt', floor(extract(epoch from coalesce(r.ended_at, r.updated_at)) * 1000)::bigint)
                         order by r.started_at desc)
               from public.rooms r where r.started and r.members @> array[v_uid] and coalesce(r.ended_at, r.updated_at) > now() - interval '3 days'), '[]'::jsonb),
    'friend', (select jsonb_build_object('ok', f.verified_at > now() - public.friend_ttl(),
                                         'until', floor(extract(epoch from f.verified_at + public.friend_ttl()) * 1000)::bigint)
               from public.friend_members f where f.uid = v_uid));
end $$;

create or replace function public.room_chat(p_room uuid, p_after int)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid  uuid := public.current_uid();
  v_kind text;
  pos    int;
begin
  select r.kind, array_position(r.members, v_uid) into v_kind, pos from public.rooms r where r.id = p_room;
  if pos is null then perform public.fail('not_found'); end if;
  if v_kind = 'free' then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('seq', c.seq, 'seat', c.seat, 'text', c.text,
                                                       'at', floor(extract(epoch from c.created_at) * 1000)::bigint) order by c.seq)
    from (select * from public.room_chat where room = p_room and seq > coalesce(p_after, 0) order by seq desc limit 200) c), '[]'::jsonb);
end $$;

-- FRIEND MATCH のスタッツとランキングの元（メンバーだけが読める）。
--   seasons: このモードの記録があるシーズン（古い順）。season: 選んだシーズン（無い・知らない値なら最新）
--   members: このモードで 1 試合以上打った人 [{ k, name }]。me は自分の k
--   agg:     シーズン × 人の集計 [{ s, k, n, pt, plus（pt > 0 の回数）, first, place（順位の合計）, dist（1〜6 位の回数）, hands, vpip, pfr }]
--   games:   選んだシーズンの 1 試合 × 1 人 [{ k, at, place, pt }]（古い順。新しい方から 5000 件まで）
create function public.friend_stats(p_mode text, p_season text)
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
      select public.friend_season(r.ended_at) as s, public.friend_key(r.uid) as k, count(*)::int as n, sum(r.pt)::float8 as pt,
             (count(*) filter (where r.pt > 0))::int as plus, (count(*) filter (where r.place = 1))::int as first, sum(r.place)::int as place,
             jsonb_build_array(count(*) filter (where r.place = 1), count(*) filter (where r.place = 2), count(*) filter (where r.place = 3),
                               count(*) filter (where r.place = 4), count(*) filter (where r.place = 5), count(*) filter (where r.place = 6)) as dist,
             sum(r.hands)::int as hands, sum(r.vpip)::int as vpip, sum(r.pfr)::int as pfr
      from public.friend_results r where r.mode = p_mode group by 1, 2) a), '[]'::jsonb),
    'games', coalesce((select jsonb_agg(jsonb_build_object('k', public.friend_key(g.uid), 'at', floor(extract(epoch from g.ended_at) * 1000)::bigint,
                                                           'place', g.place, 'pt', g.pt::float8) order by g.ended_at, g.room, g.place)
      from (select r.* from public.friend_results r where r.mode = p_mode and public.friend_season(r.ended_at) = v_season
            order by r.ended_at desc limit 5000) g), '[]'::jsonb));
end $$;

revoke all on function public.friend_ttl(), public.friend_ok(uuid), public.friend_key(uuid), public.friend_season(timestamptz),
  public.me(), public.room_chat(uuid, int), public.friend_stats(text, text)
  from public, anonymous, authenticated;
grant execute on function public.me(), public.room_chat(uuid, int), public.friend_stats(text, text) to authenticated;
