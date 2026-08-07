// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Bot, webhookCallback } from "grammy";
import { createClient } from "@supabase/supabase-js";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN");
const MISTRAL_API_KEY = Deno.env.get("MISTRAL_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is unset");
if (!MISTRAL_API_KEY) throw new Error("MISTRAL_API_KEY is unset");
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error("Supabase env vars are unset");

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const bot = new Bot(BOT_TOKEN);

const ANALYSIS_SCHEMA_PROMPT = `You are an ad transparency analyst. Your job
is to help the person understand WHY they were likely shown this specific
ad, not to describe what the ad is advertising.

Given an ad screenshot or ad landing page content, respond with ONLY a JSON
object, no markdown, no prose, matching exactly:
{
  "brand": string | null,
  "targeting_type": string | null,
  "interests": string[],
  "demographics": object,
  "likely_reason": string
}

For "likely_reason": write 2-3 sentences addressed directly to the person
(use "you"), explaining the most probable reason THEY were targeted with
this ad — e.g. inferred interest signals, demographic bracket, browsing/app
behavior, platform-specific targeting norms (e.g. lookalike audiences,
retargeting, broad vs. narrow interest targeting). Do NOT summarize the
ad's marketing copy or what the product does — assume the person can already
read the ad. Focus entirely on the targeting inference itself. If the
targeting looks broad/undifferentiated rather than personal, say so plainly
rather than inventing a narrower reason.`;

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
    (interests ?? []).map((i) => i.toLowerCase().replace(/_/g, " ").trim()).filter(Boolean)
  ));
}

