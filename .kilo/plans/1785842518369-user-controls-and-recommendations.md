# Plan: User controls, transparency, and actionable recommendations

## Goal

Add user-facing controls and contextual guidance to turn the bot from a passive explainer into an actionable transparency tool.

## Features

### 1. `/about` — transparency statement
A command that explains what the bot does, what it stores, and what it cannot do. Essential for trust and onboarding.

### 2. `/clear` — delete all user data
Delete all `ad_audits` rows for the calling user. Gives users basic GDPR-style control.

### 3. `/delete <#>` — remove single entry
Delete one entry by its position in `/history` (1-indexed). Lets users remove a misclassified or sensitive ad without nuking their whole history.

### 4. Platform-aware opt-out instructions
After every ad breakdown, append platform-specific steps to reduce similar ads. Detect platform from URL domain or from `forwarded_from` context. Turns "explanation" into "action" — the biggest gap in the current bot.

### 5. `/feedback <#> <up|down>` — rate analysis accuracy
Let users mark individual entries as accurate or inaccurate. Stores feedback in a new `ad_feedback` table so we can measure hallucination rate over time.

## Approach

- **No new dependencies** — everything uses existing Supabase client and Telegram API.
- **Opt-out instructions** are a static lookup by platform domain, appended as a post-analysis tip. No external API calls.
- **Feedback table** is minimal: `id`, `telegram_user_id`, `ad_audit_id`, `rating` (enum: `up`, `down`), `created_at`.
- **Data deletion** uses Supabase `delete().eq()` — no cascade concerns since `ad_feedback` references `ad_audits` via FK with `ON DELETE CASCADE`.
- **`/delete <#>`** translates the 1-indexed history position back to a UUID via a subquery — avoids relying on auto-increment IDs.

## Files

| File | Action |
|------|--------|
| `supabase/migrations/20260807000000_user_controls_and_feedback.sql` | Create — new migration |
| `supabase/functions/adauditbot/index.ts` | Edit — add commands, helper, opt-out block |

---

## Migration SQL

```sql
-- Feedback table for /feedback command
create table if not exists public.ad_feedback (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  telegram_user_id bigint not null,
  ad_audit_id uuid not null references public.ad_audits(id) on delete cascade,
  rating text not null check (rating in ('up', 'down'))
);

create index if not exists ad_feedback_telegram_user_id_idx
  on public.ad_feedback (telegram_user_id);

create index if not exists ad_feedback_ad_audit_id_idx
  on public.ad_feedback (ad_audit_id);

alter table public.ad_feedback enable row level security;
```

---

## index.ts changes

### Edit 1 — Platform opt-out lookup (after `bucketAge`, before `formatDemographics`)

Insert a helper that maps URL domains to platform names and opt-out instructions:

```ts
const PLATFORM_OPT_OUT: Record<string, { name: string; steps: string }> = {
  "facebook.com": {
    name: "Facebook",
    steps: "Settings & privacy → Ads → Ad preferences → remove interest",
  },
  "instagram.com": {
    name: "Instagram",
    steps: "Settings → Ads → Ad topics → adjust interests",
  },
  "tiktok.com": {
    name: "TikTok",
    steps: "Settings & privacy → Ads → 'Based on your interactions' → adjust",
  },
  "x.com": {
    name: "X/Twitter",
    steps: "Settings & privacy → Privacy and safety → Ads preferences → turn off",
  },
  "twitter.com": {
    name: "X/Twitter",
    steps: "Settings & privacy → Privacy and safety → Ads preferences → turn off",
  },
  "linkedin.com": {
    name: "LinkedIn",
    steps: "Settings → Data privacy → Ad preferences → manage",
  },
  "youtube.com": {
    name: "YouTube",
    steps: "Settings → Privacy → Ad settings → turn off Ad personalization",
  },
  "google.com": {
    name: "Google",
    steps: "myadcenter.google.com → turn off ad personalization",
  },
};

function detectPlatform(url: string): { name: string; steps: string } | null {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    // Check domain and parent domains
    for (const [domain, info] of Object.entries(PLATFORM_OPT_OUT)) {
      if (host === domain || host.endsWith("." + domain)) {
        return info;
      }
    }
  } catch {
    // ignore invalid URLs
  }
  return null;
}

function getOptOutTip(url: string | null, forwardedFrom: string | null): string {
  const platform = url ? detectPlatform(url) : null;
  if (!platform) return "";

  const lines = [
    "",
    `🔧 To reduce similar ${platform.name} ads:`,
    `• ${platform.steps}`,
    `• Or hide this ad: long-press → Hide ad`,
  ];
  return lines.join("\n");
}
```

