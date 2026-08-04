# Plan: Data-quality fixes — stop hallucinations, fix schema drift, push aggregation to SQL

## Goal

Fix three concrete problems in `adauditbot`:
1. **Hallucinated brands for X/Instagram links** — when `fetchOgMetadata` returns all-null (X blocks scraping), the model fabricates a brand without any signal. Two rows with the same URL got "BetterHelp" and "Duolingo" respectively.
2. **Schema drift in `inferred_demographics`** — keys differ every row (`age` vs `age_range`, `income` vs `income_level`, `occupation` as array vs scalar). Unqueryable.
3. **`targeting_type` free-text explosion** — 6 rows, 6 different strings with no collisions.

## Approach

- **Jina Reader API** (`https://r.jina.ai/`, POST with Bearer token) alongside OG metadata extraction — fetches full page markdown so the model analyzes real ad copy/text, not just meta tags. User confirms they'll add `JINA_API_KEY` as a Supabase secret. If the key is absent, Jina is skipped gracefully and we fall back to OG-only. Works on most ad landing pages (fails on X/Instagram).
- **Mistral JSON Schema mode** (`response_format: { type: "json_schema", ... }`) to enforce exact keys + enum values at the source.
- **Metadata-confidence gate** — when *both* OG metadata and Jina markdown are empty, instruct the model not to hallucinate.
- **Postgres CHECK constraint + enum type** for `targeting_category`.
- **Normalization in the Edge Function** for interests and demographics as a safety net.
- **New columns**: `targeting_category`, `metadata_confidence`.
- Keep `raw_ai_analysis` as the untouched audit trail; `targeting_type` + `inferred_demographics` become best-effort normalized columns.

## Files

| File | Action |
|------|--------|
| `supabase/migrations/20260804000000_ad_audits_data_quality.sql` | Create — new migration |
| `supabase/functions/adauditbot/index.ts` | Edit — multiple sections |

---

## Migration SQL

**File:** `supabase/migrations/20260804000000_ad_audits_data_quality.sql`

```sql
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
set targeting_category =
  case lower(trim(targeting_type))
    when 'interest-based' then 'interest'
    when 'interest_and_demographic_based' then 'interest'
    when 'interest' then 'interest'
    when 'demographic' then 'demographic'
    when 'geographic' then 'geographic'
    when 'geo-based and interest-based' then 'geographic'
    when 'geo-based' then 'geographic'
    when 'retargeting' then 'retargeting'
    when 'platform_retargeting' then 'platform_internal'
    when 'platform internal' then 'platform_internal'
    when 'lookalike' then 'lookalike'
    when 'broad interest + lookalike' then 'lookalike'
    when 'broad_undifferentiated' then 'broad_undifferentiated'
    when 'broad' then 'broad_undifferentiated'
    when 'professional' then 'professional'
    when 'professional/employment-based' then 'professional'
    else 'broad_undifferentiated'
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
```

---

## index.ts changes

All edits are in `supabase/functions/adauditbot/index.ts`.

### Edit 1 — Add JSON Schema + normalization helpers (after line 40, before `bot.command("start")`)

Insert the following code block between the `ANALYSIS_SCHEMA_PROMPT` and `bot.command("start")`:

