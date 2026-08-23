# openai-oauth

[Docs](https://github.com/EvanZhouDev/openai-oauth#dev-proxy) | [GitHub](https://github.com/EvanZhouDev/openai-oauth) | [npm](https://www.npmjs.com/package/openai-oauth)

Turn your ChatGPT account into an OpenAI-compatible local API.

```bash
> npx openai-oauth

OpenAI-compatible endpoint ready at http://127.0.0.1:10531/v1
Use this as your OpenAI base URL. No API key is required.
Available Models: gpt-5.6-sol, gpt-5.6-terra, gpt-image-2, ...

[d] Run in background  [q] Quit
```

Press `d` to keep it running in the background or `q` to quit. You can also manage it directly:

```bash
npx openai-oauth --detach
npx openai-oauth status
npx openai-oauth logs --follow
npx openai-oauth stop
```

## Package Notes

`openai-oauth` exposes an OpenAI-compatible local endpoint backed by your ChatGPT account.

Supported endpoints:

- `/v1/responses`
- `/v1/chat/completions`
- `/v1/files`
- `/v1/images/generations`
- `/v1/images/edits`
- `/v1/audio/transcriptions`
- `/v1/realtime/calls`
- `/v1/models`

PDFs and other supported documents can be uploaded with the standard OpenAI Files API and passed to Responses by file ID. The upload is stored through ChatGPT OAuth and resolved to a signed file URL before the model request; no Platform API key is needed.

```ts
import fs from "node:fs";
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:10531/v1",
  apiKey: "unused",
});
const file = await client.files.create({
  file: fs.createReadStream("report.pdf"),
  purpose: "user_data",
});
const response = await client.responses.create({
  model: "gpt-5.6-terra",
  input: [{
    role: "user",
    content: [
      { type: "input_file", file_id: file.id },
      { type: "input_text", text: "Summarize this PDF." },
    ],
  }],
});
```

Image generation uses JSON requests. Image editing uses the standard OpenAI multipart request with one or more `image` fields. Both return base64 image data and usage metadata.

Audio transcription accepts the standard multipart `file` and `model` fields and forwards the file to ChatGPT's dedicated OAuth transcription backend—the same path used by Codex dictation. The required `model` field accepts `whisper-1`, `gpt-4o-transcribe`, or `gpt-4o-mini-transcribe` for client compatibility; the ChatGPT backend chooses its model. FLAC, WAV, MP3, M4A/MP4, WebM, and OGG inputs up to 50 MiB are supported. The `json` (default) and `text` response formats are available. Optional `language` and `prompt` fields are validated but are not forwarded by the ChatGPT OAuth path.

```bash
curl http://127.0.0.1:10531/v1/audio/transcriptions \
  -F file=@recording.mp3 \
  -F model=whisper-1
```

Realtime voice uses the OpenAI-compatible WebRTC call-creation shape. The proxy converts the public `realtime` session to the current Codex Frameless Bidi / Quicksilver v2 session and returns the SDP answer and upstream `Location` call ID. Media and realtime events flow directly over the resulting peer connection.

```bash
curl http://127.0.0.1:10531/v1/realtime/calls \
  -F "sdp=<offer.sdp;type=application/sdp" \
  -F 'session={"type":"realtime","audio":{"output":{"voice":"cove"}}};type=application/json'
```

Codex Frameless selects its model when `model` is omitted; neither the client nor the local proxy injects one. Explicit Codex realtime models are still forwarded. The remaining defaults are signed 16-bit little-endian mono 24 kHz PCM and voice `cove`.

Backend and browser clients can use the exported helpers:

- `createCodexRealtimeCall()` performs only authenticated SDP call creation.
- `connectCodexRealtime()` accepts any injected browser or Node.js WebRTC peer connection. It exposes raw PCM input/output, transcript events, text input, natural speech interruption, and lifecycle controls without depending on a particular microphone, speaker, or WebRTC package.
- `connectCodexRealtimeBrowser()` optionally handles browser microphone capture and audio playback.

For backend audio, pass any `AsyncIterable` of 24 kHz mono PCM16 chunks—including a Node.js `Readable`—to `connection.streamAudio(source)`, or call `appendAudio(chunk)` yourself. Consume decoded output chunks with `onAudio`; each event contains a `Uint8Array`, sample rate, and channel count. Streaming speech while the assistant is talking performs server-side barge-in. `interrupt(firstSpeechChunk)` names that operation explicitly; Frameless has no separate cancel command.

This transport establishes realtime speech-to-speech. Reproducing Codex task delegation additionally requires an application-side agent controller.

```bash
curl http://127.0.0.1:10531/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-image-2","prompt":"A tiny house in a forest","quality":"low"}'
```

Common flags:

| Config | Flag | Default |
| --- | --- | --- |
| Host binding | `--host` | `127.0.0.1` |
| Port | `--port` | `10531` |
| Model allowlist | `--models` | Account-specific Codex models discovered from ChatGPT |
| Auth file path | `--oauth-file` | `$CODEX_HOME/auth.json` or `~/.codex/auth.json` |
| Open browser | `--open` / `--no-open` | `--open` |
| Login timeout | `--login-timeout-ms` | `300000` |

Binding `--host` beyond loopback exposes the proxy to your network. Anyone who can reach that port can make requests with your ChatGPT account.

Login listens on loopback and uses `http://localhost:1455/auth/callback`, the local callback URL accepted by OpenAI OAuth.

The CLI resolves the latest published Codex client version automatically. Advanced flags also exist for overriding it, the upstream Codex base URL, OAuth client id, and OAuth token URL.

## More

[Learn more in the openai-oauth README.](https://github.com/EvanZhouDev/openai-oauth#readme)
