# Installing tg

`tg` gives agents your Telegram account. Some people, and the groups they
are in, must never be visible to those agents. The agents run as your
normal account, written `<agent-user>` below.

The design is simple. A separate system user, `tg`, owns the Telegram
session. `<agent-user>` can run exactly one command as `tg`. That command
filters out denied people before anything is printed. `<agent-user>` cannot
read the session, the state, or the denylist.

This is the recommended setup. Without it, an agent that can read your
files can read the session, and the denylist is only a convention. Every
step below that needs root is yours to run. Agents never run them.

## What you need

- An aged Telegram account with 2FA on. Not a VoIP number.
- Your own `api_id` and `api_hash` from <https://my.telegram.org> → API development tools.
- `/usr/bin/node` version 24 or newer, owned by root. (Arch: `pacman -S nodejs`.)
- The numeric Telegram user id of each person to deny.

## Install (one command)

Stop agents that could edit this checkout first. Root installs whatever the
checkout builds, so the tree must be the commit you reviewed.

```sh
git clone https://github.com/hemaaanth/tg.git
cd tg
sudo ./setup/install.sh
```

That is the whole setup. The script:

1. Refuses a checkout with uncommitted changes.
2. Runs `npm ci --ignore-scripts`, `npm test` and `npm run build` **as you**,
   never as root. Nothing is installed if a test fails.
3. Installs everything below as root.
4. On the first run only: asks for `api_id` and `api_hash`, logs in to
   Telegram (phone, code, 2FA password), then asks for the numeric user ids
   to deny.

Run it again after a `git pull` to update. It keeps the session and state.
`--agent-user <name>` overrides the account your agents run as (default:
the user who ran `sudo`). `--no-build` installs an existing `dist/` as is.
`--work-user <username> --work-title <word>` sets `workUser` and `workTitle`
(see the settings below).

An install from before the rename to `tg` (user `tginbox`, paths named
`tg-inbox`) is moved over in the same run. The session, state, config and
denylist are kept; the old user, code, sudo rule and admin command are
removed.

What it installs:

| Step | What | Owner and mode |
|---|---|---|
| 1 | system user `tg`, shell `nologin` | — |
| 2 | code in `/usr/local/lib/tg` | `root:root`, dir 0755, files 0644 |
| 3 | `/etc/tg/config.json`, `/etc/tg/denylist.json` | dir `root:tg 0750`, files `root:tg 0640` |
| 4 | `/var/lib/tg` (session, state, lock) | `tg:tg 0700` |
| 5 | `/etc/sudoers.d/tg`, checked with `visudo -c` | `root:root 0440` |
| 6 | `/usr/local/sbin/tg-admin` | `root:root 0755` |
| 7 | first run: login, then the denylist prompt | session in `/var/lib/tg` |

The sudoers file holds one rule:

```
Defaults>tg env_reset, !env_keep, always_set_home, !setenv
<agent-user> ALL=(tg) NOPASSWD: /usr/bin/node /usr/local/lib/tg/cli.mjs *
```

`env_reset` and `!env_keep` drop your environment. There is no `SETENV`, so
`sudo -E` and `VAR=x sudo …` are refused. The CLI also refuses to start with
`NODE_OPTIONS` set, with any node flag, or as root.

## Deny people

The install prompt covers the first list. To add more later, or if you
skipped the prompt (the CLI refuses to run while the denylist has no users):

```sh
sudo tg-admin deny-add 123456789 987654321 --note "reason, root-only"
```

`deny-add` looks the users up in your dialogs and contacts. It saves their
access hash and their names (as redact terms) in `/etc/tg/denylist.json`.
It prints only counts. If a user is not found, it says so. Without an access
hash, tg cannot check supergroup membership for that user. Every
supergroup is then hidden, unless you list it in `allowChats`.

Other admin verbs:

```sh
sudo tg-admin deny-remove 123456789
sudo tg-admin deny-chat -1001234567890   # always deny a chat (marked id)
sudo tg-admin status
sudo tg-admin logout                     # then end the session in the app
sudo tg-admin login                      # create a new session after logout
```

