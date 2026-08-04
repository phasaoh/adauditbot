-- Add enum type for targeting category (clean, queryable values)
create type targeting_category as enum (
  'interest',
  'demographic',
  'geographic',
  'retargeting',
  'lookalike',
  'professional',
  'platform_internal',
  'broad_undifferentiated'
);

-- Add metadata_confidence column (full / partial / none)
alter table public.ad_audits
  add column if not exists metadata_confidence text
    check (metadata_confidence in ('full', 'partial', 'none'));

-- Add targeting_category column (clean enum for aggregation)
alter table public.ad_audits
  add column if not exists targeting_category targeting_category;

-- Backfill targeting_category from existing free-text targeting_type.
-- This is a best-effort heuristic; raw_ai_analysis is the source of truth
-- for re-processing later if needed.
update public.ad_audits
set targeting_category = case lower(trim(targeting_type))
    when 'interest-based' then 'interest'::targeting_category
    when 'interest_and_demographic_based' then 'interest'::targeting_category
    when 'interest' then 'interest'::targeting_category
    when 'demographic' then 'demographic'::targeting_category
    when 'geographic' then 'geographic'::targeting_category
    when 'geo-based and interest-based' then 'geographic'::targeting_category
    when 'geo-based' then 'geographic'::targeting_category
    when 'retargeting' then 'retargeting'::targeting_category
    when 'platform_retargeting' then 'platform_internal'::targeting_category
    when 'platform internal' then 'platform_internal'::targeting_category
    when 'lookalike' then 'lookalike'::targeting_category
    when 'broad interest + lookalike' then 'lookalike'::targeting_category
    when 'broad_undifferentiated' then 'broad_undifferentiated'::targeting_category
    when 'broad' then 'broad_undifferentiated'::targeting_category
    when 'professional' then 'professional'::targeting_category
    when 'professional/employment-based' then 'professional'::targeting_category
    else 'broad_undifferentiated'::targeting_category
  end
where targeting_type is not null;

-- Backfill metadata_confidence for existing rows.
-- Screenshots always had full visual data.
update public.ad_audits
set metadata_confidence = 'full'
where media_type = 'screenshot';

-- For URL rows: if demographics are entirely null, the metadata scrape
-- likely failed and the model was flying blind (hallucination risk).
update public.ad_audits
set metadata_confidence = 'none'
where media_type = 'url'
  and (inferred_demographics ->> 'age') is null
  and (inferred_demographics ->> 'age_range') is null
  and (inferred_demographics ->> 'age_bracket') is null
  and (inferred_demographics ->> 'location') is null;

-- Remaining URL rows: assume partial (some metadata was retrieved).
update public.ad_audits
set metadata_confidence = 'partial'
where media_type = 'url' and metadata_confidence is null;

-- Normalize interests (lowercase, underscores→spaces, dedupe) on existing data
update public.ad_audits
set inferred_interests = sq.normalized
from (
  select
    id,
    array_agg(distinct lower(regexp_replace(i, '_', ' ', 'g')))
      filter (where lower(trim(i)) <> '')
    as normalized
  from ad_audits a,
       lateral unnest(inferred_interests) as i
  where array_length(inferred_interests, 1) > 0
  group by id
) sq
where ad_audits.id = sq.id;

-- Summary view: aggregation happens in SQL, /summary just selects from it
create or replace view public.user_ad_profile as
select
  telegram_user_id,
  count(*) as total_ads,
  count(*) filter (where metadata_confidence = 'none') as no_metadata_count,
  mode() within group (order by detected_brand nulls last) as top_brand,
  mode() within group (order by targeting_category nulls last) as top_targeting_category,
  (
    select json_object_agg(interest, cnt)
    from (
      select i as interest, count(*) as cnt
      from ad_audits a2,
           lateral unnest(a2.inferred_interests) as i
      where a2.telegram_user_id = a1.telegram_user_id
      group by i
      order by count(*) desc
      limit 6
    ) sub
  ) as top_interests
from public.ad_audits a1
group by telegram_user_id;

-- Index to keep the view fast
create index if not exists ad_audits_targeting_category_idx
  on public.ad_audits (telegram_user_id, targeting_category);
