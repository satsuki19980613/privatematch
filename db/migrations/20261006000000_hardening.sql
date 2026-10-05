-- QA で見つけた点の修正（20261005000000_init.sql は書き換えない）
--   set_nickname: 見えない文字・ゼロ幅・方向制御を含む名前を拒否する（なりすまし対策）。全角スペースと NBSP は半角スペースにそろえてから前後を削る
--   me:           recent を「始まってから 3 日」ではなく「終わってから 3 日」（サーバーが記録を消すまで）にする
--   room_peek:    host は作成者の名前（開始後は席がシャッフルされて names[1] が作成者とは限らない）

create or replace function public.set_nickname(p_name text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid  uuid := public.current_uid();
  v_name text := btrim(translate(coalesce(p_name, ''), U&'\00A0\3000', '  '));
begin
  if v_uid is null then perform public.fail('not_authenticated'); end if;
  if char_length(v_name) < 1 or char_length(v_name) > 16 or v_name ~ '[[:cntrl:]]'
     or v_name ~ U&'[\00AD\034F\061C\115F\1160\17B4\17B5\180B-\180F\2000-\200F\2028-\202F\205F-\206F\2800\3164\FEFF\FFA0\FFF9-\FFFC]' then
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
               from public.rooms r where r.started and r.members @> array[v_uid] and coalesce(r.ended_at, r.updated_at) > now() - interval '3 days'), '[]'::jsonb));
end $$;

create or replace function public.room_peek(p_code text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce((
    select jsonb_build_object('id', r.id, 'code', r.code, 'kind', r.kind, 'status',
             case when r.status = 'waiting' and r.created_at < now() - interval '15 minutes' then 'cancelled' else r.status end,
             'config', r.config, 'host', coalesce(r.names[array_position(r.members, r.host)], r.names[1]), 'seated', cardinality(r.members),
             'member', r.members @> array[public.current_uid()])
    from public.rooms r where r.code = p_code
    order by (r.status in ('waiting', 'running', 'paused')) desc, r.created_at desc limit 1), 'null'::jsonb);
$$;

revoke all on function public.me(), public.set_nickname(text), public.room_peek(text) from public, anonymous, authenticated;
grant execute on function public.me(), public.set_nickname(text), public.room_peek(text) to authenticated;
