# Visko Orbis API developer guide

Orbis generates live video and audio. Your application joins a session, connects
to the stream, and sends prompts while generation continues. The API does not
return a finished video file for each request.

**API base URL:** `https://orbis-stable-tpu.visko.ai`

You need an API key issued by Visko. You do not need access to the service machine,
this repository, model weights, or the development frontend.

## Packages and prerequisites

There are two parts to integrating Orbis:

| Part | What you need |
| --- | --- |
| Admission: join, check status, leave | Any HTTP client: browser `fetch`, `curl`, or Python `requests` |
| Live video/audio and prompt commands | A WebRTC-capable browser and `@reactor-team/js-sdk@3.1.0` |

The JavaScript SDK handles the streaming connection, incoming media tracks, and
commands. It **does not handle Orbis admission**: your application calls `/join`
and polls `/status` before connecting with the returned Orbis session token.

For an existing browser app:

```bash
npm install --save-exact @reactor-team/js-sdk@3.1.0
# Or, if your app uses pnpm instead:
pnpm add --save-exact @reactor-team/js-sdk@3.1.0
```

SDK version 3.1.0 declares React 18 or 19 as a peer dependency. Keep a compatible
React installation even if you use the SDK's `Reactor` class without its React
components. A bundler must also serve the SDK's WebAssembly assets. The complete
example below supplies a browser build setup; a bare import in an unbundled HTML
page is insufficient.

There is no published Orbis-specific client package required by this guide.
Examples use the publicly installable SDK directly and ordinary HTTP requests.
HTTP-only clients do not receive video/audio. The JavaScript streaming example
runs in the browser; installing the package in a Node.js script does not provide
a browser's WebRTC and media playback APIs.

Use HTTPS for a deployed app, or `http://localhost` for local development. Allow
outgoing WebRTC connectivity from the caller's network. Browser requests to the
API are supported from arbitrary origins, using headers rather than cookies.

## Authentication and session lifecycle

1. Call `POST /join` with `X-Orbis-API-Key: <api_key>`.
2. Save `session_token` from the response.
3. If `status` is `waiting`, poll `GET /status` every 1–2 seconds with
   `Authorization: Bearer <session_token>`.
4. When `status` is `active`, connect the SDK within **30 seconds**, passing the
   same session token to `connect()`.
5. Send `start` with the initial prompt. Receive media and send prompt updates
   over the established connection.
6. Call `POST /leave` to cancel waiting or end the active session, and clean up
   the browser connection and media element.

**No application heartbeat requests are required.** Queue polling stops on
admission. You may check status during streaming to detect expiry, but this does
not keep the session alive or extend its lifetime.

API keys and session tokens are secrets. Do not send them in URLs, write them to
logs, or embed a shared API key in a public JavaScript build. A user-facing app
can ask each user for their own key. If your application uses a shared key, keep
it on your application's server and handle admission there; return only the
admitted session's token to the browser for streaming. Never expose the shared
key through a public environment variable.

The service currently admits **one user at a time**, with up to 50 waiting
tickets by default. Repeated joins with the same API key reuse its outstanding
ticket; they do not create independent sessions. Use separate keys for separate
users. Joining again does not extend a ticket's existing deadline.

Waiting tickets remain until cancellation or admission. An admitted ticket
expires if it does not connect within its 30-second window. Connected sessions
are currently configured to last at most **300 seconds (5 minutes)**, measured from creation of
the streaming session. Read `session_seconds` for the configured limit. Prompt
updates, pausing, and polling do not extend it. After expiry or release, join
again for a new ticket and token.

## HTTP reference

All paths are relative to the API base URL. Join and leave have no required
request body.

| Method | Path | Authentication | Result |
| --- | --- | --- | --- |
| GET | `/ready` | None | `{ "status": "ready" }`, or `warming`, `busy`, `unavailable` |
| POST | `/join` | `X-Orbis-API-Key` | Create or retrieve your ticket |
| GET | `/status` | Bearer session token | Current ticket status and deadlines |
| POST | `/leave` | Bearer session token | `{ "status": "released" }` |

A join/status response looks like this:

