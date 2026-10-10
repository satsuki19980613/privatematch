-- 回数の制限（部屋番号の総当たりと、部屋の作りすぎへの対策。既存のマイグレーションは書き換えない）
--   rate_limits: 利用者 × 種類ごとの窓（始まりの時刻 since と回数 n）。上限と窓の長さは rate_rule
--     code:   部屋番号の「はずれ」（room_peek が null・Function の join が not_found）。10 分に 10 回。
--             上限に達すると、窓が明けるまで room_peek も join も too_many（当たりの番号でも通さない）
--     create: 部屋の作成（Function の create が成功した分）。10 分に 10 回
--   room_peek:  はずれを数える（書き込むので volatile）。返す中身は 20261006000000_hardening.sql のまま。
--               JWT の sub が無い・neon_auth に居ない人は not_authenticated

create table public.rate_limits (
  uid   uuid not null references neon_auth."user"(id) on delete cascade,
  kind  text not null check (kind in ('code', 'create')),
  since timestamptz not null,
  n     int  not null,
  primary key (uid, kind)
);
alter table public.rate_limits enable row level security;
revoke all on table public.rate_limits from public, anonymous, authenticated;

create function public.rate_rule(p_kind text, out max_n int, out win interval)
language sql immutable set search_path = '' as $$
  select case p_kind when 'code' then 10 when 'create' then 10 end, interval '10 minutes'
$$;

-- いま止められているか（数えない）
create function public.rate_blocked(p_uid uuid, p_kind text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.rate_limits l, public.rate_rule(p_kind) r
                 where l.uid = p_uid and l.kind = p_kind and l.since > now() - r.win and l.n >= r.max_n)
$$;

-- 1 回数える（窓が明けていれば 1 から）。=> 上限の内なら true
create function public.rate_hit(p_uid uuid, p_kind text)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare
  r   record;
  v_n int;
begin
  select * into r from public.rate_rule(p_kind);
  insert into public.rate_limits as l (uid, kind, since, n) values (p_uid, p_kind, now(), 1)
  on conflict (uid, kind) do update
    set since = case when l.since > now() - r.win then l.since else now() end,
        n     = case when l.since > now() - r.win then l.n + 1 else 1 end
  returning l.n into v_n;
  return v_n <= r.max_n;
end $$;

create or replace function public.room_peek(p_code text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := public.current_uid();
  v     jsonb;
begin
  if v_uid is null or not exists (select 1 from neon_auth."user" u where u.id = v_uid) then
    perform public.fail('not_authenticated');
  end if;
  if public.rate_blocked(v_uid, 'code') then perform public.fail('too_many'); end if;
  select jsonb_build_object('id', r.id, 'code', r.code, 'kind', r.kind, 'status',
           case when r.status = 'waiting' and r.created_at < now() - interval '15 minutes' then 'cancelled' else r.status end,
           'config', r.config, 'host', coalesce(r.names[array_position(r.members, r.host)], r.names[1]), 'seated', cardinality(r.members),
           'member', r.members @> array[v_uid])
    into v
    from public.rooms r where r.code = p_code
    order by (r.status in ('waiting', 'running', 'paused')) desc, r.created_at desc limit 1;
  if v is null then
    perform public.rate_hit(v_uid, 'code');
    return 'null'::jsonb;
  end if;
  return v;
end $$;

revoke all on function public.rate_rule(text), public.rate_blocked(uuid, text), public.rate_hit(uuid, text), public.room_peek(text)
  from public, anonymous, authenticated;
grant execute on function public.room_peek(text) to authenticated;
