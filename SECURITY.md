# Security

## Reporting a vulnerability

Do not open a public issue for credential exposure, authentication bypass, or encryption problems. Contact the repository owner privately through their GitHub profile.

## Credential handling

- VOLP passwords are accepted only through the HTTPS connection form.
- Passwords are encrypted with AES-256-GCM using `CREDENTIAL_KEY`.
- The encryption key is stored as a Cloudflare Worker secret, separately from D1.
- `/disconnect` deletes a user's account credentials and cached assignments.
- One-time setup links expire after 15 minutes and are deleted after use.
- Telegram webhook requests require both an unguessable path and Telegram's secret-token header.

## Operator responsibility

This is not end-to-end encryption. The person operating the Worker controls `CREDENTIAL_KEY` and can decrypt stored passwords. Operators must:

- Clearly disclose this trust model to users.
- Restrict Cloudflare account access and enable multi-factor authentication.
- Never log form bodies, passwords, encryption keys, Telegram tokens, or webhook secrets.
- Rotate secrets after any suspected compromise.
- Delete all stored credentials when shutting down the service.
- Obtain users' informed consent before storing credentials.

## Limitations

VOLP does not currently expose a documented public API for this use case. Upstream authentication and response formats can change. Failed syncs are isolated per user, but the operator should monitor service health.