```json
{
  "session_token": "<opaque_session_token>",
  "status": "waiting",
  "position": 1,
  "waiting_count": 1,
  "session_seconds": 300,
  "expires_in": null
}
```

| Field | Meaning |
| --- | --- |
| `session_token` | Credential for your admission ticket and streaming session |
| `status` | `waiting`, `active`, or `releasing` |
| `position` | Queue position starting at 1; 0 when active/releasing |
| `waiting_count` | Number waiting, excluding the active user |
| `session_seconds` | Maximum streaming-session lifetime, in seconds |
| `expires_in` | Remaining admission/session deadline in seconds; null while waiting |

A `releasing` ticket cannot connect. Its token may already return `401` from
`/status` while cleanup completes. A busy or warming service can accept waiting
tickets. `/ready` is informational: always use your ticket's status to decide
whether you may connect.

```bash
export ORBIS_API_URL=https://orbis-stable-tpu.visko.ai
# Set ORBIS_API_KEY privately in your caller's environment.
curl "$ORBIS_API_URL/ready"
curl -X POST "$ORBIS_API_URL/join" \
  -H "X-Orbis-API-Key: $ORBIS_API_KEY"

# Set this to session_token from the join response.
export ORBIS_SESSION_TOKEN="<session_token>"
curl "$ORBIS_API_URL/status" \
  -H "Authorization: Bearer $ORBIS_SESSION_TOKEN"
curl -X POST "$ORBIS_API_URL/leave" \
  -H "Authorization: Bearer $ORBIS_SESSION_TOKEN"
```

`/leave` ends the active session or cancels waiting. No additional server-side
stop command is required. The token becomes invalid immediately. Release may
be followed by a short cleanup period before the next user is admitted.
Retry a leave request if it fails due to a network error; `401` means the token
is already invalid. Close your browser connection and detach playback resources
after release. The SDK's `disconnect()` also attempts session teardown; following
an explicit leave, its authentication/session error can be treated as expected
cleanup. Present a single Leave action to your users.

## Build a browser application from scratch

This example creates a small Next.js application in **your own project**. It
requires Node.js 22.20 or newer in the Node.js 22 release line and npm. Next.js
and React are example application dependencies, not requirements of the HTTP API.

```bash
mkdir orbis-api-demo
cd orbis-api-demo
npm init -y
npm install --save-exact next@15.5.9 react@19.1.0 react-dom@19.1.0 \
  @reactor-team/js-sdk@3.1.0
npm pkg set 'scripts.dev=next dev --turbopack' \
  'scripts.build=next build --turbopack' 'scripts.start=next start'
mkdir app
```

Create `app/layout.js`:

```jsx
export default function RootLayout({ children }) {
  return <html lang="en"><body>{children}</body></html>;
}
```

Create `app/page.js`. This is a complete client page; no source files from the
Orbis service repository are needed.

```jsx
"use client";

import { useEffect, useRef, useState } from "react";
import { Reactor } from "@reactor-team/js-sdk";

const API_URL = "https://orbis-stable-tpu.visko.ai";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function request(path, options = {}) {
  const response = await fetch(`${API_URL}${path}`, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`${response.status}: ${data.error || data.detail || response.statusText}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

