# Security

## Reporting a vulnerability

Do not open a public issue for credential exposure, authentication bypass, or encryption problems. Contact the repository owner privately through their GitHub profile.

## Credential handling

- By default, VOLP passwords are sent directly from the user's browser to VOLP and are not shared with the Worker.
- Automatic re-login is required. The password is sent to the Worker and stored encrypted with AES-256-GCM.
- Temporary VOLP session tokens are encrypted with AES-256-GCM using `CREDENTIAL_KEY`.
- The encryption key is stored as a Cloudflare Worker secret, separately from D1.
- `/disconnect` permanently removes the saved password, session, assignments, and preferences.
- `/disconnect` deletes a user's account credentials, cached assignments, reminders, and preferences.
- One-time setup links expire after 15 minutes and are deleted after use.
- Telegram webhook requests require both an unguessable path and Telegram's secret-token header.

## Operator responsibility

This is not end-to-end encryption. The person operating the Worker controls `CREDENTIAL_KEY` and can decrypt stored VOLP session tokens and passwords. Operators must:

- Clearly disclose this trust model to users.
- Restrict Cloudflare account access and enable multi-factor authentication.
- Never log form bodies, passwords, encryption keys, Telegram tokens, or webhook secrets.
- Rotate secrets after any suspected compromise.
- Delete all stored credentials when shutting down the service.
- Obtain users' informed consent before storing credentials.

## Anonymous aggregate telemetry

Self-hosted copies send a default-on daily heartbeat containing a random
installation ID, bot version, registered-user count, and connected-account
count. They do not send Telegram identities, VOLP usernames, credentials,
assignments, settings, or messages. Operators must retain the README disclosure
and may disable the heartbeat with `TELEMETRY_DISABLED: "true"` in
`wrangler.jsonc`.

The public collector validates and caps stored records, but an anonymous
heartbeat cannot be authenticated against modified forks. Aggregate figures
must therefore be treated as estimates.

## Limitations

VOLP does not currently expose a documented public API for this use case. Upstream authentication and response formats can change. Failed syncs are isolated per user, but the operator should monitor service health.

Automatic re-login creates a new VOLP session and may invalidate another active VOLP website or app session because VOLP appears to permit only one active session per account.
