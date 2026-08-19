# Vigilant Eye — Local AI Service

Python service that reads camera streams, runs YOLO detection and person↔phone
association, and writes advisory events to the backend. It runs on the local
Windows machine/server; the web console never touches RTSP.

## Responsibilities

- Read active, AI-enabled cameras and enabled rules from the backend.
- Detect persons and mobile phones, associate them, and confirm over time.
- Write events (`suspicious_cheating_activity`, `possible_cheating_activity`,
  `mobile_phone_detected`) with structured evidence — never "confirmed cheating".
- Upload annotated snapshots to the private `snapshots` bucket.
- Publish AI heartbeats and truthful camera runtime state.
- Serve the annotated MJPEG stream consumed by the console's proxy.
- Optionally push Telegram alerts for definitive critical events.

It never writes NVR heartbeats and never claims recording state.

## Install (Windows, Python 3.11+)

```bat
cd ai-service
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
:: For GPU inference install a CUDA build of torch instead of the CPU wheel:
:: pip install torch --index-url https://download.pytorch.org/whl/cu121
copy .env.example .env
```

Fill in `.env`:

- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` — backend access (service role
  stays on this machine only).
- `AI_SERVICE_KEY` — shared secret; the web app sends it as `X-Service-Key`.
- `DEMO_VIDEO_PATH` — an MP4 to use while the console is in Demo mode.

Camera credentials go in `secrets/cameras.json` (git-ignored), keyed by camera
id or host/IP — see `secrets/cameras.example.json`. Set
`USE_SUPABASE_CAMERA_CREDENTIALS=true` to fall back to the service-role-only
`camera_credentials` table.

## Run

```bat
python run.py
```

Endpoints:

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /health` | none | liveness only, no operational detail |
| `GET /status` | `X-Service-Key` | cameras, FPS, queue depth, notification readiness |
| `GET /stream/{camera_id}` | `X-Service-Key` | annotated MJPEG, shared by all viewers |
| `GET /snapshot/{camera_id}` | `X-Service-Key` | latest annotated JPEG |

## Connect the console

1. In the console → Settings → **AI service URL**, set the origin the console
   itself can reach:
   - console opened on this same machine (`npm run dev`): `http://127.0.0.1:8000`
   - **published cloud app**: a public HTTPS tunnel that forwards to
     `127.0.0.1:8000`, e.g. `cloudflared tunnel --url http://127.0.0.1:8000`
     (or `ngrok http 8000`) and paste the resulting `https://…` URL.
     The Settings field states plainly when the value entered is private and
     therefore unreachable from the published app.
2. Store the same `AI_SERVICE_KEY` value as the web app's `AI_SERVICE_KEY`
   secret so `/status` and the MJPEG stream proxy can authenticate. The tunnel
   only ever exposes the AI service's own authenticated endpoints — camera
   credentials and RTSP URLs never leave this machine.
3. Enable the mobile phone rule and assign cameras.

The database heartbeat path is outbound from Python to the published web relay;
it does not require the cloud app to reach the laptop. Live `/status` and MJPEG
reads travel in the opposite direction: a published cloud app cannot reach
`127.0.0.1`, `.local` hostnames, or a private LAN address unless the AI service
is exposed through an operator-controlled reachable HTTPS endpoint. This does
not prevent camera heartbeat writes, but it does prevent cloud-side live stream
health and viewing.

At startup, the service logs a safe camera diagnostic for each configured row:
the discovered camera count, whether credentials were found (boolean only), and
whether OpenCV connected. Authenticated `GET /status` also reports these safe
facts plus the last generic capture error; it never returns a username,
password, or RTSP URL.

## Behaviour guarantees

- Event IDs are generated before any I/O; a backend outage queues the event in
  `state/queue.db` and retries. A duplicate insert is treated as success, so a
  human review decision is never reset.
- Camera `status`/`last_heartbeat_at` are written only from observed frames.
- Uncertain associations never name a person and are never critical.
- Logs are scrubbed: service-role keys, camera passwords, RTSP credentials and
  Telegram tokens can never reach a log line.

## Tests

```bat
python -m pytest
```

The suite covers association, temporal confirmation, event contract shape,
redaction, queue durability and notification safety — no camera, model weights
or network required.

Stabilization state verified after GitHub connection.