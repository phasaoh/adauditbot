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

bot.command("start", (ctx) => {
  ctx.reply(
    "👋 I'm Ad Audit Bot. Forward me any ad — a screenshot or a link — " +
      "and I'll break down the brand, likely targeting, and inferred " +
      "interests/demographics behind it.\n\n" +
      "Commands:\n" +
      "/history — see your last analyzed ads\n" +
      "/summary — a short profile of what you're being targeted with"
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
    await ctx.reply("Couldn't load your history right now.");
    return;
  }
  if (!data || data.length === 0) {
    await ctx.reply("No ads analyzed yet — forward me a screenshot or link to get started.");
    return;
  }

  const lines = data.map((row, i) => {
    const date = new Date(row.created_at).toLocaleString("en-GB", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    return `${i + 1}. ${date} — ${row.detected_brand ?? "Unknown"} — ${row.media_type} — ${row.targeting_type ?? "n/a"}`;
  });

  await ctx.reply(`📋 Your last ${data.length} ads:\n\n${lines.join("\n")}`);
});

bot.command("summary", async (ctx) => {
  const chatId = ctx.chat.id;
  const { data, error } = await supabase
    .from("ad_audits")
    .select("detected_brand, targeting_type, inferred_interests")
    .eq("telegram_user_id", chatId)
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    console.error("summary query error:", error);
    await ctx.reply("Couldn't build your summary right now.");
    return;
  }
  if (!data || data.length === 0) {
    await ctx.reply("No ads analyzed yet — forward me a screenshot or link to get started.");
    return;
  }

  const topBrands = topN(data.map((r) => r.detected_brand).filter(Boolean), 3);
  const targetingCounts = countBy(data.map((r) => r.targeting_type).filter(Boolean));
  const topTargeting = Object.entries(targetingCounts).sort((a, b) => b[1] - a[1])[0];
  const allInterests = data.flatMap((r) => r.inferred_interests ?? []);
  const topInterests = topN(allInterests, 6);

  const summaryText =
    `📊 Your ad profile (${data.length} ad${data.length === 1 ? "" : "s"} tracked)\n\n` +
    `Top brands: ${topBrands.join(", ") || "none detected"}\n` +
    `Most common targeting: ${topTargeting ? `${topTargeting[0]} (${topTargeting[1]} of ${data.length})` : "n/a"}\n` +
    `Recurring interest themes: ${topInterests.join(", ") || "none detected"}\n\n` +
    `Note: this reflects what the model inferred from ad creative/metadata, not the advertiser's actual targeting settings.`;

  await ctx.reply(summaryText);
});

function countBy(items: Array<string | null | undefined>) {
  const counts: Record<string, number> = {};
  for (const item of items) {
    if (!item) continue;
    counts[item] = (counts[item] ?? 0) + 1;
  }
  return counts;
}

function topN(items: Array<string | null | undefined>, n: number) {
  const counts = countBy(items);
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([item]) => item);
}

bot.on("message:text", (ctx) => {
  const chatId = ctx.chat.id;
  const updateId = ctx.update.update_id;
  const forwardedFrom = getForwardSource(ctx.message);
  ctx.reply("Got it, analyzing...").catch(() => {});
  scheduleBackground(handleUrl(ctx.message.text.trim(), chatId, updateId, ctx, forwardedFrom));
});

bot.on("message:photo", (ctx) => {
  const chatId = ctx.chat.id;
  const updateId = ctx.update.update_id;
  const photo = ctx.message.photo[ctx.message.photo.length - 1];
  const caption = ctx.message.caption ?? null;
  const forwardedFrom = getForwardSource(ctx.message);
  ctx.reply("Got it, analyzing...").catch(() => {});
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
      forwardedFrom,
    });
  } catch (err) {
    console.error("handleScreenshot error:", err);
    await bot.api.sendMessage(chatId, "Sorry, something went wrong processing that screenshot.");
  }
}

async function handleUrl(text: string, chatId: number, updateId: number, ctx: any, forwardedFrom: string | null) {
  try {
    const url = extractUrl(text);
    if (!url) {
      await bot.api.sendMessage(chatId, "Send a link or a screenshot of an ad.");
      return;
    }

    const metadata = await fetchOgMetadata(url);
    const analysis = await analyzeText(url, metadata);

    await saveAndReply({
      chatId,
      updateId,
      mediaType: "url",
      mediaUrl: url,
      analysis,
      forwardedFrom,
    });
  } catch (err) {
    console.error("handleUrl error:", err);
    await bot.api.sendMessage(chatId, "Sorry, something went wrong processing that link.");
  }
}

function extractUrl(text: string) {
  const match = text.match(/https?:\/\/\S+/);
  return match ? match[0] : null;
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

async function analyzeText(url: string, metadata: Record<string, unknown>) {
  return callMistral([
    {
      type: "text",
      text: `Analyze this ad landing page.\nURL: ${url}\nMetadata: ${JSON.stringify(metadata)}`,
    },
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
      response_format: { type: "json_object" },
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
    return { brand: null, targeting_type: null, interests: [], demographics: {}, likely_reason: raw };
  }
}

async function saveAndReply({
  chatId,
  updateId,
  mediaType,
  mediaUrl,
  analysis,
  forwardedFrom,
}: {
  chatId: number;
  updateId: number;
  mediaType: string;
  mediaUrl: string;
  analysis: any;
  forwardedFrom: string | null;
}) {
  const { error } = await supabase.from("ad_audits").insert({
    telegram_user_id: chatId,
    telegram_update_id: updateId,
    media_type: mediaType,
    media_url: mediaUrl,
    detected_brand: analysis.brand,
    inferred_demographics: analysis.demographics ?? {},
    inferred_interests: analysis.interests ?? [],
    targeting_type: analysis.targeting_type,
    raw_ai_analysis: analysis,
    forwarded_from: forwardedFrom,
  });

  if (error && error.code !== "23505") {
    console.error("DB insert error:", error);
  }

  const text =
    `*Ad Breakdown*\n\n` +
    `*Brand:* ${escapeMarkdownV2(analysis.brand ?? "Unknown")}\n` +
    `*Targeting type:* ${escapeMarkdownV2(analysis.targeting_type ?? "N/A")}\n` +
    `*Interests:* ${escapeMarkdownV2((analysis.interests ?? []).join(", ") || "None detected")}\n` +
    `*Demographics:* ${escapeMarkdownV2(JSON.stringify(analysis.demographics ?? {}))}\n\n` +
    `*Why you're likely seeing this:*\n` +
    `${escapeMarkdownV2(analysis.likely_reason ?? "Not enough signal to infer a specific reason.")}`;

  try {
    await bot.api.sendMessage(chatId, text, { parse_mode: "MarkdownV2" });
  } catch (err) {
    console.error("sendMessage formatting error, falling back to plain text:", err);
    // Last-resort fallback: strip all formatting rather than fail silently
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