import { describe, expect, test, vi } from "vitest"
import {
	type CodexRealtimeDataChannel,
	type CodexRealtimePeerConnection,
	connectCodexRealtime,
	createCodexRealtimeCall,
	createCodexRealtimeSession,
	parseCodexRealtimeTranscriptEvent,
} from "../src/index.js"

class FakeDataChannel implements CodexRealtimeDataChannel {
	readyState = "connecting"
	sent: string[] = []
	private readonly listeners = new Map<string, Set<(event: unknown) => void>>()

	send(data: string): void {
		this.sent.push(data)
	}

	close(): void {
		this.readyState = "closed"
		this.emit("close", {})
	}

	addEventListener(type: string, listener: (event: unknown) => void): void {
		const listeners = this.listeners.get(type) ?? new Set()
		listeners.add(listener)
		this.listeners.set(type, listeners)
	}

	removeEventListener(type: string, listener: (event: unknown) => void): void {
		this.listeners.get(type)?.delete(listener)
	}

	open(): void {
		this.readyState = "open"
		this.emit("open", {})
	}

	emit(type: string, event: unknown): void {
		for (const listener of this.listeners.get(type) ?? []) {
			listener(event)
		}
	}
}

class FakePeerConnection implements CodexRealtimePeerConnection {
	localDescription: { sdp?: string | null } | null = null
	connectionState = "new"
	readonly channel = new FakeDataChannel()
	remoteDescription: unknown
	closed = false
	private readonly listeners = new Map<string, Set<(event: unknown) => void>>()

	createDataChannel(label: string): FakeDataChannel {
		expect(label).toBe("oai-events")
		return this.channel
	}

	async createOffer(): Promise<unknown> {
		return { type: "offer", sdp: "v=0\r\ns=node-offer\r\n" }
	}

	async setLocalDescription(description: unknown): Promise<void> {
		this.localDescription = description as { sdp?: string | null }
	}

	async setRemoteDescription(description: unknown): Promise<void> {
		this.remoteDescription = description
	}

	close(): void {
		this.closed = true
	}

	addEventListener(type: string, listener: (event: unknown) => void): void {
		const listeners = this.listeners.get(type) ?? new Set()
		listeners.add(listener)
		this.listeners.set(type, listeners)
	}
}

describe("Codex Realtime", () => {
	test("builds the public realtime session shape", () => {
		expect(
			createCodexRealtimeSession({
				voice: "sol",
				instructions: "Be concise.",
			}),
		).toEqual({
			model: "gpt-live-1-boulder-alpha",
			instructions: "Be concise.",
			audio: { output: { voice: "sol" } },
		})
	})

	test("creates a call through the local OAuth endpoint", async () => {
		const fetch = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				expect(JSON.parse(String(init?.body))).toMatchObject({
					sdp: "offer",
					session: {
						model: "gpt-live-1-boulder-alpha",
						audio: { output: { voice: "cove" } },
					},
				})
				return new Response("answer", {
					status: 201,
					headers: { Location: "/v1/realtime/calls/rtc_node" },
				})
			},
		)

		await expect(
			createCodexRealtimeCall({ sdp: "offer", fetch }),
		).resolves.toEqual({
			sdp: "answer",
			callId: "rtc_node",
			location: "/v1/realtime/calls/rtc_node",
		})
	})

	test("drives an injected backend WebRTC adapter and raw PCM events", async () => {
		const peerConnection = new FakePeerConnection()
		const transcripts: string[] = []
		const audio: number[][] = []
		const connection = await connectCodexRealtime({
			peerConnection,
			fetch: async () =>
				new Response("v=0\r\ns=node-answer\r\n", {
					status: 201,
					headers: { Location: "/v1/realtime/calls/rtc_backend" },
				}),
			onTranscript: (event) => transcripts.push(event.text),
			onAudio: (event) => audio.push([...event.data]),
		})

		expect(connection.callId).toBe("rtc_backend")
		expect(peerConnection.remoteDescription).toEqual({
			type: "answer",
			sdp: "v=0\r\ns=node-answer\r\n",
		})
		connection.appendAudio(new Uint8Array([1, 2, 3]))
		connection.interrupt(new Uint8Array([4, 5, 6]))
		expect(peerConnection.channel.sent).toEqual([])

		peerConnection.channel.open()
		await connection.ready
		expect(
			peerConnection.channel.sent.map((value) => JSON.parse(value)),
		).toEqual([
			{ type: "input_audio.append", audio: "AQID" },
			{ type: "input_audio.append", audio: "BAUG" },
		])

		peerConnection.channel.emit("message", {
			data: JSON.stringify({
				type: "output_transcript.added",
				item: { text: "Hello" },
			}),
		})
		peerConnection.channel.emit("message", {
			data: JSON.stringify({ type: "output_audio.delta", audio: "AQID" }),
		})
		expect(transcripts).toEqual(["Hello"])
		expect(audio).toEqual([[1, 2, 3]])

		connection.close()
		expect(peerConnection.closed).toBe(true)
		expect(JSON.parse(peerConnection.channel.sent.at(-1) ?? "{}")).toEqual({
			type: "session.close",
		})
	})

	test("parses Frameless user and assistant transcript events", () => {
		expect(
			parseCodexRealtimeTranscriptEvent({
				type: "turn.done",
				turn: { role: "user", transcript: "What changed?" },
			}),
		).toMatchObject({ role: "user", kind: "done", text: "What changed?" })
		expect(
			parseCodexRealtimeTranscriptEvent({
				type: "output_transcript.added",
				item: { text: "I changed" },
			}),
		).toMatchObject({ role: "assistant", kind: "delta", text: "I changed" })
	})
})
