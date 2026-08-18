#!/usr/bin/env bash
# Generates the three keys the console refuses to start without.
#
# Run once per environment and store the output in your secret manager before
# putting it in .env. ENCRYPTION_KEY in particular is not rotatable in place:
# it decrypts every stored provider token and database password.
set -euo pipefail

command -v openssl >/dev/null || { echo 'openssl is required' >&2; exit 1; }

cat <<KEYS
# Generated $(date -u +%Y-%m-%dT%H:%M:%SZ) — store these in a secret manager.
#
# ENCRYPTION_KEY seals provider tokens and database passwords (AES-256-GCM).
# Changing it makes existing ciphertext undecryptable; back it up first.
ENCRYPTION_KEY=$(openssl rand -base64 32)

# AUDIT_LOG_SECRET chains audit records. Kept separate from ENCRYPTION_KEY so
# neither key alone allows both reading secrets and forging history.
# Rotating it makes every prior audit hash unverifiable — record any rotation.
AUDIT_LOG_SECRET=$(openssl rand -base64 32)

# SESSION_SECRET signs session cookies. Rotating it signs everyone out.
SESSION_SECRET=$(openssl rand -base64 48)
KEYS
