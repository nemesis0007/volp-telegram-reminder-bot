# VOLP Telegram Reminder Bot

A free, shared Telegram bot that checks VOLP for pending assignments and sends deadline reminders.

## What users get

- Private one-time connection link inside Telegram
- Upcoming assignment list with `/assignments`
- Manual refresh with `/sync`
- Reminders 48 hours, 24 hours, 6 hours, and 90 minutes before deadlines
- Complete credential and assignment deletion with `/disconnect`
- Support for hands-on and subjective assignments

## Security model

Users never type VOLP passwords into Telegram. The setup form is served over HTTPS by Cloudflare Workers. Passwords are validated directly with VOLP and encrypted using AES-256-GCM before being stored in D1.

The bot operator controls the encryption key and can technically decrypt stored credentials. Only run a shared instance if users understand and accept this trust model. See [SECURITY.md](SECURITY.md).

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
  -d '{"url":"https://YOUR-WORKER.workers.dev/webhook/YOUR_WEBHOOK_SECRET","secret_token":"YOUR_WEBHOOK_SECRET","allowed_updates":["message"]}'
```

Delete the command from your terminal history afterward, or use a local script that reads secrets from hidden prompts.

### 5. Use it

Open the bot in Telegram and send `/start`. Every user receives their own 15-minute VOLP connection link.

## Commands

- `/start` or `/connect` — create a private VOLP setup link
- `/assignments` — list upcoming assignments
- `/sync` — check VOLP immediately
- `/disconnect` — permanently delete stored credentials and assignment data

## Important notes

- VOLP has no documented public API. This project uses the same endpoints as its web client; they may change without notice.
- The project is unaffiliated with VOLP or Vishwakarma Institute of Technology.
- Do not use it to submit assignments or bypass access controls.
- Respect Cloudflare and VOLP rate limits. The default sync interval is 15 minutes.

## Development

```bash
npm run typecheck
npm run dev
```

Copy `wrangler.example.jsonc` to `wrangler.jsonc` and use `.dev.vars` for local secrets. Both are excluded from Git where appropriate.

## License

MIT

