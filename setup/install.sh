#!/usr/bin/env bash
# tg root install. One command, from a clean checkout:
#   sudo ./setup/install.sh
# It builds and tests the code as you, installs it, logs in, and asks for
# the ids to deny. --agent-user defaults to the user who ran sudo.
# --no-build installs an existing dist/ without rebuilding.
# --work-user <username> --work-title <word> turn on work-audit and
# invite-work-user (both, or neither). Without them the config keeps its value.
#
# Safe to run again for updates. It never touches the session or state.
# An install from before the rename (tg-inbox) is moved over in place.
#
#   1. system user tg (no login shell, no home of its own)
#   2. code in /usr/local/lib/tg, root-owned, run with root-owned /usr/bin/node
#   3. /etc/tg: config.json + denylist.json, root:tg 0640
#   4. /var/lib/tg: session + state, tg 0700
#   5. /etc/sudoers.d/tg: one rule, env_reset, no SETENV
#   6. admin command /usr/local/sbin/tg-admin for the denylist
#   7. first install only: Telegram login, then ask for ids to deny
set -euo pipefail
umask 022

die() { echo "install: $*" >&2; exit 1; }

AGENT_USER="${SUDO_USER:-}"
BUILD=1
WORK_USER=""
WORK_TITLE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent-user) AGENT_USER="${2:-}"; shift 2 ;;
    --no-build) BUILD=0; shift ;;
    --work-user) WORK_USER="${2:-}"; shift 2 ;;
    --work-title) WORK_TITLE="${2:-}"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "run as root"
[[ -n "$AGENT_USER" && "$AGENT_USER" != root ]] || die "pass --agent-user <the account your agents run as>"
id "$AGENT_USER" >/dev/null 2>&1 || die "no such user: $AGENT_USER"
if [[ -n "$WORK_USER" || -n "$WORK_TITLE" ]]; then
  [[ -n "$WORK_USER" && -n "$WORK_TITLE" ]] || die "pass --work-user and --work-title together"
  WORK_USER="${WORK_USER#@}"
  [[ "$WORK_USER" =~ ^[A-Za-z][A-Za-z0-9_]{3,31}$ ]] || die "--work-user must be a Telegram username"
  [[ "$WORK_TITLE" =~ ^[[:alnum:]][[:alnum:]\ ._-]{0,63}$ ]] || die "--work-title must be a word of letters and digits"
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST="$HERE/../dist"
NODE=/usr/bin/node
TG=tg
LIB=/usr/local/lib/tg
ETC=/etc/tg
VAR=/var/lib/tg
SUDOERS=/etc/sudoers.d/tg
ADMIN=/usr/local/sbin/tg-admin
# The layout before the rename. Moved over once, then removed.
OLD_USER=tginbox
OLD_LIB=/usr/local/lib/tg-inbox
OLD_ETC=/etc/tg-inbox
OLD_VAR=/var/lib/tg-inbox
OLD_SUDOERS=/etc/sudoers.d/tg-inbox
OLD_ADMIN=/usr/local/sbin/tg-inbox-admin

# ── 0. build and test, as the agent user (never as root) ────────────────
if (( BUILD )); then
  ROOT="$(cd "$HERE/.." && pwd)"
  AGENT_HOME="$(getent passwd "$AGENT_USER" | cut -d: -f6)"
  as_agent() { runuser -u "$AGENT_USER" -- env HOME="$AGENT_HOME" "$@"; }
  [[ -z "$(as_agent git -C "$ROOT" status --porcelain)" ]] \
    || die "checkout has uncommitted changes; review and commit them first"
  echo "0. building $(as_agent git -C "$ROOT" log -1 --format='%h %s') as $AGENT_USER"
  as_agent bash -lc 'cd "$1" && npm ci --ignore-scripts --silent && npm test --silent && npm run build --silent' _ "$ROOT" \
    || die "build or tests failed; nothing installed"
fi

