import { promises as fs } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
	createOpenAIOAuth,
	type OpenAIOAuthProvider,
} from "@openai-oauth/ai-sdk"
import {
	CODEX_REALTIME_REFERENCE_COMMIT,
	createOpenAIOAuthTransport,
	DEFAULT_CODEX_FRAMELESS_MODEL,
	type OpenAIOAuthTransport,
} from "@openai-oauth/core"
import { openaiCredentials } from "@openai-oauth/local"
import { handleAudioTranscriptionRequest } from "./audio-transcriptions.js"
import { handleChatCompletionsRequest } from "./chat-completions.js"
import {
	HostedInputFileStore,
	handleFileListRequest,
	handleFileRetrieveRequest,
	handleFileUploadRequest,
} from "./files.js"
import {
	handleImageEditRequest,
	handleImageGenerationRequest,
} from "./images.js"
import { createRequestLogger } from "./logging.js"
import { createModelResolver } from "./models.js"
import {
	type CodexRealtimeCallResult,
	createCodexRealtimeCallResponse,
} from "./realtime-call.js"
import { realtimeLabHtml } from "./realtime-lab-page.js"
import { realtimePitchWorkletSource } from "./realtime-pitch-worklet.js"
import { CodexRealtimeSideband } from "./realtime-sideband.js"
import { RealtimeToolDispatcher } from "./realtime-tool-dispatcher.js"
import { handleResponsesRequest } from "./responses.js"
import {
	DEFAULT_HOST,
	DEFAULT_PORT,
	resolveAddress,
	toErrorResponse,
	toJsonResponse,
	toWebRequest,
	writeWebResponse,
} from "./shared.js"
import type {
	OpenAIOAuthServerOptions,
	RunningOpenAIOAuthServer,
} from "./types.js"

const realtimeLabClientPath = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"realtime",
	"realtime-lab-client.js",
)

const realtimeLabResponse = (): Response =>
	new Response(realtimeLabHtml, {
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"content-security-policy":
				"default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'unsafe-inline'; connect-src 'self' ws: wss:; media-src 'self' blob:; img-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
		},
	})

const realtimeLabClientResponse = async (): Promise<Response> => {
	try {
		const source = await fs.readFile(realtimeLabClientPath)
		const body = source.buffer.slice(
			source.byteOffset,
			source.byteOffset + source.byteLength,
		) as ArrayBuffer
		return new Response(body, {
			headers: {
				"content-type": "text/javascript; charset=utf-8",
				"cache-control": "no-store",
			},
		})
	} catch {
		return toErrorResponse(
			"Realtime Lab client is not built. Run the openai-oauth build first.",
			503,
			"realtime_lab_not_built",
		)
	}
}

const realtimePitchWorkletResponse = (): Response =>
	new Response(realtimePitchWorkletSource, {
		headers: {
			"content-type": "text/javascript; charset=utf-8",
			"cache-control": "no-store",
		},
	})

const realtimeDiagnosticsResponse = (
	settings: OpenAIOAuthServerOptions,
): Response =>
	toJsonResponse({
		ok: true,
		protocol: "codex-frameless-v3",
		autoStart: false,
		referenceCommit: CODEX_REALTIME_REFERENCE_COMMIT,
		call: {
			localEndpoint: "/v1/realtime/calls",
			upstreamPath:
				"/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas",
			modelDefault: DEFAULT_CODEX_FRAMELESS_MODEL,
		},
		attestation: {
			hostProviderConfigured:
				typeof settings.realtimeAttestation === "function",
		},
		sideband: {
			localPath: "/v1/realtime/sideband/{localToken}",
			upstreamPath: "wss://api.openai.com/v1/live/{callId}",
		},
		tools: {
			configured: Boolean(settings.realtimeTools),
			names: settings.realtimeTools?.tools.map((tool) => tool.name) ?? [],
		},
		implementationPaths: {
			call: "packages/openai-oauth/src/realtime-call.ts",
			sideband: "packages/openai-oauth/src/realtime-sideband.ts",
			client: "packages/openai-oauth/src/realtime-lab-client.ts",
		},
		security: {
			browserReceivesOAuthTokens: false,
			browserReceivesAttestation: false,
		},
	})

const handleRoutes = async (
	request: Request,
	provider: OpenAIOAuthProvider,
	client: OpenAIOAuthTransport,
	fileStore: HostedInputFileStore,
	resolveModels: () => Promise<string[]>,
	requestLogger: ReturnType<typeof createRequestLogger>,
): Promise<Response> => {
	const url = new URL(request.url)
	if (request.method === "GET" && url.pathname === "/health") {
		return toJsonResponse({
			ok: true,
			replay_state: "stateless",
		})
	}

	if (request.method === "GET" && url.pathname === "/v1/models") {
		try {
			const models = await resolveModels()
			return toJsonResponse({
				object: "list",
				data: models.map((id) => ({
					id,
					object: "model",
					created: 0,
					owned_by: "codex-oauth",
				})),
			})
		} catch (error) {
			return toErrorResponse(
				error instanceof Error ? error.message : "Failed to load models.",
				502,
				"upstream_error",
			)
		}
	}

	if (url.pathname === "/v1/files") {
		if (request.method === "POST") {
			return handleFileUploadRequest(request, fileStore)
		}
		if (request.method === "GET") {
			return handleFileListRequest(fileStore)
		}
	}

	const fileMatch = url.pathname.match(/^\/v1\/files\/([^/]+)$/)
	if (request.method === "GET" && fileMatch?.[1]) {
		return handleFileRetrieveRequest(
			request,
			fileStore,
			decodeURIComponent(fileMatch[1]),
		)
	}

	if (request.method === "POST" && url.pathname === "/v1/responses") {
		return handleResponsesRequest(request, client, fileStore)
	}

	if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
		return handleChatCompletionsRequest(request, provider, requestLogger)
	}

	if (request.method === "POST" && url.pathname === "/v1/images/generations") {
		return handleImageGenerationRequest(request, client)
	}

	if (request.method === "POST" && url.pathname === "/v1/images/edits") {
		return handleImageEditRequest(request, client)
	}

	if (
		request.method === "POST" &&
		url.pathname === "/v1/audio/transcriptions"
	) {
		return handleAudioTranscriptionRequest(request, client)
	}

	return toErrorResponse("Route not found.", 404, "not_found_error")
}