export default function OrbisDemo() {
  const [apiKey, setApiKey] = useState("");
  const [prompt, setPrompt] = useState("A fox walking through a snowy forest.");
  const [status, setStatus] = useState("Disconnected");
  const [error, setError] = useState("");
  const [joined, setJoined] = useState(false);
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const active = useRef(null);
  const video = useRef(null);

  // One Leave operation cancels waiting or ends streaming.
  async function leave(run = active.current) {
    if (!run) return;
    if (run.closing) return run.closing;
    run.cancelled = true;
    setConnected(false);
    setStatus("Leaving…");
    run.closing = (async () => {
      // If Join is in flight, obtain its token so cancellation cannot orphan it.
      await run.joining.catch(() => {});
      try {
        if (run.token) {
          try {
            await request("/leave", {
              method: "POST",
              headers: { Authorization: `Bearer ${run.token}` },
              keepalive: true,
            });
          } catch (err) {
            if (err.status !== 401) throw err;
          }
        }
      } finally {
        // /leave already invalidated the token; teardown errors are expected.
        await run.transport?.disconnect().catch(() => {});
        if (active.current === run && video.current) video.current.srcObject = null;
      }
      if (active.current === run) {
        active.current = null;
        setJoined(false);
        setPaused(false);
        setStatus("Disconnected");
      }
    })();
    try {
      await run.closing;
    } catch (err) {
      setError(String(err));
      setStatus("Release not confirmed; press Leave to retry");
      run.closing = null;
    }
  }

  useEffect(() => () => {
    // Best effort only. Prefer the explicit Leave button over closing a tab.
    void leave(active.current);
  }, []);

  async function joinAndStart() {
    if (active.current || !apiKey.trim() || !prompt.trim()) return;
    setError("");
    setJoined(true);
    setStatus("Joining…");
    const run = { cancelled: false, token: null, transport: null, closing: null };
    active.current = run;
    run.joining = request("/join", {
      method: "POST", headers: { "X-Orbis-API-Key": apiKey.trim() },
    }).then(ticket => { run.token = ticket.session_token; return ticket; });

    try {
      let ticket = await run.joining;
      const headers = { Authorization: `Bearer ${run.token}` };
      while (!run.cancelled && ticket.status === "waiting") {
        setStatus(`Waiting: position ${ticket.position}`);
        await sleep(1000);
        if (!run.cancelled) ticket = await request("/status", { headers });
      }
      if (run.cancelled) return;
      if (ticket.status !== "active") throw new Error("Session is no longer available");
      setStatus("Admitted; connecting…");

      const transport = new Reactor({
        apiUrl: API_URL,
        modelName: "orbis-tpu", // Use this connection identifier for this API.
        local: false,
      });
      run.transport = transport;
      const media = new MediaStream();
      transport.on("trackReceived", (_name, track) => {
        if (run.cancelled || !video.current) return;
        media.addTrack(track);
        video.current.srcObject = media;
        void video.current.play().catch(() => {
          setStatus("Press Play on the video to enable playback/audio");
        });
      });
      transport.on("error", err => {
        if (!run.cancelled) setError(err.message);
      });
      transport.on("statusChanged", value => {
        if (run.cancelled) return;
        setStatus(`Stream: ${value}`);
        if (value === "disconnected") setConnected(false);
      });
      // Pass the admitted session token, not the original API key.
      await transport.connect(run.token);
      if (run.cancelled) return;
      await transport.sendCommand("start", { prompt });
      setConnected(true);
    } catch (err) {
      if (!run.cancelled) setError(String(err));
      await leave(run);
    }
  }

  async function updatePrompt() {
    await active.current?.transport?.sendCommand("set_prompt", { prompt });
  }

  async function togglePause() {
    await active.current?.transport?.sendCommand("set_paused", { paused: !paused });
    setPaused(!paused);
  }

  return (
    <main style={{ maxWidth: 960, margin: "2rem auto" }}>
      <h1>Orbis live demo</h1>
      <label>API key <input type="password" autoComplete="off" value={apiKey}
        disabled={joined} onChange={e => setApiKey(e.target.value)} /></label>
      <p><textarea rows={5} style={{ width: "100%" }} value={prompt}
        onChange={e => setPrompt(e.target.value)} /></p>
      <button disabled={joined || !apiKey.trim() || !prompt.trim()}
        onClick={() => void joinAndStart()}>Join and start</button>
      <button disabled={!joined} onClick={() => void leave()}>Leave</button>
      <button disabled={!connected || !prompt.trim()}
        onClick={() => void updatePrompt()}>Update prompt</button>
      <button disabled={!connected} onClick={() => void togglePause()}>
        {paused ? "Resume" : "Pause"}
      </button>
      <p role="status">{status}</p>
      {error && <p role="alert">{error}</p>}
      <video ref={video} autoPlay playsInline controls style={{ width: "100%" }} />
    </main>
  );
}
```

Start your app:

```bash
npm run dev -- --hostname 127.0.0.1
```

Open `http://localhost:3000`, enter your API key and prompt, and select **Join and
start**. While waiting, **Leave** cancels the ticket. Once connected, update the
prompt or pause/resume without creating a new session. Keys remain in component
memory; this example does not persist them in browser storage.

