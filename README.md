# VOLP Telegram Reminder Bot

A free, shared Telegram bot that checks VOLP for pending assignments and sends deadline reminders.

## Host your own private bot

Each self-hosted copy uses the owner's own Telegram bot, Cloudflare Worker,
D1 database, Queue, and encryption key. Other operators never receive that
copy's VOLP credentials or assignment data.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/nemesis0007/volp-telegram-reminder-bot)

Quick setup:

1. Create a Telegram bot with [@BotFather](https://t.me/BotFather) and copy its token.
2. Generate two different random secrets:
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
3. Click **Deploy to Cloudflare** and supply the bot token, one random value as
   `WEBHOOK_SECRET`, and the other as `CREDENTIAL_KEY`.
4. When deployment finishes, open the Worker URL. That registers the Telegram
   webhook, configures the command menu, and opens the bot.
5. Send `/start`.

Cloudflare provisions the Worker, D1 database, and Queue in the self-hoster's
account. See [SELF_HOSTING.md](SELF_HOSTING.md) for screenshots-free detailed
instructions, manual CLI deployment, upgrades, and troubleshooting.

## Use the hosted bot

[Open the VOLP Assignment Reminder in Telegram](https://volp-telegram-reminder-bot.nirajbots.workers.dev/bot), send `/start`, and connect VOLP using the private 15-minute link. No installation is required.

## What users get

- Private one-time connection link inside Telegram
- Upcoming assignment list with `/assignments`
- Missed assignment history with `/missed`
- Manual refresh with `/sync`
- Retryable sync-completion delivery that never repeats a successful VOLP sync
- Assignment checks every three hours
- Immediate Telegram alerts when a three-hour check discovers new assignments
- An 8:00 AM IST summary of unsubmitted assignments due within three days
- Reminder delivery evaluated every 15 minutes
- A personal reminder choice: 1 hour, 1.5 hours, or 2 hours before deadlines
- Settings buttons with `/settings`
- An in-bot privacy and project summary with `/about`
- Encrypted password storage for automatic re-login
- Complete credential and assignment deletion with `/disconnect`
- Support for hands-on and subjective assignments

## Security model

Users never type VOLP passwords into Telegram. The setup page first sends the
password directly from the browser to VOLP, then sends it once over HTTPS to the
self-hosted Worker so automatic re-login can store it encrypted.

Automatic re-login is required because VOLP sessions are short-lived. The Worker receives and stores the password encrypted with AES-256-GCM, then uses it only when VOLP invalidates the current session. This is not end-to-end encryption: the Worker operator controls the encryption key. See [SECURITY.md](SECURITY.md).

## Reliability

- Webhooks are acknowledged immediately and processed with Cloudflare background tasks.
- Telegram update IDs are deduplicated to prevent repeated commands after delivery retries.
- Per-user locks prevent manual and automatic syncs from overlapping.
- Telegram rate limits and temporary VOLP failures use bounded retries and request timeouts.
- Upcoming assignments and overdue unsubmitted assignments are stored; submitted
  past assignments are cleaned up automatically.
- Connecting a different VOLP account atomically replaces the previous account and clears its cached data.
- Assignments removed from VOLP are removed locally unless they are overdue and
  unsubmitted, in which case `/missed` retains them.
- Deadline changes reset the reminder state, so the updated deadline can notify correctly.
- VOLP credentials and assignment data are accepted only in private Telegram chats.
- Disconnect requires confirmation and deletes the session, assignments, reminders, locks, and preferences.

The implementation follows the official [Telegram webhook documentation](https://core.telegram.org/bots/api#setwebhook), [Telegram bot FAQ](https://core.telegram.org/bots/faq), and [Cloudflare Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/).

## Anonymous usage telemetry

Self-hosted deployments send one aggregate heartbeat per day to the maintainer's
collector by default. It contains only:

- A randomly generated installation ID
- The bot version
- The total number of registered Telegram users
- The total number of connected VOLP accounts

It does **not** send Telegram IDs, names, VOLP usernames, credentials, tokens,
assignments, reminder settings, or message contents. The installation ID is
generated locally and is not tied to a person. This telemetry is used only to
estimate how many installations and aggregate users are actively using the
open-source project.

To disable telemetry, set this in `wrangler.jsonc` before deploying:

```jsonc
"vars": {
  "TELEMETRY_DISABLED": "true"
}
```

Removing the variable does not disable telemetry; it is enabled by default.

The collector is anonymous and has no way to prove that every heartbeat came
from an unmodified copy, so these figures are useful estimates rather than an
auditable user count.

The maintainer can see active installations and aggregate users from the last
30 days with:

```powershell
npx wrangler d1 execute volp-reminder-bot --remote --command "SELECT COUNT(*) AS active_installations, COALESCE(SUM(user_count), 0) AS aggregate_users, COALESCE(SUM(connected_user_count), 0) AS aggregate_connected_users FROM telemetry_installations WHERE julianday(last_seen_at) >= julianday('now', '-30 days')"
```

## Commands

- `/start` or `/connect` — create a private VOLP setup link
- `/assignments` — list upcoming assignments
- `/missed` — list overdue assignments that were not submitted
- `/sync` — check VOLP immediately
- `/settings` — choose a 1-hour, 1.5-hour, or 2-hour reminder
- `/security` — view automatic re-login status
- `/about` — view how the bot works, its privacy model, and source link
- `/disconnect` — permanently delete stored credentials and assignment data

## Important notes

- VOLP sync requests pause during scheduled maintenance from 12:00 AM through
  6:29 AM IST. Cached assignment reminders continue, and automatic syncing
  resumes at 6:30 AM.
- VOLP has no documented public API. This project uses the same endpoints as its web client; they may change without notice.
- The project is unaffiliated with VOLP or Vishwakarma Institute of Technology.
- Do not use it to submit assignments or bypass access controls.
- Respect Cloudflare and VOLP rate limits. The automatic sync interval is three hours.
- Automatic account syncs are processed as individual queue jobs with retries and
  limited concurrency, preventing one large cron invocation from exhausting its
  outbound-request limit.
- New connections stop automatically at 90 connected accounts. Existing users
  can still reconnect, keeping capacity below the tested 100-user target.

## Development

```bash
npm run typecheck
npm run dev
```

Copy `.dev.vars.example` to `.dev.vars` and replace the example values for
local development. Never commit `.dev.vars`.

## License

MIT