const createOpenAIOAuthRuntime = (settings: OpenAIOAuthServerOptions = {}) => {
	const auth = openaiCredentials(settings)
	const sharedSettings = {
		...settings,
		auth: () => auth.getSession(),
		responsesState: false as const,
	}
	const client = createOpenAIOAuthTransport(sharedSettings)
	const provider = createOpenAIOAuth(client)
	const resolveModels = createModelResolver(client, settings.models)
	const requestLogger = createRequestLogger(settings)

	const fileStore = new HostedInputFileStore(client, settings.fetch)
	const handler = async (
		request: Request,
		onRealtimeCall?: (
			result: CodexRealtimeCallResult,
		) => Response | Promise<Response>,
	): Promise<Response> => {
		try {
			const url = new URL(request.url)
			if (
				request.method === "GET" &&
				(url.pathname === "/realtime" ||
					url.pathname === "/realtime/" ||
					url.pathname === "/realtime-prototype" ||
					url.pathname === "/realtime-prototype/")
			) {
				return realtimeLabResponse()
			}
			if (
				request.method === "GET" &&
				(url.pathname === "/realtime/client.js" ||
					url.pathname === "/realtime-prototype/client.js")
			) {
				return realtimeLabClientResponse()
			}
			if (
				request.method === "GET" &&
				url.pathname === "/realtime/pitch-worklet.js"
			) {
				return realtimePitchWorkletResponse()
			}
			if (
				request.method === "GET" &&
				url.pathname === "/v1/realtime/diagnostics"
			) {
				return realtimeDiagnosticsResponse(settings)
			}
			if (request.method === "POST" && url.pathname === "/v1/realtime/calls") {
				const result = await createCodexRealtimeCallResponse(request, client, {
					codexVersion: settings.codexVersion,
					attestationProvider: settings.realtimeAttestation,
				})
				return onRealtimeCall ? onRealtimeCall(result) : result.response
			}
			return await handleRoutes(
				request,
				provider,
				client,
				fileStore,
				resolveModels,
				requestLogger,
			)
		} catch (error) {
			return toErrorResponse(
				error instanceof Error ? error.message : "Unexpected server error.",
				500,
				"server_error",
			)
		}
	}

	return { handler, resolveModels, getSession: () => auth.getSession() }
}

export const createOpenAIOAuthFetchHandler = (
	settings: OpenAIOAuthServerOptions = {},
): ((request: Request) => Promise<Response>) =>
	createOpenAIOAuthRuntime(settings).handler

export const startOpenAIOAuthServer = async (
	settings: OpenAIOAuthServerOptions = {},
): Promise<RunningOpenAIOAuthServer> => {
	const host = settings.host ?? DEFAULT_HOST
	const port = settings.port ?? DEFAULT_PORT
	const runtime = createOpenAIOAuthRuntime(settings)
	const models = await runtime.resolveModels()
	const handler = runtime.handler
	const sideband = new CodexRealtimeSideband({
		getSession: runtime.getSession,
		codexVersion: settings.codexVersion,
		baseURL: settings.realtimeWebSocketBaseURL,
		toolDispatcher: settings.realtimeTools
			? new RealtimeToolDispatcher(settings.realtimeTools)
			: undefined,
	})
	const server = createServer(async (req, res) => {
		try {
			const request = await toWebRequest(req, { host, port })
			const response = await handler(request, (result) => {
				if (!result.response.ok || !result.callId) return result.response
				const headers = new Headers(result.response.headers)
				headers.set(
					"x-openai-oauth-realtime-sideband",
					sideband.register(
						result.callId,
						result.sessionId,
						result.attestationHeader,
					),
				)
				return new Response(result.response.body, {
					status: result.response.status,
					statusText: result.response.statusText,
					headers,
				})
			})
			await writeWebResponse(res, response)
		} catch (error) {
			if (res.headersSent || res.writableEnded) {
				res.destroy(error instanceof Error ? error : undefined)
				return
			}

			const message =
				error instanceof Error ? error.message : "Unexpected server error."
			await writeWebResponse(res, toErrorResponse(message, 500, "server_error"))
		}
	})
	server.on("upgrade", (request, socket, head) => {
		if (!sideband.handleUpgrade(request, socket, head)) socket.destroy()
	})

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject)
		server.listen(port, host, () => {
			server.off("error", reject)
			resolve()
		})
	})

	const address = resolveAddress(server.address() as AddressInfo, host)
	return {
		server,
		host: address.host,
		port: address.port,
		url: `http://${address.host}:${address.port}/v1`,
		models,
		close: () =>
			new Promise<void>((resolve, reject) => {
				sideband.close()
				server.close((error) => {
					if (error) {
						reject(error)
						return
					}

					resolve()
				})
			}),
	}
}