# ── preflight ───────────────────────────────────────────────────────────
[[ -x "$NODE" ]] || die "$NODE not found"
[[ "$(stat -c %u "$NODE")" == 0 ]] || die "$NODE is not owned by root"
(( (8#$(stat -c %a "$NODE") & 8#022) == 0 )) || die "$NODE is group- or world-writable"
major="$("$NODE" -p 'process.versions.node.split(".")[0]')"
(( major >= 24 )) || die "node $major is too old; need >= 24"
for f in cli.mjs admin.mjs mtcute.wasm mtcute-simd.wasm; do
  [[ -f "$DIST/$f" ]] || die "missing dist/$f; drop --no-build or run npm run build as yourself"
done
if grep -l 'better-sqlite3' "$DIST"/*.mjs >/dev/null 2>&1; then die "bundle references better-sqlite3"; fi
if [[ -e "$OLD_ETC" && -e "$ETC" ]] || [[ -e "$OLD_VAR" && -e "$VAR" ]]; then
  die "both the old and the new layout exist ($OLD_ETC, $OLD_VAR vs $ETC, $VAR); keep one and run again"
fi
NOLOGIN="$(command -v nologin || echo /usr/sbin/nologin)"

# ── 1. system user ──────────────────────────────────────────────────────
if ! id "$TG" >/dev/null 2>&1; then
  useradd --system --user-group --home-dir "$VAR" --no-create-home --shell "$NOLOGIN" "$TG"
  echo "1. created system user $TG"
else
  echo "1. system user $TG exists"
fi
[[ "$(id -u "$TG")" != 0 ]] || die "$TG must not be uid 0"
if id -nG "$AGENT_USER" | tr ' ' '\n' | grep -qx "$TG"; then
  die "$AGENT_USER is in group $TG; remove it (gpasswd -d $AGENT_USER $TG)"
fi

# ── 1b. move an install from before the rename ──────────────────────────
if [[ -e "$OLD_ETC" || -e "$OLD_VAR" ]]; then
  # No new run of the old CLI can start once its sudo rule is gone.
  rm -f "$OLD_SUDOERS"
  if id "$OLD_USER" >/dev/null 2>&1; then
    for _ in $(seq 120); do pgrep -u "$OLD_USER" >/dev/null || break; sleep 1; done
    ! pgrep -u "$OLD_USER" >/dev/null || die "a $OLD_USER process is still running; run this again when it ends"
  fi
  if [[ -e "$OLD_ETC" ]]; then mv "$OLD_ETC" "$ETC"; chgrp -R "$TG" "$ETC"; fi
  if [[ -e "$OLD_VAR" ]]; then mv "$OLD_VAR" "$VAR"; chown -R "$TG:$TG" "$VAR"; fi
  echo "1b. moved $OLD_ETC and $OLD_VAR to $ETC and $VAR (session and state kept)"
fi

# ── 2. code ─────────────────────────────────────────────────────────────
install -d -o root -g root -m 0755 "$LIB"
stage="$(mktemp -d "$LIB.stage.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
install -o root -g root -m 0644 "$DIST"/*.mjs "$DIST"/mtcute.wasm "$DIST"/mtcute-simd.wasm "$stage/"
chmod 0755 "$stage"
# Swap in the new build. Old hashed chunks go with the old directory.
old="$LIB.old.$$"
mv "$LIB" "$old"
mv "$stage" "$LIB"
rm -rf "$old"
trap - EXIT
echo "2. installed code in $LIB:"
(cd "$LIB" && sha256sum ./*)

# ── 3. config ───────────────────────────────────────────────────────────
install -d -o root -g "$TG" -m 0750 "$ETC"
if [[ ! -f "$ETC/config.json" ]]; then
  read -r -p "Telegram api_id (from my.telegram.org): " api_id
  read -r -s -p "Telegram api_hash (not shown): " api_hash; echo
  [[ "$api_id" =~ ^[0-9]+$ ]] || die "api_id must be a number"
  [[ "$api_hash" =~ ^[0-9a-fA-F]{32}$ ]] || die "api_hash must be 32 hex characters"
  tmp="$(mktemp)"
  printf '{\n  "apiId": %s,\n  "apiHash": "%s",\n  "readOnly": false,\n  "allowSend": false,\n  "dailySendCap": 20,\n  "allowWorkInvite": false,\n  "dailyWorkInviteCap": 0\n}\n' \
    "$api_id" "$api_hash" > "$tmp"
  install -o root -g "$TG" -m 0640 "$tmp" "$ETC/config.json"
  rm -f "$tmp"
  echo "3. wrote $ETC/config.json (send is off)"
else
  chown root:"$TG" "$ETC/config.json"; chmod 0640 "$ETC/config.json"
  echo "3. kept $ETC/config.json"
fi
if [[ -n "$WORK_USER" ]]; then
  tmp="$(mktemp)"
  "$NODE" -e 'const fs = require("fs"); const [file, user, title] = process.argv.slice(1)
    const c = JSON.parse(fs.readFileSync(file, "utf8")); c.workUser = user; c.workTitle = title
    process.stdout.write(JSON.stringify(c, null, 2) + "\n")' "$ETC/config.json" "$WORK_USER" "$WORK_TITLE" > "$tmp" \
    || { rm -f "$tmp"; die "could not update $ETC/config.json"; }
  install -o root -g "$TG" -m 0640 "$tmp" "$ETC/config.json"
  rm -f "$tmp"
  echo "   set workUser and workTitle in $ETC/config.json"
fi
if [[ ! -f "$ETC/denylist.json" ]]; then
  tmp="$(mktemp)"
  printf '{\n  "version": 1,\n  "users": [],\n  "chats": [],\n  "allowChats": []\n}\n' > "$tmp"
  install -o root -g "$TG" -m 0640 "$tmp" "$ETC/denylist.json"
  rm -f "$tmp"
  echo "   wrote an empty $ETC/denylist.json (the CLI refuses to run until you add users)"
else
  chown root:"$TG" "$ETC/denylist.json"; chmod 0640 "$ETC/denylist.json"
  echo "   kept $ETC/denylist.json"
fi

# ── 4. state ────────────────────────────────────────────────────────────
install -d -o "$TG" -g "$TG" -m 0700 "$VAR"
echo "4. state directory $VAR ($TG, 0700)"

# ── 5. sudoers ──────────────────────────────────────────────────────────
tmp="$(mktemp)"
sed "s/@AGENT_USER@/$AGENT_USER/g" "$HERE/sudoers.tg.in" > "$tmp"
visudo -cf "$tmp" >/dev/null || { rm -f "$tmp"; die "sudoers rule failed visudo -c"; }
install -o root -g root -m 0440 "$tmp" "$SUDOERS"
rm -f "$tmp"
echo "5. installed $SUDOERS for $AGENT_USER"

# ── 6. admin command ────────────────────────────────────────────────────
install -o root -g root -m 0755 "$HERE/tg-admin" "$ADMIN"
echo "6. installed $ADMIN"

# Leftovers of the old layout, once the new one is in place.
if [[ -e "$OLD_LIB" || -e "$OLD_ADMIN" || -e "$OLD_SUDOERS" ]] || id "$OLD_USER" >/dev/null 2>&1; then
  rm -rf "$OLD_LIB"
  rm -f "$OLD_ADMIN" "$OLD_SUDOERS"
  if id "$OLD_USER" >/dev/null 2>&1; then userdel "$OLD_USER"; fi
  if getent group "$OLD_USER" >/dev/null; then groupdel "$OLD_USER"; fi
  echo "   removed the old $OLD_USER user, $OLD_LIB, $OLD_ADMIN and $OLD_SUDOERS"
fi

# ── 7. login and denylist (interactive, first install only) ─────────────
if [[ ! -f "$VAR/telegram.session" && -t 0 ]]; then
  echo "7. Telegram login (phone, code, 2FA password)"
  "$ADMIN" login
  read -r -p "Numeric Telegram user ids to deny, space-separated (blank to skip): " -a deny_ids
  if (( ${#deny_ids[@]} )); then "$ADMIN" deny-add "${deny_ids[@]}"; fi
  "$ADMIN" status
fi

cat <<EON

Done. Later changes, as yourself:
  sudo tg-admin deny-add <id> [<id> ...]
  sudo tg-admin status
Run "sudo -k" now to drop your cached sudo password.
EON