The SDK reports command failures through its `error` event. In version 3.1.0,
`sendCommand()` can resolve without throwing even when the command fails, so
listen for errors rather than treating every resolved promise as success. For a
production UI, use command acknowledgements/state updates to confirm controls.
The example displays SDK errors and lets users release a failed session.

On expiry or network disconnection, release any remaining ticket and join again
for a new token. Do not repeatedly reconnect with an expired token. For reliable
navigation cleanup, call Leave before changing pages; tab-close cleanup alone
cannot guarantee that the request reaches the service.

## Streaming commands and media

After admission, configure `Reactor` with `apiUrl` set to the base URL,
`modelName: "orbis-tpu"`, and `local: false`. Register media and error handlers
before calling `connect(sessionToken)`. Send `start` only after it resolves.
The SDK manages signalling; you do not need to construct SDP or ICE messages.

```javascript
// transport is the connected Reactor instance from your application.
await transport.sendCommand("start", { prompt: "A dancer on an outdoor stage." });
await transport.sendCommand("set_prompt", { prompt: "The dancer begins spinning." });
await transport.sendCommand("set_paused", { paused: true });
await transport.sendCommand("set_paused", { paused: false });
```

| Command | Payload | Effect |
| --- | --- | --- |
| `start` | `{ "prompt": "..." }` | Begin continuous generation |
| `set_prompt` | `{ "prompt": "..." }` | Steer subsequent chunks without resetting history |
| `set_paused` | `{ "paused": true }` or `false` | Pause/resume generation and playback |
| `stop` | `{}` | Stop generation; use `/leave` to release the session |

Prompts must be nonempty. No application-level character or word limit is
imposed on user prompts. Already buffered chunks retain their previous prompt;
updates may take a moment to appear. Send commands over the stream, not as
request bodies to `/join` or `/status`.

Incoming tracks are named `main_video` and `main_audio`. Add both to a
`MediaStream` attached to a `<video>` element, as in the example. Current output
is 1920×1080 (1080p) with mono audio transported at 48 kHz. HTTPS carries API
calls and signalling; WebRTC carries media and stream commands.

## HTTP-only Python example

Python applications can manage admission with `requests`. Media playback still
requires a WebRTC-capable integration; `requests` cannot receive the live tracks.

```bash
python -m pip install requests
# Set ORBIS_API_KEY privately in your caller's environment.
```

```python
import os
import requests

api_url = "https://orbis-stable-tpu.visko.ai"
response = requests.post(
    f"{api_url}/join",
    headers={"X-Orbis-API-Key": os.environ["ORBIS_API_KEY"]},
    timeout=15,
)
response.raise_for_status()
ticket = response.json()
headers = {"Authorization": f"Bearer {ticket['session_token']}"}
try:
    # Repeat every 1–2 seconds while waiting; pass the token to your
    # streaming client when active, within the connection window.
    response = requests.get(f"{api_url}/status", headers=headers, timeout=15)
    response.raise_for_status()
    print(response.json()["status"])
finally:
    # This HTTP-only example cancels its ticket rather than opening a stream.
    response = requests.post(f"{api_url}/leave", headers=headers, timeout=15)
    if response.status_code != 401:
        response.raise_for_status()
```

## Errors and troubleshooting

| Response/symptom | Meaning or action |
| --- | --- |
| 401 | Invalid API key or invalid/released/expired session token; check the credential type |
| 409 with `code: "queued"` | Wait for admission before connecting |
| 429 with `code: "queue_full"` | All waiting places are occupied; retry later |
| 503 | Service unavailable; retry later or contact Visko |
| HTTP succeeds but media does not | Inspect SDK errors and browser WebRTC/ICE connectivity; HTTPS alone does not establish media connectivity |
| WebAssembly file fails to load | Ensure your bundler deploys the SDK's assets; check browser network errors and Content Security Policy |
| Video plays but audio is silent | Check mute controls and press Play to satisfy browser autoplay policy |
| Queue does not advance | Check `/ready` and `/status`; an earlier session may be finishing cleanup |

For support, provide timestamps, HTTP status/error codes, and browser console
errors with credentials removed. Do not send API keys or session tokens in
support logs.