```ts
// Strict JSON Schema for Mistral's json_schema response_format mode.
// This enforces exact keys and enum values at the source — the model
// cannot invent demographic keys or arbitrary targeting_type strings.
const ANALYSIS_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    brand: { type: ["string", "null"] },
    targeting_type: {
      anyOf: [
        { type: "string", enum: ["interest","demographic","geographic","retargeting","lookalike","professional","platform_internal","broad_undifferentiated"] },
        { type: "null" },
      ],
    },
    interests: { type: "array", items: { type: "string" } },
    demographics: {
      type: "object",
      properties: {
        age_bracket: { anyOf: [{ type: "string", enum: ["18-24","25-34","35-44","45-54","55-64","65+","unknown"] }, { type: "null" }] },
        gender: { anyOf: [{ type: "string", enum: ["all","male","female","non-binary","unknown"] }, { type: "null" }] },
        location: { anyOf: [{ type: "string", enum: ["US","UK","CA","AU","Uganda","India","EU","global","unknown"] }, { type: "null" }] },
        income_level: { anyOf: [{ type: "string", enum: ["low","low-to-middle","middle","upper-middle","high","unknown"] }, { type: "null" }] },
        occupation: { anyOf: [{ type: "array", items: { enum: ["professional","business owner","student","family","self-employed","IT","manager","unknown"] } }, { type: "null" }] },
      },
      additionalProperties: false,
    },
    likely_reason: { type: "string" },
  },
  required: ["brand", "targeting_type", "interests", "demographics", "likely_reason"],
  additionalProperties: false,
} as const;

// Safety-net normalizers (the strict JSON Schema should prevent drift,
// but these catch edge cases and normalize legacy data in raw_ai_analysis).
function normalizeInterests(interests: string[]): string[] {
  return Array.from(new Set(
    (interests ?? []).map(i => i.toLowerCase().replace(/_/g, " ").trim()).filter(Boolean)
  ));
}

// Map any free-text targeting string to the canonical enum.
// Unknown values default to "broad_undifferentiated".
function normalizeTargetingType(t: string | null | undefined): string | null {
  if (!t) return null;
  const m: Record<string, string> = {
    "interest-based": "interest",
    "interest_and_demographic_based": "interest",
    "interest": "interest",
    "demographic": "demographic",
    "geographic": "geographic",
    "geo-based and interest-based": "geographic",
    "geo-based": "geographic",
    "retargeting": "retargeting",
    "platform_retargeting": "platform_internal",
    "platform internal": "platform_internal",
    "lookalike": "lookalike",
    "broad interest + lookalike": "lookalike",
    "broad_undifferentiated": "broad_undifferentiated",
    "broad": "broad_undifferentiated",
    "professional": "professional",
    "professional/employment-based": "professional",
  };
  return m[t.toLowerCase().trim()] ?? "broad_undifferentiated";
}

// Normalize demographics: map legacy keys (age_range, income, etc.) to
// canonical keys. Buckets age if free-text age was produced.
function normalizeDemographics(d: Record<string, unknown>): Record<string, unknown> {
  const age = d.age ?? d.age_range ?? d.age_bracket ?? null;
  return {
    age_bracket: age ? bucketAge(age as string) : null,
    gender: d.gender ?? null,
    location: d.location ?? null,
    income_level: d.income_level ?? d.income ?? null,
    occupation: Array.isArray(d.occupation) ? d.occupation : d.occupation ? [d.occupation] : null,
  };
}

function bucketAge(age: string): string {
  const n = parseInt(age);
  if (isNaN(n)) return "unknown";
  if (n <= 24) return "18-24";
  if (n <= 34) return "25-34";
  if (n <= 44) return "35-44";
  if (n <= 54) return "45-54";
  if (n <= 64) return "55-64";
  return "65+";
}
```

### Edit 2 — `callMistral` (line 286)

**Replace:**
```ts
      response_format: { type: "json_object" },
```

**With:**
```ts
      response_format: {
        type: "json_schema",
        json_schema: {
          schema: ANALYSIS_RESPONSE_SCHEMA,
          name: "ad_analysis",
          strict: true,
        },
      },
```

### Edit 3 — `callMistral` fallback (lines 296–300)

**Replace:**
```ts
  } catch {
    return { brand: null, targeting_type: null, interests: [], demographics: {}, likely_reason: raw };
  }
```

**With:**
```ts
  } catch {
    return { brand: null, targeting_type: null, interests: [], demographics: {}, likely_reason: `Malformed response: ${raw}`.slice(0, 500) };
  }
```

### Edit 4 — Add `fetchJinaMarkdown` (before `fetchOgMetadata`, line 231)

