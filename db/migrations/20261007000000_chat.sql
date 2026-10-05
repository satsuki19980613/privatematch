-- 卓のチャット（PRIVATE MATCH だけ。20261005000000_init.sql・20261006000000_hardening.sql は書き換えない）
--   room_chat:  発言（部屋ごとの通し番号 seq）。書き込みは Neon Function "game"（op chat）だけ。部屋と一緒に消える（終局から 3 日）
--   rooms:      chat_seq（最新の seq。ゲームの ver とは独立。チャットで ver を上げると act が stale になるため）
--   room_poll:  返り値に chat（最新の seq）を足す。ほかは 20261005000000_init.sql のまま
--   room_chat:  RPC。p_after より後ろの発言（新しい方から最大 200 件を古い順）

alter table public.rooms add column chat_seq int not null default 0;

create table public.room_chat (
  room       uuid not null references public.rooms(id) on delete cascade,
  seq        int  not null,                       -- 部屋ごとの通し番号（1 から。rooms.chat_seq と同じ）
  seat       int  not null,                       -- 発言した席（0 から。開始後の席順）
  text       text not null,                       -- 正規化済み（src/chat.js の normalizeChat）
  created_at timestamptz not null default now(),
  primary key (room, seq)
);
alter table public.room_chat enable row level security;
revoke all on table public.room_chat from public, anonymous, authenticated;

create or replace function public.room_poll(p_room uuid, p_ver int)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := public.current_uid();
  r     record;
  pos   int;
begin
  select r0.members, r0.ver, r0.views, r0.started, r0.status, r0.chat_seq into r from public.rooms r0 where r0.id = p_room;
  if found and v_uid is not null then pos := array_position(r.members, v_uid); end if;
  if pos is null then perform public.fail('not_found'); end if;
  return jsonb_build_object('ver', r.ver, 'now', floor(extract(epoch from clock_timestamp()) * 1000)::bigint,
    'view', case when r.ver > coalesce(p_ver, -1)
                 then (case when r.started then r.views -> (pos - 1) else r.views -> 0 end) || jsonb_build_object('status', r.status, 'ver', r.ver) end,
    'chat', coalesce(r.chat_seq, 0));
end $$;

-- チャットの発言（p_after より後ろ。新しい方から最大 200 件を古い順に）。at は epoch ms。private でない部屋は []
create or replace function public.room_chat(p_room uuid, p_after int)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid  uuid := public.current_uid();
  v_kind text;
  pos    int;
begin
  select r.kind, array_position(r.members, v_uid) into v_kind, pos from public.rooms r where r.id = p_room;
  if pos is null then perform public.fail('not_found'); end if;
  if v_kind <> 'private' then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('seq', c.seq, 'seat', c.seat, 'text', c.text,
                                                       'at', floor(extract(epoch from c.created_at) * 1000)::bigint) order by c.seq)
    from (select * from public.room_chat where room = p_room and seq > coalesce(p_after, 0) order by seq desc limit 200) c), '[]'::jsonb);
end $$;

revoke all on function public.room_poll(uuid, int), public.room_chat(uuid, int) from public, anonymous, authenticated;
grant execute on function public.room_poll(uuid, int), public.room_chat(uuid, int) to authenticated;
