# @openai-oauth/core

[Docs](https://github.com/EvanZhouDev/openai-oauth#sdk-overview) | [GitHub](https://github.com/EvanZhouDev/openai-oauth) | [npm](https://www.npmjs.com/package/@openai-oauth/core)

Lowest-level OpenAI OAuth and OpenAI-compatible transport primitives.

```bash
npm i @openai-oauth/core
```

Most apps should use `openai-oauth`, `@openai-oauth/local`, `@openai-oauth/react`, `@openai-oauth/ai-sdk`, or `@openai-oauth/openai-client` instead.

## Package Notes

`@openai-oauth/core` is for advanced integrations and adapter authors.

Create an OpenAI-compatible transport from an explicit auth source:

```ts
import { createOpenAIOAuthTransport } from "@openai-oauth/core";

const transport = createOpenAIOAuthTransport({
	auth: async () => session,
});

const baseURL = transport.baseURL;
const fetch = transport.fetch;
```

The transport supports Responses, model discovery, image generation, multipart image editing, and authenticated Codex Realtime call creation. Client adapters build higher-level interfaces such as Chat Completions and the local OpenAI-compatible `/v1/realtime/calls` proxy on top.

Realtime helpers are platform-neutral. `createCodexRealtimeCall()` performs SDP call creation, while `connectCodexRealtime()` accepts an injected WebRTC peer connection from Node.js or a browser and exposes `appendAudio()`, `streamAudio()`, `sendText()`, PCM output events, transcript events, remote-track events, and lifecycle control. Speaking while the model is responding performs the same server-side barge-in as Codex Voice; `interrupt(firstSpeechChunk)` is an explicit alias for that first audio append. `connectCodexRealtimeBrowser()` is the optional DOM convenience layer.

Create an OAuth request:

```ts
import { createOpenAIOAuthRequest } from "@openai-oauth/core";

const request = await createOpenAIOAuthRequest({
	redirectUri: "https://app.example.com/auth/callback",
});
```

Core exports include:

- `createOpenAIOAuthTransport`
- `createOpenAIOAuthRequest`
- `exchangeOpenAIOAuthCode`
- `refreshOpenAIOAuthTokens`
- `OpenAIOAuth`
- `OpenAIOAuthSession`
- `SessionStore`

## More

[Learn more in the openai-oauth README.](https://github.com/EvanZhouDev/openai-oauth#sdk-overview)
