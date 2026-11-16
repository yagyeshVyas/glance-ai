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

## Local transcription (no key)

`STT_LOCAL=1` — the default — answers `/audio/transcriptions` on this machine
with faster-whisper, so a gateway with no audio route, or no key at all, still
produces a transcript. Install once:

```bat
server\install-stt.cmd
```

It installs `faster-whisper` and downloads `base.en` (~145 MB, cached under
`%USERPROFILE%\.cache\huggingface`). Chunks are decoded with ffmpeg to 16 kHz
mono and transcribed on the CPU: roughly 0.6–1.0 s for a 4-second chunk once the
model is warm, because one worker keeps it loaded between chunks instead of
reloading per request.

Measured on this machine, a synthesized sentence posted to the endpoint:

```json
{"text":"Hello, this is a test of the transcription model. The answer should be four words.","ms":853}
```

and through the whole app path — speakers → loopback → 4 s chunk → local server:

```
[Nov 16, 11:24 AM] Them: hello this is a test of the transcription
[Nov 16, 11:24 AM] Them: sunglasses? The answer should be four words. Hello.
```

Accuracy is `base.en` on 4-second chunks: words get clipped at chunk edges and
two voices at once blur together (that second line also carried a video playing
underneath). `STT_MODEL=small.en` costs about 4× the time and reads better.
`STT_LOCAL=0` goes back to proxying `STT_BASE`.

Requirements: Python 3 on PATH (or `PYTHON=` in `.env`) and ffmpeg on PATH. If
either is missing the endpoint answers 502 with the reason instead of silence.

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