### Edit 2 — Append opt-out tip in `saveAndReply`

In the `saveAndReply` function, append the tip to the final text before sending:

```ts
const optOutTip = getOptOutTip(mediaUrl, forwardedFrom);
const text =
  `🔍 *Ad Breakdown*\n\n` +
  `🏷️ *Brand:* ${escapeMarkdownV2(analysis.brand ?? "Unknown")}\n` +
  `🎯 *Targeting type:* ${escapeMarkdownV2(analysis.targeting_type ?? "N/A")}\n` +
  `🧲 *Interests:* ${escapeMarkdownV2((analysis.interests ?? []).join(", ") || "None detected")}\n` +
  `👥 *Demographics:* ${escapeMarkdownV2(formatDemographics(analysis.demographics ?? {}))}\n` +
  `⚡ *Metadata confidence:* ${escapeMarkdownV2(metadataConfidence)}\n\n` +
  `💡 *Why you're likely seeing this:*\n` +
  `${escapeMarkdownV2(analysis.likely_reason ?? "Not enough signal to infer a specific reason.")}` +
  confidenceNote +
  escapeMarkdownV2(optOutTip);
```

### Edit 3 — Add `/about` command (before `/start`)

```ts
bot.command("about", (ctx) => {
  ctx.reply(
    "ℹ️ *About Ad Audit Bot*\n\n" +
    "I analyze ads you forward and explain the *likely targeting signals* behind them — inferred interests, demographics, and platform norms.\n\n" +
    "I do *not*:\n" +
    "• Contact advertisers or platforms on your behalf\n" +
    "• Remove, block, or report ads\n" +
    "• Access your full ad profile on any platform\n\n" +
    "Data stored per ad: brand, targeting inference, demographics, timestamp.\n" +
    "Use /clear to delete everything, /delete <#> to remove one entry.\n\n" +
    "Built to help you understand *why* you see ads, not to stop them.",
    { parse_mode: "MarkdownV2" }
  );
});
```

### Edit 4 — Add `/clear` command (after `/about`)

```ts
bot.command("clear", async (ctx) => {
  const chatId = ctx.chat.id;

  // Count first for the confirmation message
  const { count, error: countError } = await supabase
    .from("ad_audits")
    .select("*", { count: "exact", head: true })
    .eq("telegram_user_id", chatId);

  if (countError) {
    console.error("clear count error:", countError);
    await ctx.reply("⚠️ Couldn't clear your data right now.");
    return;
  }

  const { error: deleteError } = await supabase
    .from("ad_audits")
    .delete()
    .eq("telegram_user_id", chatId);

  if (deleteError) {
    console.error("clear delete error:", deleteError);
    await ctx.reply("⚠️ Couldn't clear your data right now.");
    return;
  }

  await ctx.reply(`🗑️ Deleted ${count ?? 0} ad${count === 1 ? "" : "s"} from your history.`);
});
```

### Edit 5 — Add `/delete <#>` command (after `/clear`)

