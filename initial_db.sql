-- Ad audit log table
create table if not exists public.ad_audits (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  telegram_user_id bigint not null,
  telegram_update_id bigint unique,
  media_type text not null check (media_type in ('url', 'screenshot')),
  media_url text,
  detected_brand text,
  inferred_demographics jsonb default '{}'::jsonb,
  inferred_interests text[] default '{}'::text[],
  targeting_type text,
  raw_ai_analysis jsonb,
  forwarded_from text
);

create index if not exists ad_audits_telegram_user_id_idx
  on public.ad_audits (telegram_user_id);

create index if not exists ad_audits_created_at_idx
  on public.ad_audits (created_at desc);

-- RLS: enabled with no policies for anon/authenticated by default.
-- The Edge Function writes with the service_role key, which always
-- bypasses RLS, so the bot itself is unaffected by this.
alter table public.ad_audits enable row level security;

-- Example policy for later, once you map telegram_user_id to a real
-- Supabase auth user (e.g. via a linked accounts table). Left commented
-- out since there's no auth flow yet.
--
-- create policy "users see own audits"
--   on public.ad_audits for select
--   using (telegram_user_id = (auth.jwt() ->> 'telegram_user_id')::bigint);

-- Private storage bucket for raw screenshots / rendered social posts
insert into storage.buckets (id, name, public)
values ('ad-screenshots', 'ad-screenshots', false)
on conflict (id) do nothing;

-- No storage.objects policies for anon/authenticated: only the
-- service_role (used by the Edge Function) can read/write this bucket.
-- (storage.objects has RLS enabled by default on all Supabase projects —
-- no need to alter it yourself, and you don't have owner privileges to.)