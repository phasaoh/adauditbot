# Ad Audit Bot — Plan

Telegram bot that ingests ad screenshots or links, analyzes them with Mistral's
vision model, and logs the results to Supabase.

## Usage model

The bot chat is a standing drop box: the user forwards links and screenshots
to it as they come across ads, one at a time, indefinitely. Each message is
handled independently and stateless — there's no session or "batch" concept.
Telegram doesn't structurally distinguish a forwarded message from a typed
one, so the same `message:text` / `message:photo` handlers cover both; the
only forward-specific things captured are `forward_origin` (who/where it was
forwarded from, stored as `forwarded_from`) and photo captions, which often
carry the original link when a post is forwarded as an image.

## Flow

```
Telegram (link or photo)
  -> Supabase Edge Function (grammY webhook)
     -> if link to X/Instagram: render via screenshot API -> treat as image
     -> if plain link: fetch page, pull og:* metadata -> treat as text
     -> if photo: download via Telegram file API
  -> upload image to Storage (ad-screenshots bucket, private)
  -> Mistral vision chat completion, JSON-schema forced output
  -> insert row into ad_audits
  -> reply to Telegram with formatted breakdown
```

## Why this shape

- **grammY + Deno.serve**: matches the official Supabase example
  (github.com/supabase/supabase/tree/master/examples/edge-functions/.../telegram-bot).
  Webhook auth uses a `?secret=` query param, checked before grammY even
  touches the request.
- **`EdgeRuntime.waitUntil`**: Telegram retries webhooks that don't respond
  within ~5s. We ack immediately and run the AI call in the background.
- **All links go through `og:*` metadata scraping** (with redirects
  followed, since ad links are often tracking/redirect chains). This covers
  the vast majority of ad landing pages, which are built to have proper OG
  tags for shareability. The known exception is X/Instagram post URLs, which
  are login-walled and return little to no metadata via a bare `fetch()` —
  if the user hits that, the model just gets a bare URL with no metadata and
  does its best; there's no screenshot-rendering fallback wired in, since
  most links in this workflow won't be from those two platforms. If that
  changes later, revisit adding a headless-render step for social links
  specifically.
- **Mistral vision, not Mistral OCR**: OCR is for clean text/table
  extraction. Inferring targeting/demographics is a reasoning task, so it
  goes through the vision chat model with `response_format: json_object` to
  force schema-shaped output instead of prompting for JSON and hoping.
- **Idempotency**: Telegram can redeliver the same `update_id` if the ack is
  slow. `telegram_update_id` is UNIQUE with `ON CONFLICT DO NOTHING`.
- **RLS**: the bot itself always writes with the service role key, which
  bypasses RLS entirely. RLS is enabled on the table anyway so that if you
  ever expose it to a frontend, anon/authenticated roles see nothing by
  default until you add a policy mapping `telegram_user_id` to a real
  Supabase auth user.

## Open decisions / TODO before shipping

- [ ] Rate limiting per `telegram_user_id` (uncapped AI spend otherwise —
      simplest fix is counting rows in the last hour before calling Mistral).
- [ ] Confirm current Mistral vision model name in the console before
      deploying; model names shift (currently targeting a Pixtral-class
      model via `/v1/chat/completions`).
- [ ] Decide retention policy for `ad-screenshots` bucket (screenshots may
      contain personal info — private bucket is set up, but no auto-delete).
