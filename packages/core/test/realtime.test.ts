import { describe, expect, test } from "vitest"
import {
	type CodexRealtimeDataChannel,
	type CodexRealtimePeerConnection,
	type CodexRealtimeWebSocket,
	connectCodexRealtime,
	createCodexRealtimeCall,
} from "../src/index.js"

class EventTargetFake {
	private readonly listeners = new Map<
		string,
		Array<(event: unknown) => void>
	>()
	addEventListener(type: string, listener: (event: unknown) => void): void {
		const listeners = this.listeners.get(type) ?? []
		listeners.push(listener)
		this.listeners.set(type, listeners)
	}
	emit(type: string, event: unknown = {}): void {
		for (const listener of this.listeners.get(type) ?? []) listener(event)
	}
}

class FakeDataChannel
	extends EventTargetFake
	implements CodexRealtimeDataChannel
{
	readyState = "connecting"
	readonly sent: string[] = []
	send(data: string): void {
		this.sent.push(data)
	}
	close(): void {
		this.readyState = "closed"
	}
}

class FakePeer extends EventTargetFake implements CodexRealtimePeerConnection {
	localDescription: { sdp?: string | null } | null = null
	connectionState = "new"
	readonly channel = new FakeDataChannel()
	readonly remoteDescriptions: unknown[] = []
	createDataChannel(): CodexRealtimeDataChannel {
		return this.channel
	}
	async createOffer(): Promise<unknown> {
		return { type: "offer", sdp: "offer-sdp" }
	}
	async setLocalDescription(description: unknown): Promise<void> {
		this.localDescription = description as { sdp?: string | null }
	}
	async setRemoteDescription(description: unknown): Promise<void> {
		this.remoteDescriptions.push(description)
	}
	addTransceiver(): unknown {
		return undefined
	}
	close(): void {
		this.connectionState = "closed"
	}
}

class FakeWebSocket extends EventTargetFake implements CodexRealtimeWebSocket {
	readyState = 0
	readonly sent: string[] = []
	send(data: string): void {
		this.sent.push(data)
	}
	close(): void {
		this.readyState = 3
	}
	open(): void {
		this.readyState = 1
		this.emit("open")
	}
	message(value: unknown): void {
		this.emit("message", { data: JSON.stringify(value) })
	}
}

describe("Codex realtime WebRTC orchestration", () => {
	test("resolves a relative call endpoint before constructing the sideband URL", async () => {
		const requests: string[] = []
		const call = await createCodexRealtimeCall("v=0\r\n", {
			endpoint: "/v1/realtime/calls",
			fetch: async (input) => {
				requests.push(String(input))
				return new Response("v=0\r\n", {
					headers: {
						"x-openai-oauth-realtime-call-id": "rtc_relative",
						"x-openai-oauth-realtime-sideband": "/v1/realtime/sideband/token",
					},
				})
			},
		})

		expect(requests).toEqual(["http://127.0.0.1:10531/v1/realtime/calls"])
		expect(call.sidebandUrl).toBe(
			"ws://127.0.0.1:10531/v1/realtime/sideband/token",
		)
	})

	test("waits for the authenticated upstream sideband before flushing control events", async () => {
		const peer = new FakePeer()
		const sideband = new FakeWebSocket()
		const events: unknown[] = []
		const connection = await connectCodexRealtime({
			peerConnection: peer,
			endpoint: "http://127.0.0.1:10531/v1/realtime/calls",
			fetch: async (_input, init) => {
				expect(JSON.parse(String(init?.body))).toMatchObject({
					sdp: "offer-sdp",
					session: { model: "gpt-live-1-codex" },
				})
				return new Response("answer-sdp", {
					status: 201,
					headers: {
						location: "/v1/live/rtc_browser",
						"x-openai-oauth-realtime-sideband": "/v1/realtime/sideband/token",
					},
				})
			},
			webSocket: () => sideband,
			onEvent: (event) => events.push(event),
		})

		sideband.open()
		connection.sendText("Hello")
		expect(sideband.sent).toEqual([])
		sideband.message({
			type: "openai_oauth.sideband.connected",
			call_id: "rtc_browser",
		})
		await connection.ready
		expect(sideband.sent.map((value) => JSON.parse(value))).toEqual([
			{
				type: "session.context.append",
				content: [{ type: "input_text", text: "Hello" }],
			},
		])
		sideband.message({
			type: "output_transcript.added",
			item: { text: "Hi" },
		})
		expect(events).toHaveLength(1)
		expect(events[0]).toMatchObject({
			kind: "transcript",
			role: "assistant",
			text: "Hi",
		})
		expect(peer.remoteDescriptions).toEqual([
			{ type: "answer", sdp: "answer-sdp" },
		])
		connection.close()
	})
})
