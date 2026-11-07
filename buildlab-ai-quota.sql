-- BuildLab Egypt: one atomic daily message quota per authenticated Supabase user.
-- Run this once in Supabase Dashboard -> SQL Editor.
-- Requests to these RPCs must use the Supabase SECRET key from the backend only.

create table if not exists public.buildlab_ai_daily_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  usage_date date not null,
  request_count integer not null default 0 check (request_count >= 0),
  primary key (user_id, usage_date)
);

alter table public.buildlab_ai_daily_usage enable row level security;
revoke all on table public.buildlab_ai_daily_usage from anon, authenticated;
grant all on table public.buildlab_ai_daily_usage to service_role;

create or replace function public.consume_buildlab_ai_quota(
  p_user_id uuid,
  p_daily_limit integer default 10
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_count integer;
  v_limit integer := greatest(1, least(coalesce(p_daily_limit, 10), 50));
  v_reset timestamptz;
begin
  if p_user_id is null then
    raise exception 'user id required' using errcode = '22023';
  end if;

  insert into public.buildlab_ai_daily_usage (user_id, usage_date, request_count)
  values (p_user_id, v_today, 1)
  on conflict (user_id, usage_date)
  do update set request_count = public.buildlab_ai_daily_usage.request_count + 1
  where public.buildlab_ai_daily_usage.request_count < v_limit
  returning request_count into v_count;

  v_reset := ((v_today + 1)::timestamp at time zone 'Africa/Cairo');
  if v_count is null then
    select request_count into v_count
    from public.buildlab_ai_daily_usage
    where user_id = p_user_id and usage_date = v_today;
    return jsonb_build_object('allowed', false, 'used', coalesce(v_count, v_limit), 'remaining', 0, 'reset_at', v_reset);
  end if;

  return jsonb_build_object('allowed', true, 'used', v_count, 'remaining', greatest(0, v_limit - v_count), 'reset_at', v_reset);
end;
$$;

create or replace function public.refund_buildlab_ai_quota(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_count integer;
begin
  if p_user_id is null then
    raise exception 'user id required' using errcode = '22023';
  end if;

  update public.buildlab_ai_daily_usage
  set request_count = greatest(request_count - 1, 0)
  where user_id = p_user_id and usage_date = v_today
  returning request_count into v_count;

  return jsonb_build_object('refunded', found, 'used', coalesce(v_count, 0));
end;
$$;

revoke all on function public.consume_buildlab_ai_quota(uuid, integer) from public, anon, authenticated;
revoke all on function public.refund_buildlab_ai_quota(uuid) from public, anon, authenticated;
grant execute on function public.consume_buildlab_ai_quota(uuid, integer) to service_role;
grant execute on function public.refund_buildlab_ai_quota(uuid) to service_role;