// Map any free-text targeting string to the canonical enum.
// Unknown values default to "broad_undifferentiated".
function normalizeTargetingType(t: string | null | undefined): string | null {
  if (!t) return null;
  const m: Record<string, string> = {
    "interest-based": "interest",
    "interest_and_demographic_based": "interest",
    interest: "interest",
    demographic: "demographic",
    geographic: "geographic",
    "geo-based and interest-based": "geographic",
    "geo-based": "geographic",
    retargeting: "retargeting",
    platform_retargeting: "platform_internal",
    "platform internal": "platform_internal",
    lookalike: "lookalike",
    "broad interest + lookalike": "lookalike",
    broad_undifferentiated: "broad_undifferentiated",
    broad: "broad_undifferentiated",
    professional: "professional",
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

function getOptOutTip(url: string | null): string {
  const platform = url ? detectPlatform(url) : null;
  if (!platform) return "";

  return "\n\n🔧 To reduce similar " + platform.name + " ads:\n" +
    "• " + platform.steps + "\n" +
    "• Or hide this ad: long-press → Hide ad";
}

function formatDemographics(d: Record<string, unknown>): string {
  const parts: string[] = [];
  if (d.age_bracket) parts.push(`Age ${d.age_bracket}`);
  if (d.gender && d.gender !== "all") parts.push(`Gender ${d.gender}`);
  if (d.location && d.location !== "unknown") parts.push(`Location ${d.location}`);
  if (d.income_level && d.income_level !== "unknown") parts.push(`Income ${d.income_level}`);
  if (d.occupation && Array.isArray(d.occupation) && d.occupation.length > 0) {
    parts.push(`Occupation ${d.occupation.join(", ")}`);
  }
  return parts.length > 0 ? parts.join(" · ") : "No demographic data";
}

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

bot.command("delete", async (ctx) => {
  const chatId = ctx.chat.id;
  const args = ctx.message.text.trim().split(/\s+/);
  const index = parseInt(args[1]);

  if (isNaN(index) || index < 1) {
    await ctx.reply("Usage: /delete <#>\nExample: /delete 2");
    return;
  }

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

  await ctx.reply("✅ Entry #" + index + " (" + (entry.detected_brand ?? "Unknown") + ") deleted.");
});

bot.command("clear", async (ctx) => {
  const chatId = ctx.chat.id;

  const { error } = await supabase
    .from("ad_audits")
    .delete()
    .eq("telegram_user_id", chatId);

  if (error) {
    console.error("clear error:", error);
    await ctx.reply("⚠️ Couldn't clear your data right now.");
    return;
  }

  await ctx.reply("🗑️ All your data has been deleted.");
});

bot.command("start", (ctx) => {
  ctx.reply(
    "👋 I'm Ad Audit Bot. Forward me any ad — a screenshot or a link — " +
      "and I'll break down the brand, likely targeting, and inferred " +
      "interests/demographics behind it.\n\n" +
      "Commands:\n" +
      "/history — 📋 see your last analyzed ads\n" +
      "/summary — 📊 a short profile of what you're being targeted with\n" +
      "/about — ℹ️ what this bot does and doesn't do\n" +
      "/clear — 🗑️ delete all your data\n" 
  );
});

bot.command("history", async (ctx) => {
  const chatId = ctx.chat.id;
  const { data, error } = await supabase
    .from("ad_audits")
    .select("created_at, media_type, detected_brand, targeting_type")
    .eq("telegram_user_id", chatId)
    .order("created_at", { ascending: false })
    .limit(10);

  if (error) {
    console.error("history query error:", error);
    await ctx.reply("⚠️ Couldn't load your history right now.");
    return;
  }
  if (!data || data.length === 0) {
    await ctx.reply("📭 No ads analyzed yet — forward me a screenshot or link to get started.");
    return;
  }

  const lines = data.map((row, i) => {
    const date = new Date(row.created_at).toLocaleString("en-GB", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    return `🔹 ${i + 1}. ${date} — ${row.detected_brand ?? "Unknown"} — ${row.media_type} — ${row.targeting_type ?? "n/a"}`;
  });

  await ctx.reply(`📋 Your last ${data.length} ads:\n\n${lines.join("\n")}`);
});

bot.command("summary", async (ctx) => {
  const chatId = ctx.chat.id;

  const { data, error } = await supabase
    .from("user_ad_profile")
    .select("*")
    .eq("telegram_user_id", chatId)
    .maybeSingle();

  if (error) {
    console.error("summary query error:", error);
    await ctx.reply("⚠️ Couldn't build your summary right now.");
    return;
  }
  if (!data) {
    await ctx.reply("📭 No ads analyzed yet — forward me a screenshot or link to get started.");
    return;
  }

  const topInterests = data.top_interests
    ? Object.entries(data.top_interests)
        .sort((a, b) => (b[1] as number) - (a[1] as number))
        .slice(0, 6)
        .map(([item]) => item as string)
    : [];

  const summaryText =
    `📊 Your ad profile (${data.total_ads} ad${data.total_ads === 1 ? "" : "s"} tracked)\n\n` +
    `🏢 Top brands: ${escapeMarkdownV2(data.top_brand ?? "none detected")}\n` +
    `🎯 Most common targeting: ${data.top_targeting_category ?? "n/a"}\n` +
    (data.no_metadata_count > 0
      ? `⚠️ ${data.no_metadata_count} ad(s) had no retrievable metadata (URL-only, no screenshot).\n`
      : "") +
    `🧲 Recurring interest themes: ${topInterests.join(", ") || "none detected"}\n\n` +
    `📝 Note: this reflects what the model inferred from ad creative/metadata, not the advertiser's actual targeting settings.`;

  await ctx.reply(summaryText);
});

bot.on("message:text", (ctx) => {
  const chatId = ctx.chat.id;
  const updateId = ctx.update.update_id;
  const forwardedFrom = getForwardSource(ctx.message);
  ctx.reply("🔍 Got it, analyzing...").catch(() => {});
  scheduleBackground(handleUrl(ctx.message.text.trim(), chatId, updateId, ctx, forwardedFrom));
});

bot.on("message:photo", (ctx) => {
  const chatId = ctx.chat.id;
  const updateId = ctx.update.update_id;
  const photo = ctx.message.photo[ctx.message.photo.length - 1];
  const caption = ctx.message.caption ?? null;
  const forwardedFrom = getForwardSource(ctx.message);
  ctx.reply("🔍 Got it, analyzing...").catch(() => {});
  scheduleBackground(handleScreenshot(photo.file_id, chatId, updateId, ctx, caption, forwardedFrom));
});

function scheduleBackground(promise: Promise<unknown>) {
  const edgeRuntime = (globalThis as { EdgeRuntime?: { waitUntil: (task: Promise<unknown>) => void } }).EdgeRuntime;
  if (edgeRuntime?.waitUntil) {
    edgeRuntime.waitUntil(promise);
  } else {
    void promise;
  }
}

function getForwardSource(message: any) {
  const origin = message.forward_origin;
  if (!origin) return null;
  if (origin.type === "channel") return origin.chat?.title ?? "channel";
  if (origin.type === "chat") return origin.sender_chat?.title ?? "chat";
  if (origin.type === "user") return origin.sender_user?.username ?? origin.sender_user?.first_name ?? "user";
  if (origin.type === "hidden_user") return origin.sender_user_name ?? "hidden user";
  return null;
}

async function handleScreenshot(fileId: string, chatId: number, updateId: number, ctx: any, caption: string | null, forwardedFrom: string | null) {
  try {
    const file = await ctx.api.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const imageRes = await fetch(fileUrl);
    const imageBuffer = new Uint8Array(await imageRes.arrayBuffer());

    const storagePath = `${chatId}/${crypto.randomUUID()}.jpg`;
    await supabase.storage.from("ad-screenshots").upload(storagePath, imageBuffer, { contentType: "image/jpeg" });

    const base64Image = encodeBase64(imageBuffer);
    const analysis = await analyzeImage(base64Image, caption);

    await saveAndReply({
      chatId,
      updateId,
      mediaType: "screenshot",
      mediaUrl: storagePath,
      analysis,
      metadataConfidence: "full",
      forwardedFrom,
    });
  } catch (err) {
    console.error("handleScreenshot error:", err);
    await bot.api.sendMessage(chatId, "😬 Sorry, something went wrong processing that screenshot.");
  }
}

async function handleUrl(text: string, chatId: number, updateId: number, ctx: any, forwardedFrom: string | null) {
  try {
    const url = extractUrl(text);
    if (!url) {
      await bot.api.sendMessage(chatId, "📎 Send a link or a screenshot of an ad.");
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
    await bot.api.sendMessage(chatId, "😬 Sorry, something went wrong processing that link.");
  }
}

function extractUrl(text: string) {
  const match = text.match(/https?:\/\/\S+/);
  return match ? match[0] : null;
}

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

async function fetchOgMetadata(url: string) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; AdAuditBot/1.0)" },
      redirect: "follow",
    });
    const html = await res.text();
    const pick = (prop: string) => {
      const m = html.match(new RegExp(`<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']+)["']`, "i"));
      return m ? m[1] : null;
    };
    return {
      resolved_url: res.url,
      title: pick("og:title"),
      description: pick("og:description"),
      image: pick("og:image"),
    };
  } catch (err) {
    console.error("fetchOgMetadata failed:", err);
    return { resolved_url: url, title: null, description: null, image: null };
  }
}

