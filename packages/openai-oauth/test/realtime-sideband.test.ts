import { promises as fs } from "node:fs"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test, vi } from "vitest"
import WebSocket, { WebSocketServer } from "ws"
import { startOpenAIOAuthServer } from "../src/index.js"

const temporaryRoots: string[] = []

const authFile = async (): Promise<string> => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-realtime-"))
	temporaryRoots.push(root)
	const filename = path.join(root, "auth.json")
	await fs.writeFile(
		filename,
		JSON.stringify({
			tokens: { access_token: "access-token", account_id: "account-1" },
		}),
	)
	return filename
}

afterEach(async () => {
	await Promise.all(
		temporaryRoots
			.splice(0)
			.map((root) => fs.rm(root, { recursive: true, force: true })),
	)
})

describe("Codex Frameless sideband relay", () => {
	test("joins /v1/live/{call_id} with Codex headers and relays events", async () => {
		const upstreamHttp = createServer()
		const upstreamWs = new WebSocketServer({ server: upstreamHttp })
		await new Promise<void>((resolve) =>
			upstreamHttp.listen(0, "127.0.0.1", resolve),
		)
		const address = upstreamHttp.address()
		if (!address || typeof address === "string") throw new Error("No address")

		let handshake: Record<string, string | undefined> | undefined
		let relayed: unknown
		const upstreamConnected = new Promise<void>((resolve) => {
			upstreamWs.once("connection", (socket, request) => {
				handshake = {
					url: request.url,
					authorization: request.headers.authorization,
					account: request.headers["chatgpt-account-id"] as string | undefined,
					alpha: request.headers["openai-alpha"] as string | undefined,
					session: request.headers["x-session-id"] as string | undefined,
					attestation: request.headers["x-oai-attestation"] as
						| string
						| undefined,
					thread: request.headers["thread-id"] as string | undefined,
				}
				socket.once("message", (data) => {
					relayed = JSON.parse(data.toString())
					socket.send(
						JSON.stringify({
							type: "output_transcript.added",
							item: { text: "Ready" },
						}),
					)
				})
				resolve()
			})
		})

		const oauth = await startOpenAIOAuthServer({
			host: "127.0.0.1",
			port: 0,
			models: ["gpt-5.2"],
			authFilePath: await authFile(),
			ensureFresh: false,
			codexVersion: "9.8.7",
			realtimeAttestation: async () => "v1.host-token",
			realtimeWebSocketBaseURL: `ws://127.0.0.1:${address.port}/v1/live`,
			fetch: async (input, init) => {
				expect(String(input)).toBe(
					"https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas",
				)
				expect(new Headers(init?.headers).get("x-oai-attestation")).toBe(
					'{"v":1,"s":0,"t":"v1.host-token"}',
				)
				return new Response("answer-sdp", {
					status: 201,
					headers: { location: "/v1/live/rtc_sideband_test" },
				})
			},
		})

		try {
			const call = await fetch(`${oauth.url}/realtime/calls`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					sdp: "offer-sdp",
					session_id: "session-test",
					session: { audio: { output: { voice: "cove" } } },
				}),
			})
			expect(call.status).toBe(201)
			const sidebandPath = call.headers.get("x-openai-oauth-realtime-sideband")
			expect(sidebandPath).toMatch(/^\/v1\/realtime\/sideband\//)
			if (!sidebandPath) throw new Error("Missing sideband path")
			const url = new URL(sidebandPath, oauth.url)
			url.protocol = "ws:"
			const browser = new WebSocket(url)
			const connectedStatus = await new Promise<unknown>((resolve, reject) => {
				browser.once("message", (data) => resolve(JSON.parse(data.toString())))
				browser.once("error", reject)
			})
			expect(connectedStatus).toEqual({
				type: "openai_oauth.sideband.connected",
				call_id: "rtc_sideband_test",
			})
			await upstreamConnected
			expect(handshake).toEqual({
				url: "/v1/live/rtc_sideband_test",
				authorization: "Bearer access-token",
				account: "account-1",
				alpha: "quicksilver=v2",
				session: "session-test",
				attestation: '{"v":1,"s":0,"t":"v1.host-token"}',
				thread: undefined,
			})

			browser.send(
				JSON.stringify({
					type: "session.context.append",
					content: [{ type: "input_text", text: "Hello" }],
				}),
			)
			const event = await new Promise<unknown>((resolve) =>
				browser.once("message", (data) => resolve(JSON.parse(data.toString()))),
			)
			expect(relayed).toMatchObject({ type: "session.context.append" })
			expect(event).toEqual({
				type: "output_transcript.added",
				item: { text: "Ready" },
			})
			browser.close()
		} finally {
			await oauth.close()
			await new Promise<void>((resolve) =>
				upstreamWs.close(() => upstreamHttp.close(() => resolve())),
			)
		}
	})

	test("dispatches native delegation through a generic tool backend and appends its result", async () => {
		const upstreamHttp = createServer()
		const upstreamWs = new WebSocketServer({ server: upstreamHttp })
		await new Promise<void>((resolve) =>
			upstreamHttp.listen(0, "127.0.0.1", resolve),
		)
		const address = upstreamHttp.address()
		if (!address || typeof address === "string") throw new Error("No address")

		const appended = new Promise<Record<string, unknown>>((resolve) => {
			upstreamWs.once("connection", (socket) => {
				socket.on("message", (data) => {
					const event = JSON.parse(data.toString())
					if (event.type === "session.context.append") {
						socket.send(
							JSON.stringify({
								type: "delegation.created",
								item: {
									id: "delegation-tool-1",
									type: "delegation",
									target: "client",
									content: [],
								},
							}),
						)
					}
					if (event.type === "delegation.context.append") resolve(event)
				})
			})
		})
		const execute = vi.fn(async (argumentsValue: unknown) => ({
			room: (argumentsValue as { room: string }).room,
			state: "on",
		}))
		const selectTool = vi.fn(async () => ({
			name: "set_light",
			arguments: { room: "kitchen" },
		}))
		const oauth = await startOpenAIOAuthServer({
			host: "127.0.0.1",
			port: 0,
			models: ["gpt-5.2"],
			authFilePath: await authFile(),
			ensureFresh: false,
			realtimeWebSocketBaseURL: `ws://127.0.0.1:${address.port}/v1/live`,
			realtimeTools: {
				tools: [
					{
						name: "set_light",
						description: "Set a room light.",
						parameters: {
							type: "object",
							properties: { room: { type: "string" } },
							required: ["room"],
							additionalProperties: false,
						},
						execute,
					},
				],
				selectTool,
			},
			fetch: async () =>
				new Response("answer-sdp", {
					status: 201,
					headers: { location: "/v1/live/rtc_tool_test" },
				}),
		})

		try {
			const call = await fetch(`${oauth.url}/realtime/calls`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					sdp: "offer-sdp",
					session_id: "session-tool-test",
				}),
			})
			const sidebandPath = call.headers.get("x-openai-oauth-realtime-sideband")
			if (!sidebandPath) throw new Error("Missing sideband path")
			const url = new URL(sidebandPath, oauth.url)
			url.protocol = "ws:"
			const browser = new WebSocket(url)
			await new Promise<void>((resolve) => browser.once("open", resolve))
			browser.send(
				JSON.stringify({
					type: "session.context.append",
					content: [{ type: "input_text", text: "Turn on the kitchen light" }],
				}),
			)

			const resultEvent = await appended
			expect(resultEvent).toEqual({
				type: "delegation.context.append",
				delegation_item_id: "delegation-tool-1",
				channel: "speakable",
				content: [
					{
						type: "input_text",
						text: 'Tool set_light completed.\n{"room":"kitchen","state":"on"}',
					},
				],
			})
			expect(selectTool).toHaveBeenCalledWith(
				expect.objectContaining({
					callId: "delegation-tool-1",
					input: "Turn on the kitchen light",
				}),
			)
			expect(execute).toHaveBeenCalledTimes(1)
			browser.close()
		} finally {
			await oauth.close()
			await new Promise<void>((resolve) =>
				upstreamWs.close(() => upstreamHttp.close(() => resolve())),
			)
		}
	})
})
