# Slack

Mention the Cube bot in a Slack channel, or write to it directly, and the team answers in that
thread. In a thread the team is already in, people can go on without mentioning the bot again.
The request and the answer also appear in the `#slack` channel in Cube.

## Setting it up

1. At <https://api.slack.com/apps>, choose **Create New App > From a manifest** and paste the
   manifest that Settings > Models and agents > Slack copies for you.
2. Install the app to your workspace. Under **OAuth & Permissions**, copy the **Bot User OAuth
   Token** (`xoxb-…`).
3. Under **Basic Information > App-Level Tokens**, make a token with the `connections:write`
   scope (`xapp-…`).
4. Paste both tokens into Settings > Models and agents > Slack.
5. Invite the Cube bot to the channels where it should answer (`/invite @Cube`).

The manifest asks for `app_mentions:read` (hear mentions), `im:history` (hear direct messages
to the bot), `channels:history` and `groups:history` (hear replies in threads of channels the
bot was invited to), `chat:write` (answer), `files:write` (post a picture a cube had drawn) and
`users:read` (show who asked).

With the two history scopes Slack sends Cube every message of the channels the bot is in. Cube
drops all of them on arrival except replies inside a thread where someone already called the
team: a channel message outside a thread never reaches the cubes or the `#slack` channel. A
Slack app made from the earlier manifest (without those scopes) keeps working, answering
mentions and direct messages only; to change it, paste the current manifest under **App
Manifest**, save, and reinstall the app.

## How it works

- Cube connects out to Slack with Socket Mode, so nothing on your Mac has to be reachable from
  the internet. It works while Cube is open.
- The two tokens are kept in the macOS Keychain and used only by the Rust side of the app.
- A mention reaches the Router, the team's front desk. It answers general questions about Cube
  and the team itself, and otherwise says who it brings in (`@Writer 불러올게요!`); that cube
  then reads the asker's own words, not a restatement. A cube named in the message
  (`@Cube @Builder …` written as text) is used directly. Everything is posted in the thread,
  with the name of whoever wrote it on top.
- A reply in such a thread that does not mention the bot goes to the Router as well, which may
  decide that it wants no answer (people talking to each other, a thanks).
- Each Slack thread is its own conversation: a cube answering in one thread is shown that
  thread only and keeps a separate session for it, so what was said in a direct message or
  another channel does not carry over.
- Cubes called from Slack run with **ask-first** permission: they read and reply, and before
  one changes a file or runs a command you are asked in Cube. Rules you saved do not apply.
- What looks like a credential is hidden before an answer is posted, and Slack's reserved
  characters are escaped, so an answer cannot mention `@channel` or disguise a link.
- At most eight requests are started in five minutes per thread, and twenty-four in all.
- **Pictures.** When Codex is installed, a cube on any agent program can have a picture drawn: it
  ends its reply with `IMAGE: name.png | description`, Cube runs Codex's image tool with that
  description, saves the result under `pictures/` in the `#slack` folder, and posts it in the
  thread. This needs no OK from you, because the cube gets no permission from it: the only thing
  that runs is that one drawing command, in a folder of its own, and only a file that really is a
  picture is posted. Each picture spends your Codex allowance, so for people in Slack at most four
  are drawn in five minutes.

## Not there yet

- Answering channel messages outside a thread that do not mention the bot.
- Streaming an answer as it is written (the answer is posted when it is finished).
- Files: attachments in Slack are not read, and files a cube makes are not uploaded, except pictures drawn as described above.
- Running without Cube open.
