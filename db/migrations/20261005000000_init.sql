-- PrivateMatch: profiles（ニックネーム）、rooms（部屋＝待機室とゲームの状態）、room_hands（終わったハンドの記録。端末へ渡すまでの一時置き場）。
-- ブラウザは表に直接触らない。最後に authenticated へ公開する RPC 関数だけを呼ぶ。
-- 部屋の作成・参加・アクションは Neon Function "game"（データベースの所有者で接続）が行う。
-- 成績とハンド履歴の正本は各自の端末（IndexedDB）。サーバーの記録は終局から 3 日で消える。

-- 呼び出した人の uid：Data API が request.jwt.claims に入れる Neon Auth の JWT の sub
create or replace function public.current_uid()
returns uuid language sql stable set search_path = '' as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid
$$;

create or replace function public.fail(p_code text)
returns void language plpgsql immutable set search_path = '' as $$
begin
  raise exception using errcode = 'P0001', message = p_code;
end $$;

create table public.profiles (
  uid        uuid primary key references neon_auth."user"(id) on delete cascade,
  nickname   text not null check (char_length(nickname) between 1 and 16),
  created_at timestamptz not null default now()
);
create unique index profiles_nickname_key on public.profiles (lower(nickname));

create table public.rooms (
  id         uuid primary key,
  code       text not null check (code ~ '^[0-9]{6}$'),             -- 部屋番号（招待 URL にも使う）
  kind       text not null check (kind in ('private', 'free')),     -- private: 部屋番号・招待 URL でだけ入れる / free: 一覧に出る
  host       uuid not null references public.profiles(uid) on delete cascade,
  config     jsonb not null,                                        -- { players, startBb, speed, levelMin, mode }
  status     text not null default 'waiting' check (status in ('waiting', 'running', 'paused', 'finished', 'cancelled')),
  started    boolean not null default false,
  members    uuid[] not null,                                       -- 待機中は参加順（先頭が作成者）、開始後は席順
  names      text[] not null,                                       -- members と同じ並びの表示名
  state      jsonb,                                                 -- エンジンの状態（山札を含む。ブラウザには返さない）
  ver        int  not null default 0,                               -- 変わるたびに +1
  views      jsonb not null,                                        -- 開始前は [待機室], 開始後は [席 0 のビュー, 席 1, …]
  due_ms     bigint,                                                -- 次に何かが起きる時刻（時間切れ・次のハンド・一時停止の期限）
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  ended_at   timestamptz
);
-- 部屋番号は「生きている部屋」の中で一意（終わった部屋の番号は再利用できる）
create unique index rooms_code_live on public.rooms (code) where status in ('waiting', 'running', 'paused');
create index rooms_members_idx on public.rooms using gin (members);
create index rooms_free_idx on public.rooms (created_at) where kind = 'free' and status = 'waiting';
create index rooms_updated_idx on public.rooms (updated_at);

create table public.room_hands (
  room    uuid not null references public.rooms(id) on delete cascade,
  hand_no int  not null,
  rec     jsonb not null,     -- 公開してよい記録（ショーダウンで公開された手札だけを含む）
  holes   jsonb not null,     -- 全員の手札（席順）。RPC は本人の分だけを返す
  primary key (room, hand_no)
);

alter table public.profiles   enable row level security;
alter table public.rooms      enable row level security;
alter table public.room_hands enable row level security;
revoke all on table public.profiles, public.rooms, public.room_hands from public, anonymous, authenticated;

-- 後片付け（スケジューラが無いので、アプリが使われたときに走らせる）
--   募集の期限（15 分）を過ぎた待機中の部屋 → 中止
--   一時停止が 10 分続いた部屋・2 日間動いていない進行中の部屋 → 中止
--   終わってから 3 日たった部屋 → 削除（ハンドの記録ごと）
create or replace function public.purge_rooms()
returns void language sql volatile security definer set search_path = '' as $$
  update public.rooms set status = 'cancelled', ended_at = now(), ver = ver + 1, updated_at = now()
    where (status = 'waiting' and created_at < now() - interval '15 minutes')
       or (status = 'paused' and updated_at < now() - interval '10 minutes')
       or (status = 'running' and updated_at < now() - interval '2 days');
  delete from public.rooms where status in ('finished', 'cancelled') and ended_at < now() - interval '3 days';
$$;

