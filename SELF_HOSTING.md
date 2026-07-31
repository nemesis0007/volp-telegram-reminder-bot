# Self-host your own VOLP Telegram bot

Self-hosting gives you an independent bot. Its Telegram token, encryption key,
VOLP credentials, assignments, D1 database, Queue, and Worker stay in your own
accounts.

## Recommended: Fork and deploy with Wrangler

### Before you start

You need:

- A free [Cloudflare account](https://dash.cloudflare.com/)
- A GitHub account for your fork
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- [Git](https://git-scm.com/) and [Node.js 20 or newer](https://nodejs.org/)

In BotFather:

1. Send `/newbot`.
2. Choose a display name and a username ending in `bot`.
3. Keep the HTTP API token private.

Generate two different 64-character hexadecimal secrets by running this command
twice:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Fork and prepare the project

1. [Fork this repository on GitHub](https://github.com/nemesis0007/volp-telegram-reminder-bot/fork).
2. Clone your fork, replacing `YOUR-GITHUB-USERNAME`:

```bash
git clone https://github.com/YOUR-GITHUB-USERNAME/volp-telegram-reminder-bot.git
cd volp-telegram-reminder-bot
npm install
npx wrangler login
```

### Create the Cloudflare resources

```bash
npx wrangler d1 create volp-reminder-bot
npx wrangler queues create volp-sync-jobs
```

Open `wrangler.jsonc` and replace:

```text
00000000-0000-0000-0000-000000000000
```

with the D1 database ID printed by `wrangler d1 create`.

### Add the Worker secrets

Run each command and paste the corresponding value when Wrangler asks for it:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put CREDENTIAL_KEY
```

- `TELEGRAM_BOT_TOKEN`: the token from BotFather
- `WEBHOOK_SECRET`: the first generated random value
- `CREDENTIAL_KEY`: the second generated random value

Wrangler stores these as encrypted Cloudflare secrets; do not commit them to the
fork.

### Deploy

```bash
npm run deploy
```

This initializes the D1 schema and deploys the Worker, Queue bindings, consumer,
and cron trigger from your fork.

### Connect Telegram

After deployment, copy the Worker URL shown by Cloudflare. It looks similar to:

```text
https://your-worker-name.your-subdomain.workers.dev
```

Open the Worker URL. Its home page redirects to `/bot`, which securely registers
the webhook using your saved secrets, configures the command menu, and redirects
you to your Telegram bot. Send `/start` to test it.

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
