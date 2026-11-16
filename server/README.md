# Local API server

One OpenAI-compatible endpoint on `http://127.0.0.1:47821/v1` that the app points
at instead of a provider. It exists because the app needs three routes and most
gateways serve one:

| Route the app calls | What this server does |
|---|---|
| `POST /v1/chat/completions` | forwards to `UPSTREAM_BASE`, streaming untouched |
| `POST /v1/audio/transcriptions` | forwards to `STT_BASE` (or the same upstream) |
| `POST /v1/audio/speech` | forwards to `TTS_BASE`, if configured |
| `GET /v1/models` | forwards, so the model dropdown still fills |

**Any key works.** The key the app sends is ignored and replaced with the one in
`server/.env`, so a build can be handed out without a credential in it, and the
credential can be rotated without touching the app or the installer.

## Run it

```bat
start-api.cmd            :: starts hidden, prints the health line
stop-api.cmd             :: stops by PID from server\run\api.pid
install-autostart.cmd    :: start at every logon (HKCU Run, no admin)
```

Or double-click `server\glance-api.vbs` — that is the whole launcher. The `.cmd`
files exist only because they are easier to find in the repo root.

Nothing appears in the taskbar and no browser tab is involved: it is a headless
`node.exe` process. A tab opened on the port deliberately gets `{}` with a 404 —
no HTML, no title, no product name.

## Configure

`copy server\.env.example server\.env`, then fill in:

```ini
PORT=47821
UPSTREAM_BASE=https://api.example.com/v1
UPSTREAM_KEY=sk-...
STT_BASE=https://api.groq.com/openai/v1   # only when the chat gateway has no audio
STT_KEY=gsk_...
STT_MODEL=whisper-large-v3-turbo
```

`CHAT_MODEL` is optional and rewrites whatever model name the app sends — useful
when a gateway insists on its own spelling.

## Point the app at it

Settings → **Base URL** `http://127.0.0.1:47821/v1`, **API key** anything (say
`local`), **Chat model** whatever your upstream calls it. Transcription: leave
*Transcription base URL* blank — the server routes `/audio/transcriptions` to
`STT_BASE` itself.

## Verify

```bat
npm run probe:api
```

Starts a stub upstream and the server on a random port, then asserts: the app's
key never reaches the upstream, `CHAT_MODEL` rewrites the model, a multipart
transcription survives, the SSE stream passes through, and the port is not
browsable. No real key is needed.

## Limits, stated plainly

- **Local only.** Binds `127.0.0.1`; nothing outside this machine can reach it.
  Anything running as you can, which is the same trust boundary as the `.env`
  file itself.
- **It is a proxy, not a model.** The transcript still comes from whatever
  `STT_BASE` serves, and the answers from `UPSTREAM_BASE`. It cannot turn a
  gateway with no audio route into one that has audio — it lets you name a
  different provider for that route.
- **It does not hide the app.** Capture exclusion is the app's job; this process
  never touches a window.