-- その人がいま居る部屋（待機中・進行中で、まだ脱落も退出もしていない）
create or replace function public.active_room(p_uid uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select r.id from public.rooms r
  where r.status in ('waiting', 'running', 'paused') and r.members @> array[p_uid]
    and (not r.started or (r.state -> 'players' -> (array_position(r.members, p_uid) - 1) ->> 'status') not in ('out', 'left'))
  order by r.created_at desc limit 1;
$$;

-- ログイン中の人のプロフィール（初回はランダムなニックネームで作る）、居る部屋、最近終わった部屋（端末への記録の同期用）
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
               from public.rooms r where r.started and r.members @> array[v_uid] and r.started_at > now() - interval '3 days'), '[]'::jsonb));
end $$;

create or replace function public.set_nickname(p_name text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid  uuid := public.current_uid();
  v_name text := btrim(coalesce(p_name, ''));
begin
  if v_uid is null then perform public.fail('not_authenticated'); end if;
  if char_length(v_name) < 1 or char_length(v_name) > 16 or v_name ~ '[[:cntrl:]]' then
    perform public.fail('nickname_invalid');
  end if;
  begin
    update public.profiles set nickname = v_name where uid = v_uid;
  exception when unique_violation then
    perform public.fail('nickname_taken');
  end;
  if not found then perform public.fail('no_profile'); end if;
  return jsonb_build_object('nickname', v_name);
end $$;

-- 部屋の自分のビュー（p_ver より新しいときだけ中身を返す）。status は表の値で上書きする（後片付けで中止になった部屋のため）
create or replace function public.room_poll(p_room uuid, p_ver int)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := public.current_uid();
  r     record;
  pos   int;
begin
  select r0.members, r0.ver, r0.views, r0.started, r0.status into r from public.rooms r0 where r0.id = p_room;
  if found and v_uid is not null then pos := array_position(r.members, v_uid); end if;
  if pos is null then perform public.fail('not_found'); end if;
  return jsonb_build_object('ver', r.ver, 'now', floor(extract(epoch from clock_timestamp()) * 1000)::bigint,
    'view', case when r.ver > coalesce(p_ver, -1)
                 then (case when r.started then r.views -> (pos - 1) else r.views -> 0 end) || jsonb_build_object('status', r.status, 'ver', r.ver) end);
end $$;

-- 部屋番号から部屋の概要（招待 URL・番号入力で参加する前の確認）。生きている部屋を優先する
create or replace function public.room_peek(p_code text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce((
    select jsonb_build_object('id', r.id, 'code', r.code, 'kind', r.kind, 'status',
             case when r.status = 'waiting' and r.created_at < now() - interval '15 minutes' then 'cancelled' else r.status end,
             'config', r.config, 'host', r.names[1], 'seated', cardinality(r.members),
             'member', r.members @> array[public.current_uid()])
    from public.rooms r where r.code = p_code
    order by (r.status in ('waiting', 'running', 'paused')) desc, r.created_at desc limit 1), 'null'::jsonb);
$$;

-- FreeMatch の募集中の部屋（新しい順）
create or replace function public.free_rooms()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'code', r.code, 'host', r.names[1], 'seated', cardinality(r.members),
           'config', r.config, 'createdAt', floor(extract(epoch from r.created_at) * 1000)::bigint) order by r.created_at desc), '[]'::jsonb)
  from (select * from public.rooms where kind = 'free' and status = 'waiting' and created_at > now() - interval '15 minutes'
        order by created_at desc limit 100) r;
$$;

-- 終わったハンドの記録（p_after より後ろ、最大 200 件）。手札は自分の分だけを hole に入れる
create or replace function public.room_hands(p_room uuid, p_after int)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := public.current_uid();
  pos   int;
begin
  select array_position(r.members, v_uid) into pos from public.rooms r where r.id = p_room and r.started;
  if pos is null then perform public.fail('not_found'); end if;
  return coalesce((select jsonb_agg(h.rec || jsonb_build_object('hole', h.holes -> (pos - 1)) order by h.hand_no)
    from (select * from public.room_hands where room = p_room and hand_no > coalesce(p_after, 0) order by hand_no limit 200) h), '[]'::jsonb);
end $$;

revoke all on function public.current_uid(), public.fail(text), public.purge_rooms(), public.active_room(uuid),
  public.me(), public.set_nickname(text), public.room_poll(uuid, int), public.room_peek(text), public.free_rooms(),
  public.room_hands(uuid, int)
  from public, anonymous, authenticated;
grant execute on function public.me(), public.set_nickname(text), public.room_poll(uuid, int), public.room_peek(text),
  public.free_rooms(), public.room_hands(uuid, int) to authenticated;
