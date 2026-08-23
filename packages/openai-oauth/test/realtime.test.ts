import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test, vi } from "vitest"
import { createOpenAIOAuthFetchHandler } from "../src/index.js"

const authRoots: string[] = []

const createAuthFile = async (): Promise<string> => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "openai-oauth-realtime-"),
	)
	authRoots.push(root)
	const authPath = path.join(root, "auth.json")
	await fs.writeFile(
		authPath,
		JSON.stringify({
			tokens: {
				access_token: "access-token",
				account_id: "acct-1",
			},
		}),
		"utf-8",
	)
	return authPath
}

afterEach(async () => {
	vi.restoreAllMocks()
	await Promise.all(
		authRoots.splice(0).map((root) =>
			fs.rm(root, {
				recursive: true,
				force: true,
			}),
		),
	)
})

describe("realtime calls", () => {
	test("creates a Codex WebRTC call from the OpenAI multipart shape", async () => {
		const authFilePath = await createAuthFile()
		let upstreamBody: Record<string, unknown> | undefined
		const fetch = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe(
					"https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas",
				)
				const headers = new Headers(init?.headers)
				expect(headers.get("authorization")).toBe("Bearer access-token")
				expect(headers.get("chatgpt-account-id")).toBe("acct-1")
				expect(headers.get("openai-alpha")).toBe("quicksilver=v2")
				expect(headers.get("originator")).toBe("codex_cli_rs")
				expect(headers.get("x-session-id")).toBe("voice-session")
				expect(headers.get("session-id")).toBe("voice-session")
				expect(headers.get("thread-id")).toBe("voice-session")
				upstreamBody = JSON.parse(String(init?.body))
				return new Response("v=0\r\ns=answer\r\n", {
					status: 201,
					headers: {
						"Content-Type": "application/sdp",
						Location: "/v1/realtime/calls/rtc_voice_1",
					},
				})
			},
		)
		const handler = createOpenAIOAuthFetchHandler({
			authFilePath,
			ensureFresh: false,
			fetch,
		})
		const form = new FormData()
		form.set(
			"sdp",
			new Blob(["v=0\r\ns=offer\r\n"], { type: "application/sdp" }),
			"offer.sdp",
		)
		form.set(
			"session",
			new Blob(
				[
					JSON.stringify({
						id: "voice-session",
						type: "realtime",
						model: "gpt-realtime",
						instructions: "Answer briefly.",
						audio: { output: { voice: "cove" } },
					}),
				],
				{ type: "application/json" },
			),
			"session.json",
		)

		const response = await handler(
			new Request("http://localhost/v1/realtime/calls", {
				method: "POST",
				body: form,
			}),
		)

		expect(response.status).toBe(201)
		expect(response.headers.get("content-type")).toBe("application/sdp")
		expect(response.headers.get("location")).toBe(
			"/v1/realtime/calls/rtc_voice_1",
		)
		await expect(response.text()).resolves.toBe("v=0\r\ns=answer\r\n")
		expect(upstreamBody).toEqual({
			sdp: "v=0\r\ns=offer\r\n",
			session: {
				instructions: "Answer briefly.",
				audio: {
					output: { voice: "cove" },
				},
				delegation: { type: "client", ack_filler: false },
			},
		})
	})

	test("applies Codex realtime defaults to a JSON call request", async () => {
		const authFilePath = await createAuthFile()
		let upstreamBody: Record<string, unknown> | undefined
		const handler = createOpenAIOAuthFetchHandler({
			authFilePath,
			ensureFresh: false,
			fetch: async (_input, init) => {
				upstreamBody = JSON.parse(String(init?.body))
				return new Response("answer", {
					status: 201,
					headers: { Location: "/v1/realtime/calls/rtc_default" },
				})
			},
		})

		const response = await handler(
			new Request("http://localhost/v1/realtime/calls", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ sdp: "v=0\r\n" }),
			}),
		)

		expect(response.status).toBe(201)
		expect(upstreamBody).toMatchObject({
			sdp: "v=0\r\n",
			session: {
				instructions: "",
				audio: {
					output: { voice: "cove" },
				},
				delegation: { type: "client", ack_filler: false },
			},
		})
		expect(upstreamBody?.session).not.toHaveProperty("model")
	})

	test("preserves an explicitly configured Codex realtime model", async () => {
		const authFilePath = await createAuthFile()
		let upstreamBody: Record<string, unknown> | undefined
		const handler = createOpenAIOAuthFetchHandler({
			authFilePath,
			ensureFresh: false,
			fetch: async (_input, init) => {
				upstreamBody = JSON.parse(String(init?.body))
				return new Response("answer", { status: 201 })
			},
		})

		const response = await handler(
			new Request("http://localhost/v1/realtime/calls", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					sdp: "v=0\r\n",
					session: {
						model: "gpt-live-1-boulder-alpha",
						audio: { output: { voice: "cove" } },
					},
				}),
			}),
		)

		expect(response.status).toBe(201)
		expect(upstreamBody).toMatchObject({
			sdp: "v=0\r\n",
			session: {
				model: "gpt-live-1-boulder-alpha",
				audio: { output: { voice: "cove" } },
			},
		})
	})

	test("rejects voices that Codex Frameless realtime does not support", async () => {
		const authFilePath = await createAuthFile()
		const fetch = vi.fn()
		const handler = createOpenAIOAuthFetchHandler({
			authFilePath,
			ensureFresh: false,
			fetch,
		})

		const response = await handler(
			new Request("http://localhost/v1/realtime/calls", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					sdp: "v=0\r\n",
					session: { audio: { output: { voice: "marin" } } },
				}),
			}),
		)

		expect(response.status).toBe(400)
		await expect(response.json()).resolves.toEqual({
			error: {
				message:
					"Realtime voice `marin` is not supported by Codex Frameless realtime.",
				type: "invalid_request_error",
			},
		})
		expect(fetch).not.toHaveBeenCalled()
	})
})
