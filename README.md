# Orbis Studio

A public sample app for Orbis running on TPUs, built with React + TypeScript and the public Orbis API. Describe a scene, join the queue, watch live video and audio, and steer the scene.

See the [Orbis API developer guide](orbis_api_usage.md) for authentication, session lifecycle, streaming commands, and troubleshooting.

## Run locally

Use Node.js 22.20+ (or a newer supported Node release).

```sh
npm install
npm run dev
```

Open the localhost URL printed by Vite (normally http://127.0.0.1:5173). Enter your own Orbis API key and select **Start creating**. Unmute the player to hear audio. No `.env` file or backend is needed: the documented API supports browser origins, and each user supplies their own key.

## Create a video

1. Enter a prompt and your API key. The app joins Orbis and polls every 1.5 seconds while queued.
2. After admission, it connects using the session token and `@reactor-team/js-sdk@3.1.0`.
3. Change the prompt and select **Update scene**, or pause/resume generation. Prompt changes affect upcoming video; buffered content may take a moment to catch up.
4. Select **Leave** to end the session or cancel your queue position. Failed release requests are retried; if all retries fail, select Leave again.

The API delivers a continuous live stream, not a rendered video file. Preview pause controls affect playback; the app's Pause button sends a generation command.

Keys and session tokens stay in memory, never in URLs, logs, or browser storage. Do not embed a shared key in a public build. A shared-key deployment needs server-side admission.

## Verify and build

```sh
npm test
npm run build
npm run preview
```

Deploy `dist/` to an HTTPS static host. Vite emits the SDK's WebAssembly asset alongside the JavaScript. The app uses the API URL from `src/session.ts`; there is no configurable redirect for credentials.

Tests exercise queue admission, authentication headers, cancellation while joining/connecting, release retries, and already-expired tokens. Full streaming verification requires a valid Orbis API key, service availability, and browser WebRTC connectivity. Browser autoplay can require pressing Play; the live preview starts muted. The player shows the returned session limit while waiting and a countdown after connection, using `expires_in` from an immediate status check and updates every 15 seconds. The countdown continues while paused and highlights the final minute. The pre-connection admission deadline is not used as the streaming duration. Session status is checked every 15 seconds to detect expiry; this does not keep a session alive. Tab-close cleanup is best effort; always use Leave.

The UI observes the SDK's error event because `sendCommand()` may resolve after an error. Pause/resume labels reflect a successful command request, not independently verified model state. Output dimensions and frame rate shown in the UI are the service specifications in the supplied guide, not measured stream statistics.