```ts
bot.command("delete", async (ctx) => {
  const chatId = ctx.chat.id;
  const args = ctx.message.text.trim().split(/\s+/);
  const index = parseInt(args[1]);

  if (isNaN(index) || index < 1) {
    await ctx.reply("Usage: /delete <#>\nExample: /delete 2");
    return;
  }

  // Get the entry at the given 1-indexed position from the user's history
  const { data, error } = await supabase
    .from("ad_audits")
    .select("id, detected_brand")
    .eq("telegram_user_id", chatId)
    .order("created_at", { ascending: false })
    .range(index - 1, index - 1);

  if (error || !data || data.length === 0) {
    await ctx.reply("⚠️ Entry not found. Use /history to see your entries.");
    return;
  }

  const entry = data[0];
  const { error: deleteError } = await supabase
    .from("ad_audits")
    .delete()
    .eq("id", entry.id);

  if (deleteError) {
    console.error("delete entry error:", deleteError);
    await ctx.reply("⚠️ Couldn't delete that entry right now.");
    return;
  }

  await ctx.reply(`✅ Entry #${index} (${entry.detected_brand ?? "Unknown"}) deleted.`);
});
```

### Edit 6 — Add `/feedback <#> <up|down>` command (after `/delete`)

```ts
bot.command("feedback", async (ctx) => {
  const chatId = ctx.chat.id;
  const args = ctx.message.text.trim().split(/\s+/);
  const index = parseInt(args[1]);
  const rating = args[2]?.toLowerCase();

  if (isNaN(index) || index < 1 || !["up", "down"].includes(rating ?? "")) {
    await ctx.reply("Usage: /feedback <#> <up|down>\nExample: /feedback 2 up");
    return;
  }

  // Resolve the history entry to its UUID
  const { data, error } = await supabase
    .from("ad_audits")
    .select("id")
    .eq("telegram_user_id", chatId)
    .order("created_at", { ascending: false })
    .range(index - 1, index - 1);

  if (error || !data || data.length === 0) {
    await ctx.reply("⚠️ Entry not found. Use /history to see your entries.");
    return;
  }

  // Upsert feedback (one rating per entry per user)
  const { error: feedbackError } = await supabase
    .from("ad_feedback")
    .upsert(
      {
        telegram_user_id: chatId,
        ad_audit_id: data[0].id,
        rating,
      },
      { onConflict: "ad_audit_id,telegram_user_id" }
    );

  if (feedbackError) {
    console.error("feedback error:", feedbackError);
    await ctx.reply("⚠️ Couldn't save feedback right now.");
    return;
  }

  await ctx.reply(rating === "up" ? "👍 Thanks for the feedback!" : "👎 Thanks — we'll use this to improve.");
});
```

### Edit 7 — Update `/start` to mention new commands

```ts
bot.command("start", (ctx) => {
  ctx.reply(
    "👋 I'm Ad Audit Bot. Forward me any ad — a screenshot or a link — " +
      "and I'll break down the brand, likely targeting, and inferred " +
      "interests/demographics behind it.\n\n" +
      "Commands:\n" +
      "📋 /history — see your last analyzed ads\n" +
      "📊 /summary — a short profile of what you're being targeted with\n" +
      "ℹ️ /about — what this bot does and doesn't do\n" +
      "🗑️ /clear — delete all your data\n" +
      "📝 /feedback <#> <up|down> — rate an analysis"
  );
});
```

---

## Validation

1. **Deno type check:** `deno check supabase/functions/adauditbot/index.ts`
2. **Manual smoke tests:**
   - `/about` renders without MarkdownV2 errors
   - `/clear` deletes all rows for the user and confirms count
   - `/delete 1` removes the most recent entry
   - `/feedback 1 up` records feedback, second call with `down` updates it (upsert)
   - Forward a Facebook URL → opt-out tip appears in the breakdown
   - Forward a non-platform URL (e.g., `example.com`) → no opt-out tip appended
3. **Migration applies cleanly:** `supabase db push`

---

## What we're NOT adding (yet)

- `/export` and `/retention` — compliance features, useful only if the bot ships publicly
- `/status` — operational, only useful once rate limiting is in place
- Extended ad metadata (advertiser category, CTA type, platform signals) — requires more prompt engineering and schema changes
