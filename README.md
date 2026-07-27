# VOLP Telegram Reminder Bot

A free, shared Telegram bot that checks VOLP for pending assignments and sends deadline reminders.

## Use the hosted bot

[Open the VOLP Assignment Reminder in Telegram](https://volp-telegram-reminder-bot.physiotwin-numenors.workers.dev/bot), send `/start`, and connect VOLP using the private 15-minute link. No installation is required.

## What users get

- Private one-time connection link inside Telegram
- Upcoming assignment list with `/assignments`
- Manual refresh with `/sync`
- Hourly assignment checks
- Reminder delivery evaluated every 15 minutes
- A personal reminder choice: 1 hour, 1.5 hours, or 2 hours before deadlines
- Settings buttons with `/settings`
- An in-bot privacy and project summary with `/about`
- Complete credential and assignment deletion with `/disconnect`
- Support for hands-on and subjective assignments

## Security model

Users never type VOLP passwords into Telegram. The setup page sends the password directly from the user's browser to VOLP. The Worker never receives or stores it. Only VOLP's temporary session token is encrypted with AES-256-GCM and stored in D1.

When VOLP expires a session, the user must reconnect. See [SECURITY.md](SECURITY.md).

## Reliability

- Webhooks are acknowledged immediately and processed with Cloudflare background tasks.
- Telegram update IDs are deduplicated to prevent repeated commands after delivery retries.
- Per-user locks prevent manual and hourly syncs from overlapping.
- Telegram rate limits and temporary VOLP failures use bounded retries and request timeouts.
- Only future assignments are stored, and indexed cleanup keeps D1 usage small.
- Connecting a different VOLP account atomically replaces the previous account and clears its cached data.
- Assignments removed from VOLP are removed locally after the next successful sync.
- Deadline changes reset the reminder state, so the updated deadline can notify correctly.
- VOLP credentials and assignment data are accepted only in private Telegram chats.
- Disconnect requires confirmation and deletes the session, assignments, reminders, locks, and preferences.

The implementation follows the official [Telegram webhook documentation](https://core.telegram.org/bots/api#setwebhook), [Telegram bot FAQ](https://core.telegram.org/bots/faq), and [Cloudflare Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/).

## Free deployment

Requirements:

- A Telegram bot from [@BotFather](https://t.me/BotFather)
- A free [Cloudflare account](https://dash.cloudflare.com/)
- Node.js 20 or newer

### 1. Install dependencies

```bash
npm install
npx wrangler login
```

### 2. Create the database

```bash
npx wrangler d1 create volp-reminder-bot
```

Copy `wrangler.example.jsonc` to `wrangler.jsonc`, then replace `PASTE_YOUR_D1_DATABASE_ID` with the ID printed by Wrangler.

Initialize it:

```bash
npm run db:init
```

### 3. Add secrets

Generate two different random values of at least 32 characters for `WEBHOOK_SECRET` and `CREDENTIAL_KEY`.

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put CREDENTIAL_KEY
```

Never put these values in a file or commit them.

### 4. Deploy

```bash
npm run deploy
```

Copy the deployed Worker URL. Register the Telegram webhook without printing your bot token:

```bash
curl -X POST "https://api.telegram.org/bot<YOUR_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://YOUR-WORKER.workers.dev/webhook/YOUR_WEBHOOK_SECRET","secret_token":"YOUR_WEBHOOK_SECRET","allowed_updates":["message","callback_query"]}'
```

Delete the command from your terminal history afterward, or use a local script that reads secrets from hidden prompts.

### 5. Use it

Open the bot in Telegram and send `/start`. Every user receives their own 15-minute VOLP connection link.

## Commands

- `/start` or `/connect` — create a private VOLP setup link
- `/assignments` — list upcoming assignments
- `/sync` — check VOLP immediately
- `/settings` — choose a 1-hour, 1.5-hour, or 2-hour reminder
- `/about` — view how the bot works, its privacy model, and source link
- `/disconnect` — permanently delete stored credentials and assignment data

## Important notes

- VOLP has no documented public API. This project uses the same endpoints as its web client; they may change without notice.
- The project is unaffiliated with VOLP or Vishwakarma Institute of Technology.
- Do not use it to submit assignments or bypass access controls.
- Respect Cloudflare and VOLP rate limits. The default sync interval is one hour.

## Development

```bash
npm run typecheck
npm run dev
```

Copy `wrangler.example.jsonc` to `wrangler.jsonc` and use `.dev.vars` for local secrets. Both are excluded from Git where appropriate.

## License

MIT
