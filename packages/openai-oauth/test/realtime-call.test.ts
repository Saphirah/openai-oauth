import type { OpenAIOAuthTransport } from "@openai-oauth/core"
import { describe, expect, test, vi } from "vitest"
import {
	createCodexRealtimeCallResponse,
	parseCodexRealtimeCallRequest,
} from "../src/index.js"

describe("Codex source-compatible realtime call", () => {
	test("parses an OpenAI-style call into the exact Frameless v3 session", async () => {
		const parsed = await parseCodexRealtimeCallRequest(
			new Request("http://localhost/v1/realtime/calls", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					sdp: "v=0\r\n",
					session_id: "session-1",
					session: {
						instructions: "Be concise.",
						audio: { output: { voice: "cove" } },
						initial_items: [
							{
								type: "message",
								role: "developer",
								content: [{ type: "input_text", text: "Context" }],
							},
						],
					},
				}),
			}),
		)
		expect(parsed).toEqual({
			sdp: "v=0\r\n",
			sessionId: "session-1",
			session: {
				model: "gpt-live-1-codex",
				instructions: "Be concise.",
				audio: { output: { voice: "cove" } },
				delegation: { type: "client" },
				initial_items: [
					{
						type: "message",
						role: "developer",
						content: [{ type: "input_text", text: "Context" }],
					},
				],
			},
		})
	})

	test("uses the Codex backend endpoint, headers, attestation, and JSON body", async () => {
		const request = vi.fn(async (path: string, init?: RequestInit) => {
			expect(path).toBe(
				"/v1/realtime/calls?intent=quicksilver&architecture=avas",
			)
			const headers = new Headers(init?.headers)
			expect(headers.get("openai-alpha")).toBe("quicksilver=v2")
			expect(headers.get("x-session-id")).toBe("session-1")
			expect(headers.get("originator")).toBe("codex_cli_rs")
			expect(headers.get("x-oai-attestation")).toBe(
				'{"v":1,"s":0,"t":"v1.host-token"}',
			)
			expect(JSON.parse(String(init?.body))).toEqual({
				sdp: "offer-sdp",
				session: {
					model: "gpt-live-1-codex",
					instructions: "",
					audio: { output: { voice: "cove" } },
					delegation: { type: "client" },
				},
			})
			return new Response("answer-sdp", {
				status: 201,
				headers: { location: "/v1/live/rtc_test" },
			})
		})
		const result = await createCodexRealtimeCallResponse(
			new Request("http://localhost/v1/realtime/calls", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sdp: "offer-sdp", session_id: "session-1" }),
			}),
			{ request } as unknown as OpenAIOAuthTransport,
			{
				codexVersion: "1.2.3",
				attestationProvider: async ({ sessionId }) => {
					expect(sessionId).toBe("session-1")
					return "v1.host-token"
				},
			},
		)
		expect(result.callId).toBe("rtc_test")
		expect(result.attestationHeader).toBe('{"v":1,"s":0,"t":"v1.host-token"}')
		expect(result.response.status).toBe(201)
		expect(result.response.headers.get("content-type")).toBe("application/sdp")
		expect(result.response.headers.get("x-openai-oauth-realtime-version")).toBe(
			"v3",
		)
		expect(await result.response.text()).toBe("answer-sdp")
	})

	test("rejects a successful upstream response without a call id", async () => {
		const result = await createCodexRealtimeCallResponse(
			new Request("http://localhost/v1/realtime/calls", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sdp: "offer-sdp" }),
			}),
			{
				request: async () => new Response("answer", { status: 200 }),
			} as unknown as OpenAIOAuthTransport,
		)
		expect(result.response.status).toBe(502)
		expect(await result.response.json()).toMatchObject({
			error: { type: "upstream_error" },
		})
	})

	test("rejects regular function tools instead of silently stripping them", async () => {
		const request = vi.fn()
		const result = await createCodexRealtimeCallResponse(
			new Request("http://localhost/v1/realtime/calls", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					sdp: "offer-sdp",
					session: {
						tools: [
							{
								type: "function",
								name: "add_numbers",
								description: "Add two numbers.",
								parameters: { type: "object" },
							},
						],
						tool_choice: "auto",
					},
				}),
			}),
			{ request } as unknown as OpenAIOAuthTransport,
		)

		expect(result.response.status).toBe(400)
		expect(await result.response.json()).toMatchObject({
			error: {
				message: expect.stringContaining("not supported by Codex Frameless v3"),
			},
		})
		expect(request).not.toHaveBeenCalled()
	})
})
