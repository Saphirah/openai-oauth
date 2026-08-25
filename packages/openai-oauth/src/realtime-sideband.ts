import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"
import {
	createCodexDelegationContextEvents,
	type OpenAIOAuthSession,
	parseCodexFramelessEvent,
} from "@openai-oauth/core"
import WebSocket, { type RawData, WebSocketServer } from "ws"
import type { RealtimeToolDispatcher } from "./realtime-tool-dispatcher.js"

const DEFAULT_SIDEBAND_BASE_URL = "wss://api.openai.com/v1/live"
const REGISTRATION_TTL_MS = 60_000
const INITIAL_CONNECT_ATTEMPTS = 5
const RECONNECT_BASE_DELAY_MS = 200
const RECONNECT_MAX_DELAY_MS = 5_000

const SIDEBAND_CONNECTED_EVENT = "openai_oauth.sideband.connected"
const SIDEBAND_ERROR_EVENT = "openai_oauth.sideband.error"
const TOOL_STARTED_EVENT = "openai_oauth.tool.started"
const TOOL_COMPLETED_EVENT = "openai_oauth.tool.completed"

type Registration = {
	callId: string
	sessionId: string
	attestationHeader?: string
	expiresAt: number
}

export type CodexRealtimeSidebandOptions = {
	getSession: () => Promise<OpenAIOAuthSession | null>
	codexVersion?: string
	baseURL?: string
	toolDispatcher?: RealtimeToolDispatcher
}

const isLoopback = (address: string | undefined): boolean =>
	address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1"

const closeCode = (code: number): number =>
	code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000

const delay = (attempt: number): Promise<void> =>
	new Promise((resolve) =>
		setTimeout(
			resolve,
			Math.min(
				RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1),
				RECONNECT_MAX_DELAY_MS,
			),
		),
	)

const localStatus = (browser: WebSocket, value: Record<string, unknown>) => {
	if (browser.readyState === WebSocket.OPEN) browser.send(JSON.stringify(value))
}

export class CodexRealtimeSideband {
	private readonly registrations = new Map<string, Registration>()
	private readonly server = new WebSocketServer({ noServer: true })

	constructor(private readonly options: CodexRealtimeSidebandOptions) {}

	register(
		callId: string,
		sessionId: string,
		attestationHeader?: string,
	): string {
		this.prune()
		const token = globalThis.crypto.randomUUID()
		this.registrations.set(token, {
			callId,
			sessionId,
			...(attestationHeader ? { attestationHeader } : {}),
			expiresAt: Date.now() + REGISTRATION_TTL_MS,
		})
		return `/v1/realtime/sideband/${token}`
	}

	handleUpgrade(
		request: IncomingMessage,
		socket: Duplex,
		head: Buffer,
	): boolean {
		const path = new URL(request.url ?? "/", "http://localhost").pathname
		const match = path.match(/^\/v1\/realtime\/sideband\/([^/]+)$/)
		if (!match) return false
		if (!isLoopback(request.socket.remoteAddress)) {
			socket.destroy()
			return true
		}
		const token = match[1] ?? ""
		const registration = this.registrations.get(token)
		this.registrations.delete(token)
		if (!registration || registration.expiresAt <= Date.now()) {
			this.rejectUpgrade(
				socket,
				404,
				"Realtime sideband registration not found.",
			)
			return true
		}
		this.server.handleUpgrade(request, socket, head, (browser) => {
			void this.run(browser, registration)
		})
		return true
	}

	close(): void {
		this.registrations.clear()
		for (const client of this.server.clients) client.terminate()
		this.server.close()
	}

