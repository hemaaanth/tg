# tg

A Telegram CLI for agents, with a denylist guard.

`tg` lets an AI agent, or any script, use your own Telegram account. It
lists chats, reads a thread, searches messages, saves a cloud draft, marks a
chat read and archives it, and (if you allow it) sends a capped number of
replies. Every command prints one JSON line.

It has one hard rule. People on a denylist, and every group they are in,
are never printed, cached or stored. The filter runs inside the RPC
middleware, before mtcute's peer cache or session storage see a response.
So you can give an agent your Telegram and still keep some people out of
its view.

The recommended setup runs `tg` as a separate system user that owns the
session. Your agents run as your normal account and can run exactly one
command as that user, so they cannot read the session or change the
denylist. See [setup/INSTALL.md](setup/INSTALL.md).

One example user is [BB](https://getbb.app): its `telegram` plugin calls `tg`
for the Inbox and for agent tools.

`tg` started as a fork of [gskril/telegram-cli](https://github.com/gskril/telegram-cli)
and has since been rewritten on [mtcute](https://github.com/mtcute/mtcute).
MIT licensed; see [LICENSE](LICENSE).

## Commands

All commands print one JSON line on stdout. Errors are
`{"ok":false,"error":{"code","message","until?","rpc?"}}` with a fixed
message per code.

```
cli.mjs status
cli.mjs sync --json [--since <cursor JSON>]
cli.mjs chats [--folder main|archive|all] [--query <text>] [--limit 1-100]
cli.mjs search --query <text> [--chat <chatId>] [--limit 1-50] [--cursor <cursor JSON>]
cli.mjs resolve <username>
cli.mjs chat <chatId>
cli.mjs read <chatId> [--limit 1-50] [--before <messageId>]
cli.mjs draft <chatId> --text <text> [--reply-to <messageId>]
cli.mjs mark-read-archive <chatId> --max-id <messageId>
cli.mjs send <chatId> --text <text> [--reply-to <messageId>]
cli.mjs whoami
cli.mjs work-audit
cli.mjs invite-work-user <chatId>
```

Chat ids are "marked": a user is `id`, a basic group is `-id`, a supergroup
is `-1000000000000 - id`.

Exit codes: 0 ok, 2 bad arguments, 3 wait (cooldown, budget, too soon),
4 refused by policy, 5 not logged in or bad config, 1 other.

### sync

Lists unread chats in the main folder (folder 0). Broadcast channels are
skipped. Each item:

```json
{
  "chatId": "123", "chatType": "user|group|supergroup", "title": "…",
  "username": null, "isBot": false, "unreadCount": 2, "unreadMentions": 0,
  "lastReadInboxMaxId": 40, "topMessageId": 42, "unchanged": false,
  "messages": [{ "id": 41, "date": "…", "out": false, "senderId": "123",
                 "sender": "…", "text": "…", "hasMedia": false,
                 "mediaType": null, "replyToId": null }]
}
```

The result also has `complete`, `cooldown`, `syncedAt` and `cursor`. Pass
`cursor` back as `--since`. Chats that did not change come back with
`unchanged: true` and no messages.

A chat is listed only if tg can show that no denied user is in it.
Groups it cannot check are left out.

### chats

Lists DMs, groups and supergroups in the main folder (default), the archive,
or both, newest first. It reads up to 500 dialogs per folder. `--query`
keeps chats whose title or username contains the text. Each item has
`chatId`, `chatType`, `title`, `username`, `isBot`, `folder`, `unreadCount`
and `lastMessage` (the same message shape as sync, or null). The result
also has `complete` and `cooldown`.

### search

Without `--chat`, searches every DM, group and supergroup. With `--chat`,
searches one chat that tg has already listed. Hits are newest first.
Each hit is a message plus `chatId`, `chatType` and `chatTitle`. Pass
`nextCursor` back as `--cursor` for the next page. Hits from broadcast
channels and Saved Messages are skipped.

### resolve

Finds one user or supergroup by its public username, with or without `@`.
It does not read the dialog list, so it also finds people you have never
written to. The result is `chat`: one item in the chats shape, or null.
`folder` is always `main` and `unreadCount` 0. `lastMessage` is the newest
message, read with one history call. Null means not found. A denied user, a
group with a denied member, a broadcast channel and a group you left also
give null, so they look the same. The result also has `complete` and
`cooldown`; `complete: false` with a null chat means the check could not
finish, not that nobody has the name.

### chat

Finds one chat by its marked id (for example `-4001234567`). The result is
`chat`: one item in the chats shape, or null, plus `complete` and
`cooldown` as in resolve. `folder`, `unreadCount` and `lastMessage` come
from one `messages.getPeerDialogs` call. A denied user or group, a group
with a denied member, a broadcast channel, a group you left and a chat you
are not in all give null. A user or supergroup needs its access hash from
the session's peer cache, so one this session has never seen (in a sync,
chats, search or resolve) also gives null. A basic group needs no hash.

These verbs check each chat the way sync does. A group seen for the first
time also has its last 20 messages read before it is shown, so a denied user
who wrote there or was added there hides it. Chats they show are remembered,
so the chat verbs below work on them without a sync.

### Work-chat audit and invitation

These two verbs are off until the config sets both `workUser` (a regular
Telegram account, such as your company's shared account) and `workTitle` (a
word that work-chat titles contain).

`work-audit` scans group and supergroup titles in the main and archive folders.
It returns titles that contain `workTitle` as a whole word, in any case, and
checks whether `workUser` is a member. It does not read message history
or return member lists. It pages until Telegram says each folder is finished,
at most once every two seconds. The first audit resolves that username and pins its
numeric Telegram identity in private state. Each result includes `lastActivityAt`
from the dialog's top-message metadata, without returning or reading its text.

`invite-work-user` accepts one recently audited chat id. It can invite only the
pinned `workUser` identity. It also needs `allowWorkInvite`, has a hard maximum of
ten invitations per rolling 23 hours, spaces all invitation methods by at least three
minutes, and is never automatically retried. Basic-group
invites use a history limit of zero. Telegram may still refuse an invite because
of permissions, privacy settings, flood limits, or account restrictions.

### Chat verbs

`read`, `draft`, `mark-read-archive` and `send` work only on chats that
sync, chats or search has listed. Denied, unknown and never-listed chats all give the same
`chat_unavailable` error. `send` also needs `allowSend` in the config, an
inbound message in the chat, and room under the daily cap (at most 20).

## How the filter works

1. **Method allowlist.** Each verb may call only its own Telegram methods.
2. **Request check.** A request that names a denied peer is refused.
3. **Probes.** Group membership is checked with `messages.getCommonChats`
   (daily), `messages.getFullChat` (basic groups) and
   `channels.getParticipant` (supergroups). Results are cached for 24 hours.
   Probe answers are replaced by small stubs, so the denied user never
   reaches the cache.
4. **Discovery.** A message from, naming, reacting or replying by a denied
   user marks its group denied.
5. **Scrub.** Denied users, chats and messages are removed. Forwards from
   denied users are dropped. Mentions are replaced with `[hidden]`. Only
   known message fields are kept.
6. **Storage guard.** The session storage refuses denied peers. Denied rows
   are purged when a run starts and ends. `secure_delete` is on.
7. **Output check.** The final JSON is redacted, then checked again. Any
   denied id or name left in it fails the run with `denied_content`.

Other rules: updates are off; there is no raw API verb; mtcute log lines
print only the level and tag; `FLOOD_WAIT` deadlines are persisted; one
instance at a time; per-method call budgets.

## Development

```sh
npm ci --ignore-scripts
npm run check   # typecheck
npm test        # fake Telegram, no network
npm run build   # dist/cli.mjs, dist/admin.mjs, wasm
```

The build bundles `@mtcute/core`, `@mtcute/wasm`, `@fuman/node` and
`@fuman/utils`, all MIT licensed.

The tests use a fake Telegram at the end of the middleware chain. They
check that denied ids and names never appear in stdout, the session file,
the peer cache, the state directory or the logs.
