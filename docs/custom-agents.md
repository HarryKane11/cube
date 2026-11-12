# Connecting your own agent to Cube

Any program that takes a request and prints a reply can power a role in Cube. You describe it in a
small JSON file, and Cube starts it once per request in the conversation's folder.

## 1. Describe the program

Put one file per agent in `~/CubeSpaces/.agents/`, for example `~/CubeSpaces/.agents/mine.json`:

```json
{
  "name": "My agent",
  "program": "my-agent",
  "args": ["run", "--model", "{model}", "{prompt}"],
  "resumeArgs": ["--session", "{session}"],
  "protocol": "text",
  "stdin": false
}
```

| Field | Meaning |
|---|---|
| `name` | Shown in Cube. Defaults to the file name. |
| `program` | What to run. Found on your login shell's `PATH`, or give a full path. |
| `args` | Arguments for every run. `{prompt}`, `{session}`, `{model}` and `{trust}` are replaced. |
| `resumeArgs` | Added only when Cube has a session id from an earlier run in the same conversation. |
| `protocol` | `"text"` (default) or `"cube"`. See below. |
| `stdin` | `true` to also receive the request as a JSON line on standard input. |

The request must reach the program somewhere: `{prompt}` in `args`, or `"stdin": true`.

Cube runs the program with the conversation folder as its working directory. Files it creates or
changes there show up on the Stage. `{trust}` is one of `ask`, `edits`, `auto`, `free`, `plan`:
how much the person lets this role do without asking. Honoring it is the program's job.

Then open a role's profile in Cube, pick **Custom** under *Agent program*, and choose your agent.
Cube reads the folder when it starts and when you open Settings.

## 2a. The `text` protocol

Everything the program prints to standard output is the reply. To keep memory between requests,
print a line `session_id: <id>` at any point; Cube hands the id back through `{session}` and
`resumeArgs` next time. A non-zero exit code marks the run as failed, with the last lines of
standard error as the reason.

## 2b. The `cube` protocol

The program prints one JSON object per line. Lines that are not one of these are ignored.

| Line | Meaning |
|---|---|
| `{"t":"session","id":"…"}` | The id to resume this conversation with. |
| `{"t":"delta","text":"…"}` | More of the reply. Send as many as you like; they are joined. |
| `{"t":"activity","kind":"run","label":"Running the tests","cmd":"pnpm test"}` | What the agent is doing now. `kind` is `think`, `read`, `edit`, `run`, `search` or `other`. `cmd` is optional. |
| `{"t":"file","path":"/abs/path"}` | The agent is writing this file. Lets Cube show who made it, and warn when two agents change the same file. |
| `{"t":"shot","url":"data:image/png;base64,…","label":"Browser"}` | A picture of what the agent is looking at. Only `data:image/…` URLs are accepted. |
| `{"t":"ask","id":"1","tool":"Bash","input":{"command":"rm -rf build"}}` | Ask the person before doing something. The program must wait for the answer. |
| `{"t":"usage","in":1200,"out":80,"cost":0.01}` | Tokens read and written, and the price in US dollars, if known. |
| `{"t":"error","message":"…"}` | The run failed. |
| `{"t":"end"}` | The turn is over. Cube closes the program's input; exit after this. |

For `ask`, use the tool names Cube already knows how to word, so the person sees a clear card and
can give a lasting rule: `Bash` with `{"command"}`, `Write` or `Edit` with `{"file_path"}`,
`WebFetch` with `{"url"}`, `WebSearch` with `{"query"}`, and `AskUserQuestion` with
`{"questions":[{"question":"…","options":[{"label":"…","description":"…"}],"multiSelect":false}]}`
to put a question to the person. Any other name is shown as it is.

With `"stdin": true`, Cube writes these lines to the program's standard input:

| Line | Meaning |
|---|---|
| `{"t":"prompt","text":"…","session":null,"model":null,"effort":null,"trust":"edits"}` | The request, first. |
| `{"t":"answer","id":"1","allow":true,"input":{…}}` | The person's answer to an `ask`. For a question, `input.answers` maps each question's text to the answer. |

When the person stops the run, Cube ends the program and everything it started.

## A complete example

`~/CubeSpaces/.agents/echo.json`:

```json
{ "name": "Echo", "program": "python3", "args": ["/Users/me/echo_agent.py"], "protocol": "cube", "stdin": true }
```

`/Users/me/echo_agent.py`:

```python
import json, sys

def say(**event):
    print(json.dumps(event), flush=True)

request = json.loads(sys.stdin.readline())
say(t="activity", kind="think", label="Thinking it over")
say(t="ask", id="1", tool="Bash", input={"command": "date"})
answer = json.loads(sys.stdin.readline())
say(t="delta", text="You allowed it. " if answer["allow"] else "You said no. ")
say(t="delta", text=f"You asked: {request['text'][-80:]}")
say(t="end")
```