	private async run(
		browser: WebSocket,
		registration: Registration,
	): Promise<void> {
		let upstream: WebSocket | undefined
		let browserClosed = false
		let everConnected = false
		let rapidFailures = 0
		let latestClientInput = ""
		const pending: Array<{ data: RawData; binary: boolean }> = []
		const handledHandoffs = new Set<string>()
		const sendUpstream = (data: string) => {
			if (upstream?.readyState === WebSocket.OPEN) upstream.send(data)
			else pending.push({ data: Buffer.from(data), binary: false })
		}
		const appendDelegationText = (
			delegationItemId: string,
			text: string,
			channel: "commentary" | "speakable",
		) => {
			if (!text) return
			for (const event of createCodexDelegationContextEvents(
				delegationItemId,
				text,
				channel,
			)) {
				sendUpstream(JSON.stringify(event))
			}
		}
		const handleToolHandoff = (data: RawData, binary: boolean) => {
			if (binary || !this.options.toolDispatcher) return
			let value: unknown
			try {
				value = JSON.parse(data.toString())
			} catch {
				return
			}
			const event = parseCodexFramelessEvent(value)
			if (event?.kind !== "handoff" || handledHandoffs.has(event.handoffId)) {
				return
			}
			handledHandoffs.add(event.handoffId)
			const handoffInput = event.inputTranscript.trim() || latestClientInput
			latestClientInput = ""
			localStatus(browser, {
				type: TOOL_STARTED_EVENT,
				call_id: event.handoffId,
				input: handoffInput,
			})
			void this.options.toolDispatcher
				.dispatch({
					callId: event.handoffId,
					input: handoffInput,
					reportProgress: (text) =>
						appendDelegationText(event.handoffId, text, "commentary"),
				})
				.then((result) => {
					appendDelegationText(event.handoffId, result.output, "speakable")
					localStatus(browser, {
						type: TOOL_COMPLETED_EVENT,
						call_id: result.callId,
						name: result.name,
						ok: result.ok,
						output: result.output,
					})
				})
		}

		browser.on("message", (data, binary) => {
			if (!binary) {
				try {
					const event = JSON.parse(data.toString())
					if (
						event?.type === "session.context.append" &&
						Array.isArray(event.content)
					) {
						latestClientInput = event.content
							.filter(
								(item: unknown) =>
									typeof item === "object" &&
									item !== null &&
									"type" in item &&
									item.type === "input_text" &&
									"text" in item &&
									typeof item.text === "string",
							)
							.map((item: { text: string }) => item.text)
							.join("")
					}
				} catch {}
			}
			if (upstream?.readyState === WebSocket.OPEN) {
				upstream.send(data, { binary })
			} else {
				pending.push({ data, binary })
			}
		})
		browser.on("close", () => {
			browserClosed = true
			if (upstream?.readyState === WebSocket.OPEN) upstream.close(1000)
			else if (upstream?.readyState === WebSocket.CONNECTING)
				upstream.terminate()
		})

		while (!browserClosed) {
			let auth: OpenAIOAuthSession | null
			try {
				auth = await this.options.getSession()
			} catch {
				auth = null
			}
			if (!auth) {
				localStatus(browser, {
					type: SIDEBAND_ERROR_EVENT,
					message: "OpenAI OAuth session not found.",
				})
				browser.close(1011, "OAuth session not found")
				return
			}

			const headers: Record<string, string> = {
				Authorization: `Bearer ${auth.accessToken}`,
				"chatgpt-account-id": auth.accountId,
				"openai-alpha": "quicksilver=v2",
				"x-session-id": registration.sessionId,
				originator: "codex_cli_rs",
				"user-agent": `codex_cli_rs/${this.options.codexVersion ?? "0.0.0"}`,
			}
			if (registration.attestationHeader) {
				headers["x-oai-attestation"] = registration.attestationHeader
			}
			const base = (this.options.baseURL ?? DEFAULT_SIDEBAND_BASE_URL).replace(
				/\/$/,
				"",
			)
			const outcome = await new Promise<
				| { kind: "closed"; code: number; reason: string; connected: boolean }
				| { kind: "http"; status: number }
				| { kind: "error" }
			>((resolve) => {
				let connected = false
				let settled = false
				upstream = new WebSocket(
					`${base}/${encodeURIComponent(registration.callId)}`,
					{ headers },
				)
				upstream.once("open", () => {
					connected = true
					everConnected = true
					rapidFailures = 0
					localStatus(browser, {
						type: SIDEBAND_CONNECTED_EVENT,
						call_id: registration.callId,
					})
					for (const item of pending.splice(0)) {
						upstream?.send(item.data, { binary: item.binary })
					}
				})
				upstream.on("message", (data, binary) => {
					if (browser.readyState === WebSocket.OPEN)
						browser.send(data, { binary })
					handleToolHandoff(data, binary)
				})
				upstream.once("unexpected-response", (_request, response) => {
					settled = true
					upstream?.terminate()
					resolve({ kind: "http", status: response.statusCode ?? 0 })
				})
				upstream.once("error", () => {
					if (!settled) {
						settled = true
						resolve({ kind: "error" })
					}
				})
				upstream.once("close", (code, reason) => {
					if (!settled) {
						settled = true
						resolve({
							kind: "closed",
							code,
							reason: reason.toString(),
							connected,
						})
					}
				})
			})
			upstream = undefined
			if (browserClosed) return
			if (
				outcome.kind === "http" &&
				(outcome.status === 404 || outcome.status === 410)
			) {
				localStatus(browser, {
					type: SIDEBAND_ERROR_EVENT,
					message: `Realtime sideband session ended (${outcome.status}).`,
				})
				browser.close(1000, "Realtime session ended")
				return
			}
			if (
				outcome.kind === "closed" &&
				outcome.connected &&
				outcome.code === 1000
			) {
				browser.close(closeCode(outcome.code), outcome.reason)
				return
			}
			rapidFailures += 1
			if (!everConnected && rapidFailures >= INITIAL_CONNECT_ATTEMPTS) {
				localStatus(browser, {
					type: SIDEBAND_ERROR_EVENT,
					message: "Realtime sideband connection attempts were exhausted.",
				})
				browser.close(1011, "Realtime sideband failed")
				return
			}
			await delay(rapidFailures)
		}
	}

	private prune(): void {
		const now = Date.now()
		for (const [token, registration] of this.registrations) {
			if (registration.expiresAt <= now) this.registrations.delete(token)
		}
	}

	private rejectUpgrade(socket: Duplex, status: number, message: string): void {
		const body = Buffer.from(message)
		socket.write(
			`HTTP/1.1 ${status} Not Found\r\nConnection: close\r\nContent-Length: ${body.length}\r\n\r\n`,
		)
		socket.end(body)
	}
}
