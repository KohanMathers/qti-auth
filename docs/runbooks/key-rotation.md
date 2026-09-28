# Key rotation

Three sets of signing keys rotate on their own on the `keys.rotate` cron job, and three environment-supplied keys stay in place until you rotate them.

| Key                                 | Rotates automatically | Where                                                                 |
| ----------------------------------- | --------------------- | --------------------------------------------------------------------- |
| Gateway internal identity token key | Yes, every 30d        | `gateway.identity_keys.rotate_after`                                  |
| OIDC signing key                    | Yes, every 90d        | `oidc.signing.rotate_after`                                           |
| Games licensing signing key         | Yes, every 90d        | `games.licensing.signing.rotate_after`                                |
| `KEY_ENCRYPTION_KEY`                | No                    | `.env`, envelope-encrypts every signing key at rest                   |
| `APP_ENCRYPTION_KEY`                | No                    | `.env`, encrypts TOTP secrets and CSEA evidence at rest               |
| `BACKUP_ENCRYPTION_KEY`             | No                    | `.env`, encrypts backups (see [backup-restore.md](backup-restore.md)) |

Automatic rotation writes the new key first, then signs with it. Replaced keys stay in the published key set for `retain_after_rotation` (1 h for the gateway; 30 d for the games licensing keys; the OIDC value defaults to 1 h but must be at least `access_ttl` and `id_ttl`). Consumers refetch a key set as soon as they see a token signed by a key they don't know.

You do not usually run rotation by hand. Run it early if a key may be compromised, if you're shortening a `rotate_after`, or if you want to end the current key immediately.

## Rotate a signing key early

Rotation is a cron subject, so publishing a tick from another container rotates immediately:

```sh
docker compose --env-file .env -f deploy/compose.yaml exec nats \
  nats pub qtiauth.sys.cron.keys.rotate '{}'
```

Every replica of the gateway, oidc and games sees the tick and does its share under the same work-queue. Check the log lines `rotated signing key` on each service. The metric `qtiauth_<service>_key_created_timestamp_seconds` updates to the new key's timestamp.

If a key has to end at once, shorten `retain_after_rotation` in `qtiauth.yaml`, restart the owning service, publish the cron tick, then set the value back and restart again. Tokens signed with the previous key stop verifying at the shortened window.

## Rotate `KEY_ENCRYPTION_KEY`

`KEY_ENCRYPTION_KEY` envelope-encrypts every signing key at rest. Rotating it re-wraps the existing keys, so you don't lose them.

1. Generate a new key: `openssl rand -base64 32`.
2. Add both keys to `.env`:
   ```
   KEY_ENCRYPTION_KEY=<new key>
   KEY_ENCRYPTION_KEY_PREVIOUS=<old key>
   ```
3. Restart the gateway, oidc and games services. Each one decrypts with either key on read and encrypts with the new key on write.
4. Publish a rotation tick as above so every stored key is re-wrapped.
5. Remove `KEY_ENCRYPTION_KEY_PREVIOUS` from `.env` and restart the same services again.

Never delete `KEY_ENCRYPTION_KEY` without a working replacement. Without it, none of the signing keys can be read from the keyring.

## Rotate `APP_ENCRYPTION_KEY`

`APP_ENCRYPTION_KEY` encrypts identity's TOTP secrets and, unless a separate `safety.csea.encryption_key` is set, CSEA evidence. There is no key overlap for these payloads, so rotation is destructive to the old ciphertext unless every row is re-encrypted first.

1. Ask every staff member with TOTP to re-enrol beforehand. Users with passkeys or recovery codes only are unaffected.
2. Generate a new key, set it in `.env`, restart identity and safety.
3. Any TOTP secret still encrypted with the old key fails the next check and the user is prompted to re-enrol.

If CSEA cases hold evidence encrypted with the old key, do not rotate `APP_ENCRYPTION_KEY` while cases are open. Wait until every case is closed and its evidence retention window (`retention.csea_evidence`) has elapsed and been swept.

## Rotate a game server client secret

The confidential OAuth client each game gets has its own secret. Rotate it from the admin UI, or over the API:

```sh
POST /api/v1/admin/games/<slug>/server-client/rotate
```

The route needs step-up and returns the new secret once. Deploy it to the game server before revoking the old one.

## After any rotation

- Confirm every `qtiauth_*_key_created_timestamp_seconds` metric on the observability dashboard has moved forward.
- Check `qtiauth_*_key_rotations_total` incremented.
- Watch error rates for the next `retain_after_rotation` window. A spike in signature-verification failures means a consumer hasn't refetched the key set.
- Record the rotation in the audit log (`qtiauth audit verify` from the identity image after).
