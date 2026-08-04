# Ad Audit Bot

Telegram bot that captures ads (screenshot or link), analyzes them with
Mistral's vision model, and logs the results to Supabase.

See `plan.md` for architecture and known limitations (notably: X/Instagram
links need a screenshot-rendering service to work — see below).

## Prerequisites

- Supabase CLI installed and logged in (`supabase login`)
- A Supabase project (`database.new` if you need one)
- A Telegram bot token from [@BotFather](https://t.me/BotFather) (`/newbot`)
- A Mistral API key from [console.mistral.ai](https://console.mistral.ai)

## Setup

1. **Link your project**

   ```bash
   supabase link --project-ref <your-project-ref>
   ```

2. **Run the migration**

   ```bash
   supabase db push
   ```

   This creates `ad_audits`, enables RLS, and creates the private
   `ad-screenshots` storage bucket.

3. **Set function secrets**

   ```bash
   supabase secrets set \
     TELEGRAM_BOT_TOKEN=<your-bot-token> \
     MISTRAL_API_KEY=<your-mistral-key>
   ```

   `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically
   into deployed Edge Functions — you don't need to set them manually.

4. **Deploy**

   ```bash
   supabase functions deploy telegram-bot --no-verify-jwt
   ```

   `--no-verify-jwt` is required: Telegram doesn't send a Supabase JWT, so
   the webhook secret query param is what authenticates requests instead.

5. **Register the webhook**

   ```bash
   curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<project-ref>.supabase.co/functions/v1/telegram-bot?secret=<TELEGRAM_BOT_TOKEN>"
   ```

   You should get `{"ok":true,"result":true,...}` back.

## Local development

```bash
supabase functions serve telegram-bot --env-file .env.example
```

Use a tool like [ngrok](https://ngrok.com) to expose your local server and
point Telegram's webhook at that URL temporarily for testing.

## Commands

- `/start` — intro and command list
- `/history` — last 10 analyzed ads for that chat, most recent first
- `/summary` — aggregate profile: top brands, dominant targeting type,
  recurring interest themes, computed in-function from the last 200 rows
  (no extra AI call — plain aggregation over already-stored `raw_ai_analysis`)

## Testing

- Send a plain URL → bot fetches `og:*` metadata, analyzes, replies.
- Send a screenshot → bot downloads, stores, analyzes, replies.
- Send a forwarded photo with a caption → caption is passed to the model as
  extra context (useful when the caption contains the original link).
- Send an X/Instagram link → metadata will likely come back empty since
  those platforms block unauthenticated scraping; the model still gets the
  bare URL and does its best. If these become common, see `plan.md` for the
  screenshot-render option.

## Known limitations

- No rate limiting yet — one user spamming screenshots means uncapped
  Mistral spend. See TODOs in `plan.md`.
- X/Instagram links return little to no `og:*` metadata (login-walled).
  Not handled specially since most ad links won't be from these platforms —
  revisit if that assumption changes.
- `mistral-large` model naming shifts over time — confirm the current
  vision-capable model name in the Mistral console before deploying.