async function analyzeImage(base64Image: string, caption: string | null) {
  const text = caption
    ? `Analyze this ad screenshot. It was sent with this caption, which may contain the original link or extra context: "${caption}"`
    : "Analyze this ad screenshot.";
  return callMistral([
    { type: "text", text },
    { type: "image_url", image_url: `data:image/jpeg;base64,${base64Image}` },
  ]);
}

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

async function callMistral(userContent: Array<{ type: string; text?: string; image_url?: string }>) {
  const res = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${MISTRAL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "mistral-large-latest", // pixtral-large-latest is deprecated; mistral-large-latest is vision-capable
      messages: [
        { role: "system", content: ANALYSIS_SCHEMA_PROMPT },
        { role: "user", content: userContent },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          schema: ANALYSIS_RESPONSE_SCHEMA,
          name: "ad_analysis",
          strict: true,
        },
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Mistral API error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content ?? "{}";
  try {
    return JSON.parse(raw);
  } catch {
    return { brand: null, targeting_type: null, interests: [], demographics: {}, likely_reason: `⚠️ Malformed response: ${raw}`.slice(0, 500) };
  }
}

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

  const optOutTip = getOptOutTip(mediaUrl);

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

  try {
    await bot.api.sendMessage(chatId, text, { parse_mode: "MarkdownV2" });
  } catch (err) {
    console.error("sendMessage formatting error, falling back to plain text:", err);
    await bot.api.sendMessage(chatId, text.replace(/[*_[\]()~`>#+\-=|{}.!\\]/g, ""));
  }
}

// Escapes MarkdownV2 special characters in model-generated text so Telegram
// doesn't choke on stray underscores, asterisks, parens, etc. See:
// https://core.telegram.org/bots/api#markdownv2-style
function escapeMarkdownV2(text: string) {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

function encodeBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const handleUpdate = webhookCallback(bot, "std/http");

Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);
    if (url.searchParams.get("secret") !== BOT_TOKEN) {
      return new Response("not allowed", { status: 405 });
    }
    return await handleUpdate(req);
  } catch (err) {
    console.error(err);
    return new Response("Error", { status: 500 });
  }
});