Insert a new function that fetches full page content via Jina Reader API, in parallel with OG metadata. Uses the `JINA_API_KEY` Supabase secret (set via `supabase secrets set JINA_API_KEY=...`). Returns `null` if the key is absent or the page blocks scraping.

```ts
// Fetches full page content as markdown via Jina Reader API.
// Returns null if JINA_API_KEY is unset, the page blocks scraping (X/Instagram),
// or the request fails for any reason.
async function fetchJinaMarkdown(url: string): Promise<string | null> {
  const JINA_API_KEY = Deno.env.get("JINA_API_KEY");
  if (!JINA_API_KEY) return null;
  try {
    const res = await fetch("https://r.jina.ai/", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${JINA_API_KEY}`,
        "Content-Type": "application/json",
        "Accept": "text/markdown",
      },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch (err) {
    console.error("fetchJinaMarkdown failed:", err);
    return null;
  }
}

```

### Edit 5 — `handleUrl` (lines 201–224)

**Replace the entire function with:**
```ts
async function handleUrl(text: string, chatId: number, updateId: number, ctx: any, forwardedFrom: string | null) {
  try {
    const url = extractUrl(text);
    if (!url) {
      await bot.api.sendMessage(chatId, "Send a link or a screenshot of an ad.");
      return;
    }

    // Fetch OG metadata and Jina markdown in parallel — Jina gives the
    // model real page text, not just meta tags.
    const [metadata, pageContent] = await Promise.all([
      fetchOgMetadata(url),
      fetchJinaMarkdown(url),
    ]);

    const hasOgMetadata = !!(metadata.title || metadata.description || metadata.image);
    const hasContent = hasOgMetadata || !!pageContent;
    const confidence: "full" | "none" = hasContent ? "full" : "none";

    const analysis = await analyzeText(url, metadata, pageContent, hasContent);

    await saveAndReply({
      chatId,
      updateId,
      mediaType: "url",
      mediaUrl: url,
      analysis,
      metadataConfidence: confidence,
      forwardedFrom,
    });
  } catch (err) {
    console.error("handleUrl error:", err);
    await bot.api.sendMessage(chatId, "Sorry, something went wrong processing that link.");
  }
}
```

### Edit 6 — `analyzeText` (lines 264–271)

**Replace:**
```ts
async function analyzeText(url: string, metadata: Record<string, unknown>) {
  return callMistral([
    {
      type: "text",
      text: `Analyze this ad landing page.\nURL: ${url}\nMetadata: ${JSON.stringify(metadata)}`,
    },
  ]);
}
```

**With:**
```ts
async function analyzeText(
  url: string,
  metadata: Record<string, unknown>,
  pageContent: string | null,
  contentAvailable: boolean,
) {
  const content = contentAvailable
    ? `Analyze this ad landing page.\nURL: ${url}\nOG Metadata: ${JSON.stringify(metadata)}\n` +
      (pageContent ? `Page Content (markdown):\n${pageContent}` : "")
    : `No metadata or page content could be retrieved from this URL. ` +
      `Do NOT hallucinate a brand or targeting type. Return null for brand and targeting_type, ` +
      `empty array for interests, and in likely_reason, state that no content could be retrieved ` +
      `and the inference is unreliable.`;
  return callMistral([
    { type: "text", text: content },
  ]);
}
```

### Edit 7 — `handleScreenshot` (lines 174–199)

Add `metadataConfidence: "full"` to the `saveAndReply` call.

**Replace:**
```ts
    await saveAndReply({
      chatId,
      updateId,
      mediaType: "screenshot",
      mediaUrl: storagePath,
      analysis,
      forwardedFrom,
    });
```

**With:**
```ts
    await saveAndReply({
      chatId,
      updateId,
      mediaType: "screenshot",
      mediaUrl: storagePath,
      analysis,
      metadataConfidence: "full",
      forwardedFrom,
    });
