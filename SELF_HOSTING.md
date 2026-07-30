# Self-host your own VOLP Telegram bot

Self-hosting gives you an independent bot. Its Telegram token, encryption key,
VOLP credentials, assignments, D1 database, Queue, and Worker stay in your own
accounts.

## Recommended: Deploy to Cloudflare

### Before you start

You need:

- A free [Cloudflare account](https://dash.cloudflare.com/)
- A GitHub account so Cloudflare can create your copy of the repository
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

In BotFather:

1. Send `/newbot`.
2. Choose a display name and a username ending in `bot`.
3. Keep the HTTP API token private.

Generate two different 64-character hexadecimal secrets by running this command
twice:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Deploy

1. Open the deployment flow:

   [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/nemesis0007/volp-telegram-reminder-bot)

2. Sign in to Cloudflare and connect GitHub when prompted.
3. Choose a name for your new repository and Worker.
4. Enter these secrets:

   - `TELEGRAM_BOT_TOKEN`: the token from BotFather
   - `WEBHOOK_SECRET`: the first generated random value
   - `CREDENTIAL_KEY`: the second generated random value

5. Keep the default D1 database and Queue settings and deploy.

Cloudflare creates a repository copy, Worker, D1 database, Queue, cron trigger,
and bindings in your account. The deploy command initializes the database schema
before uploading the Worker.

### Connect Telegram

After deployment, copy the Worker URL shown by Cloudflare. It looks similar to:

```text
https://your-worker-name.your-subdomain.workers.dev
```

Open the Worker URL. Its home page redirects to `/bot`, which securely registers
the webhook using your saved secrets, configures the command menu, and redirects
you to your Telegram bot. Send `/start` to test it.

## Manual CLI deployment

Use this path if you prefer to fork or clone the repository yourself.

Requirements: Node.js 20 or newer, Git, and a Cloudflare account.

```bash
git clone https://github.com/nemesis0007/volp-telegram-reminder-bot.git
cd volp-telegram-reminder-bot
npm install
npx wrangler login
npx wrangler d1 create volp-reminder-bot
npx wrangler queues create volp-sync-jobs
```

Open `wrangler.jsonc` and replace:

```text
00000000-0000-0000-0000-000000000000
```

with the D1 database ID printed by `wrangler d1 create`.

Add the secrets. Wrangler prompts without putting them in source control:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put CREDENTIAL_KEY
```

Deploy:

```bash
npm run deploy
```

This initializes the D1 schema and deploys the Worker. Open the printed Worker
URL, then send `/start` in Telegram.

## Updating an existing installation

Pull the latest source and apply any new migration files listed in the release
notes before deploying. For installations upgrading from version 1.0:

```bash
npx wrangler d1 execute DB --remote --file migrations/0010_anonymous_usage_telemetry.sql
npx wrangler d1 execute DB --remote --file migrations/0011_missed_assignments.sql
npm run deploy
```

`schema.sql` and migrations use the self-hoster's `DB` binding; they never point
to the maintainer's database.

## Privacy and ownership

- The self-hoster controls the Cloudflare account and encryption key.
- Telegram and VOLP credentials are not sent to the repository maintainer.
- VOLP passwords are encrypted at rest, but the Worker operator controls the
  decryption key. Tell every user who operates their bot.
- Anonymous aggregate telemetry is enabled by default and is fully described in
  the README. Set `TELEMETRY_DISABLED` to `"true"` in `wrangler.jsonc` to disable
  it before deployment.
- `/disconnect` deletes a user's stored credentials, assignments, reminders, and
  preferences from that installation.

## Troubleshooting

### `/bot` reports an error

Confirm all three Worker secrets exist and that the BotFather token belongs to
the intended bot. Then open `/bot` again.

### The bot does not answer

Open `/bot` once more to refresh the webhook. Also check the Worker logs and
confirm the Worker URL is publicly reachable.

### Database errors

Run:

```bash
npm run db:init
```

Then redeploy.

### VOLP session expired

Send `/connect` and sign in again. VOLP may invalidate sessions independently
of Cloudflare or Telegram.