`tg` keeps no copy of chats, but the tools that call it may. After a
`deny-add`, refresh them. For example, the BB Inbox drops the cards of
newly denied chats on its next complete sync ("Sync now").

To vouch for a supergroup whose member list is hidden, edit
`/etc/tg/denylist.json` as root and add its marked id to `allowChats`.
Proof of a denied member still wins over `allowChats`.

## In the Telegram app

- **Nothing is required for denied chats.** The filter hides them wherever
  they are. Optional hardening: archiving and muting a denied chat means its
  newest message never even reaches the `tg` process memory (the only
  thing archiving changes; agents cannot read that memory either way).
- **Do not** turn on "Keep archived chats archived" (in the Archive, open its
  settings). `mark-read-archive` archives a chat; a new message must bring it back.

## After install

Run `sudo -k` to drop your cached sudo password. Then check that `<agent-user>` cannot get root without a password, and has
no other rule for `tg`:

```sh
sudo -l        # look for NOPASSWD: ALL or (tg) rules other than cli.mjs
```

If `<agent-user>` has passwordless root, agents have root too, and none of the
guarantees below hold.

## Settings in `/etc/tg/config.json`

| Key | Default | Meaning |
|---|---|---|
| `readOnly` | `false` | Blocks draft, mark-read, archive and send. |
| `allowSend` | `false` | Real sends. Callers may have their own send switch too. |
| `dailySendCap` | `20` | 0–20. The CLI counts sends in its own state. |
| `workUser` | `null` | Username of the account that `work-audit` checks and `invite-work-user` adds. Both work verbs are off while it or `workTitle` is unset. |
| `workTitle` | `null` | A word that work-chat titles contain, matched whole and in any case. |
| `allowWorkInvite` | `false` | Allows `invite-work-user`. |
| `dailyWorkInviteCap` | `0` | 0–10 per rolling 23 hours. Keep at 0 until each invite is operator-confirmed. |

## What it guarantees, and what it does not

Guaranteed, given the conditions above:

- No command `<agent-user>` can run prints a message, name, username, id or
  title of a denied person, or of a group that holds one.
- `<agent-user>` cannot read the session, the state, the denylist or the config.
- The session file never keeps a denied peer after a run ends.
- Only the listed Telegram methods can be called. No raw API, no update
  stream, no self-update, no login from the agent side.

Not guaranteed:

- **The Telegram session can read everything.** The boundary is the OS user
  `tg`. Root, or anyone who can change the installed code, can read all.
- **A new denied member is found late.** A group is checked when first seen
  and then every 24 hours. If a denied person joins a clean group, their
  messages are dropped as soon as one is seen. But the group's other messages
  can be shown until the next check or the first message that proves it.
- **Only machine-readable references are caught.** Forwards, mentions,
  service messages, reactions and replies by id are caught. A plain-text
  name is replaced only if it is in `redact`. A photo, a voice note, or a
  paraphrase ("my ex said…") is not caught.
- **The main folder still crosses the wire.** Unless a denied chat is
  archived (optional), Telegram sends its top message in the dialog list. It is
  dropped in the `tg` process memory before any cache, log or output;
  processes running as the agent user cannot read that memory.
- **Groups found from messages are cached briefly.** They are removed from
  the session file when the run ends.
- **Agents can use what the CLI allows.** Draft, mark read, archive, and
  send (if on) in chats that are not denied. The CLI caps sends per day.
- **Two system calls skip the filter.** mtcute sends `help.getNearestDc`
  and `updates.getState` itself. Neither returns chat content, and updates
  are off, so `updates.getState` is never sent.
- **Old copies.** The Telegram app, other devices, and backups are outside
  this tool. So is data that reached a calling tool before a person was
  denied: it stays wherever that tool stored it.
- **Sudo sees arguments.** Chat ids and draft or reply text are passed as
  arguments. They show in `/proc/<pid>/cmdline` while the command runs,
  and in the sudo log if your system logs full commands. They are never
  denied content, because denied chats are refused first.