```

### Edit 8 — `saveAndReply` signature + insert (lines 303–329)

**Replace the entire `saveAndReply` function with:**
```ts
async function saveAndReply({
  chatId,
  updateId,
  mediaType,
  mediaUrl,
  analysis,
  metadataConfidence,
  forwardedFrom,
}: {
  chatId: number;
  updateId: number;
  mediaType: string;
  mediaUrl: string;
  analysis: any;
  metadataConfidence: "full" | "partial" | "none";
  forwardedFrom: string | null;
}) {
  const normalizedInterests = normalizeInterests(analysis.interests ?? []);
  const targetingCategory = normalizeTargetingType(analysis.targeting_type);
  const normalizedDemographics = normalizeDemographics(analysis.demographics ?? {});

  const { error } = await supabase.from("ad_audits").insert({
    telegram_user_id: chatId,
    telegram_update_id: updateId,
    media_type: mediaType,
    media_url: mediaUrl,
    detected_brand: analysis.brand,
    inferred_demographics: normalizedDemographics,
    inferred_interests: normalizedInterests,
    targeting_type: analysis.targeting_type,
    targeting_category: targetingCategory,
    metadata_confidence: metadataConfidence,
    raw_ai_analysis: analysis,
    forwarded_from: forwardedFrom,
  });

  if (error && error.code !== "23505") {
    console.error("DB insert error:", error);
  }

  const confidenceNote = metadataConfidence === "none"
    ? "\n\n⚠️ No metadata was retrievable from this URL. Brand/interests may be unreliable."
    : "";

  const text =
    `*Ad Breakdown*\n\n` +
    `*Brand:* ${escapeMarkdownV2(analysis.brand ?? "Unknown")}\n` +
    `*Targeting type:* ${escapeMarkdownV2(analysis.targeting_type ?? "N/A")}\n` +
    `*Interests:* ${escapeMarkdownV2((analysis.interests ?? []).join(", ") || "None detected")}\n` +
    `*Demographics:* ${escapeMarkdownV2(JSON.stringify(analysis.demographics ?? {}))}\n` +
    `*Metadata confidence:* ${escapeMarkdownV2(metadataConfidence)}\n\n` +
    `*Why you're likely seeing this:*\n` +
    `${escapeMarkdownV2(analysis.likely_reason ?? "Not enough signal to infer a specific reason.")}` +
    confidenceNote;

  try {
    await bot.api.sendMessage(chatId, text, { parse_mode: "MarkdownV2" });
  } catch (err) {
    console.error("sendMessage formatting error, falling back to plain text:", err);
    await bot.api.sendMessage(chatId, text.replace(/[*_[\]()~`>#+\-=|{}.!\\]/g, ""));
  }
}
```

### Edit 9 — `/summary` command (lines 85–118)

**Replace the entire `/summary` handler with:**
```ts
bot.command("summary", async (ctx) => {
  const chatId = ctx.chat.id;

  const { data, error } = await supabase
    .from("user_ad_profile")
    .select("*")
    .eq("telegram_user_id", chatId)
    .maybeSingle();

  if (error) {
    console.error("summary query error:", error);
    await ctx.reply("Couldn't build your summary right now.");
    return;
  }
  if (!data) {
    await ctx.reply("No ads analyzed yet — forward me a screenshot or link to get started.");
    return;
  }

  const topInterests = data.top_interests
    ? Object.entries(data.top_interests)
        .sort((a: [string, number], b: [string, number]) => b[1] - a[1])
        .slice(0, 6)
        .map(([item]) => item as string)
    : [];

  const summaryText =
    `📊 Your ad profile (${data.total_ads} ad${data.total_ads === 1 ? "" : "s"} tracked)\n\n` +
    `Top brands: ${escapeMarkdownV2(data.top_brand ?? "none detected")}\n` +
    `Most common targeting: ${data.top_targeting_category ?? "n/a"}\n` +
    (data.no_metadata_count > 0
      ? `⚠️ ${data.no_metadata_count} ad(s) had no retrievable metadata (URL-only, no screenshot).\n`
      : "") +
    `Recurring interest themes: ${topInterests.join(", ") || "none detected"}\n\n` +
    `Note: this reflects what the model inferred from ad creative/metadata, not the advertiser's actual targeting settings.`;

  await ctx.reply(summaryText);
});
```

This replaces the JS-side `topN`/`countBy` aggregation with the SQL view. The `countBy` and `topN` helper functions (lines 120–135) can be removed since they're no longer used.

### Edit 10 — Remove dead code (lines 120–135)

Delete the `countBy` and `topN` functions — no longer referenced after Edit 9.

---

## Environment setup

- Set `JINA_API_KEY` as a Supabase Edge Function secret (user confirms they'll add it):
  ```bash
  supabase secrets set JINA_API_KEY=<your-jina-api-key>
  ```
- `JINA_API_KEY` is **optional** — if unset, `fetchJinaMarkdown` returns `null` and the bot falls back to OG-only metadata. No error is thrown at startup.

## Validation

1. **Supabase local dev:**
   ```bash
   supabase start
   supabase db push
   ```
   — Migration applies cleanly, enum type + CHECK constraints valid.

2. **Edge Function type check:**
   ```bash
   deno check supabase/functions/adauditbot/index.ts
   ```
   — No type errors from the schema object or function signatures.

3. **Mistral API call** (manual/curl):
   - Send `{"type": "json_schema", "json_schema": { "schema": {...} }}` — verify the API returns 200 and the model output matches the schema exactly (no extra keys, valid enums).

4. **Jina Reader API test:**
   - `curl "https://r.jina.ai/" -H "Authorization: Bearer $JINA_API_KEY" -H "Content-Type: application/json" -d '{"url":"https://example-ad-landing-page.com"}'` — verify markdown is returned.
   - Forward a non-X URL (e.g. a BetterHelp landing page) to the bot.
   - Verify the reply contains real page content analysis (not just OG metadata).
   - Verify the DB row has `metadata_confidence = 'full'`.

5. **Metadata-confidence gate test:**
   - Forward an X.com URL to the bot.
   - Verify the reply shows `Metadata confidence: none` and `Brand: Unknown`.
   - Verify the DB row has `metadata_confidence = 'none'` and `targeting_category` is null or `broad_undifferentiated`.

6. **Schema drift test:**
   - Forward a screenshot of a financial ad.
   - Verify `inferred_demographics` in the DB has exactly the 5 canonical keys (`age_bracket`, `gender`, `location`, `income_level`, `occupation`) — no extras.

7. **`/summary` test:**
   - Forward 3–4 URLs/screenshots, then run `/summary`.
   - Verify output comes from the `user_ad_profile` view (single SQL query, no JS aggregation).
   - Verify `no_metadata_count` is shown when any URL had no metadata.

8. **Existing data backfill verification:**
   - Check that existing rows have `targeting_category` populated via the `case` statement.
   - Check that existing `inferred_interests` are normalized (lowercase, spaces, deduped).
   - Check that existing screenshots have `metadata_confidence = 'full'`, URL rows with all-null demographics have `'none'`, and remaining URL rows have `'partial'`.

## Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| Jina API rate-limited (free tier: ~60 req/min) | `fetchJinaMarkdown` returns `null` on failure — OG metadata still provides fallback signal. |
| Jina reader returns noisy content (nav bars, comments) | Mistral is good at ignoring boilerplate; if results degrade, add a `return_format` param to Jina for cleaner extraction. |
| JSON Schema too restrictive → model returns error | `strict: true` makes Mistral validate before returning; fallback at line 296 catches malformed output. The `confidence = "none"` prompt also handles this (model returns nulls, which is valid). |
| `r.jina.ai` free proxy vs API | Using official API with Bearer token (user has `JINA_API_KEY`). If key is unset, function gracefully skips. |
