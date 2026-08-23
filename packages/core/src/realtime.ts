import type { FetchFunction } from "./runtime.js"
import { isRecord } from "./utils.js"

export type CodexRealtimeVoice =
	| "juniper"
	| "maple"
	| "spruce"
	| "ember"
	| "vale"
	| "breeze"
	| "arbor"
	| "sol"
	| "cove"

export type CodexRealtimeEvent = Record<string, unknown> & { type: string }

export type CodexRealtimeAudioChunk = Uint8Array | ArrayBuffer | string

export type CodexRealtimeAudioEvent = {
	data: Uint8Array
	sampleRate: 24_000
	numChannels: 1
	event: CodexRealtimeEvent
}

export type CodexRealtimeTranscriptEvent = {
	role: "user" | "assistant"
	kind: "delta" | "done"
	text: string
	event: CodexRealtimeEvent
}

export type CodexRealtimeSessionOptions = {
	model?: string
	voice?: CodexRealtimeVoice
	instructions?: string
	session?: Record<string, unknown>
}

export type CodexRealtimeDataChannel = {
	readonly readyState: string
	send(data: string): void
	close(): void
	addEventListener(type: string, listener: (event: unknown) => void): void
	removeEventListener(type: string, listener: (event: unknown) => void): void
}

export type CodexRealtimePeerConnection = {
	readonly localDescription?: { sdp?: string | null } | null
	readonly connectionState?: string
	createDataChannel(label: string): CodexRealtimeDataChannel
	createOffer(): Promise<unknown>
	setLocalDescription(description: unknown): Promise<void>
	setRemoteDescription(description: unknown): Promise<void>
	addTransceiver?(kind: string, init?: unknown): unknown
	close(): void
	addEventListener(type: string, listener: (event: unknown) => void): void
}

export type CreateCodexRealtimeCallOptions = CodexRealtimeSessionOptions & {
	sdp: string
	endpoint?: string
	fetch?: FetchFunction
	signal?: AbortSignal
}

export type CodexRealtimeCall = {
	sdp: string
	callId?: string
	location?: string
}

export type ConnectCodexRealtimeOptions = CodexRealtimeSessionOptions & {
	peerConnection: CodexRealtimePeerConnection
	endpoint?: string
	fetch?: FetchFunction
	signal?: AbortSignal
	preparePeer?: (
		peerConnection: CodexRealtimePeerConnection,
	) => void | Promise<void>
	addAudioTransceiver?: boolean
	onTrack?: (event: unknown) => void
	onEvent?: (event: CodexRealtimeEvent) => void
	onAudio?: (event: CodexRealtimeAudioEvent) => void
	onTranscript?: (event: CodexRealtimeTranscriptEvent) => void
	onConnectionStateChange?: (state: string) => void
}

export type CodexRealtimeConnection = {
	peerConnection: CodexRealtimePeerConnection
	dataChannel: CodexRealtimeDataChannel
	callId?: string
	ready: Promise<void>
	sendEvent(event: CodexRealtimeEvent): void
	sendText(text: string): void
	appendAudio(audio: CodexRealtimeAudioChunk): void
	streamAudio(
		source: AsyncIterable<CodexRealtimeAudioChunk>,
		options?: { signal?: AbortSignal },
	): Promise<void>
	interrupt(audio: CodexRealtimeAudioChunk): void
	close(): void
}

export type ConnectCodexRealtimeBrowserOptions = Omit<
	ConnectCodexRealtimeOptions,
	"peerConnection" | "preparePeer" | "onTrack"
> & {
	mediaStream?: MediaStream
	mediaConstraints?: MediaStreamConstraints
	audioElement?: HTMLAudioElement
	peerConnection?: RTCPeerConnection
	stopInputTracksOnClose?: boolean
	onRemoteStream?: (stream: MediaStream) => void
}

export type CodexRealtimeBrowserConnection = CodexRealtimeConnection & {
	peerConnection: RTCPeerConnection
	dataChannel: RTCDataChannel
	inputStream: MediaStream
	remoteStream: MediaStream
	audioElement?: HTMLAudioElement
}

const DEFAULT_REALTIME_ENDPOINT = "http://127.0.0.1:10531/v1/realtime/calls"

const mergeAudioSession = (
	base: Record<string, unknown>,
	voice: CodexRealtimeVoice,
): Record<string, unknown> => {
	const audio = isRecord(base.audio) ? base.audio : {}
	const output = isRecord(audio.output) ? audio.output : {}
	return {
		...base,
		audio: {
			...audio,
			output: {
				...output,
				voice: typeof output.voice === "string" ? output.voice : voice,
			},
		},
	}
}

export const createCodexRealtimeSession = (
	options: CodexRealtimeSessionOptions = {},
): Record<string, unknown> => {
	const session = mergeAudioSession(
		options.session ?? {},
		options.voice ?? "cove",
	)
	const model =
		typeof session.model === "string" ? session.model : options.model
	const normalized: Record<string, unknown> = {
		...session,
		instructions:
			typeof session.instructions === "string"
				? session.instructions
				: (options.instructions ?? ""),
	}
	if (typeof model === "string") {
		normalized.model = model
	} else {
		delete normalized.model
	}
	return normalized
}

const legacyTranscriptEventTypes = new Map<
	string,
	{
		role: CodexRealtimeTranscriptEvent["role"]
		kind: CodexRealtimeTranscriptEvent["kind"]
		field: "delta" | "transcript"
	}
>([
	[
		"conversation.input_transcript.delta",
		{ role: "user", kind: "delta", field: "delta" },
	],
	[
		"conversation.item.input_audio_transcription.delta",
		{ role: "user", kind: "delta", field: "delta" },
	],
	[
		"conversation.input_transcript.turn_marked",
		{ role: "user", kind: "done", field: "transcript" },
	],
	[
		"conversation.item.input_audio_transcription.completed",
		{ role: "user", kind: "done", field: "transcript" },
	],
	[
		"conversation.output_transcript.delta",
		{ role: "assistant", kind: "delta", field: "delta" },
	],
	[
		"response.output_text.delta",
		{ role: "assistant", kind: "delta", field: "delta" },
	],
	[
		"response.output_audio_transcript.delta",
		{ role: "assistant", kind: "delta", field: "delta" },
	],
	[
		"response.output_audio_transcript.done",
		{ role: "assistant", kind: "done", field: "transcript" },
	],
])

export const parseCodexRealtimeTranscriptEvent = (
	event: CodexRealtimeEvent,
): CodexRealtimeTranscriptEvent | undefined => {
	if (
		event.type === "input_transcript.added" ||
		event.type === "output_transcript.added"
	) {
		const item = isRecord(event.item) ? event.item : undefined
		const text = item?.text
		if (typeof text !== "string") {
			return undefined
		}
		return {
			role: event.type === "input_transcript.added" ? "user" : "assistant",
			kind: "delta",
			text,
			event,
		}
	}
	if (event.type === "turn.done") {
		const turn = isRecord(event.turn) ? event.turn : undefined
		const role = turn?.role
		const text = turn?.transcript
		if ((role !== "user" && role !== "assistant") || typeof text !== "string") {
			return undefined
		}
		return { role, kind: "done", text, event }
	}

	const shape = legacyTranscriptEventTypes.get(event.type)
	if (!shape) {
		return undefined
	}
	const text = event[shape.field]
	if (typeof text !== "string") {
		return undefined
	}
	return { ...shape, text, event }
}

const parseRealtimeEvent = (value: unknown): CodexRealtimeEvent | undefined => {
	if (!isRecord(value) || typeof value.type !== "string") {
		return undefined
	}
	return value as CodexRealtimeEvent
}

const resolveCallId = (location: string | null): string | undefined => {
	if (!location) {
		return undefined
	}
	const path = location.split("?", 1)[0]
	return path?.split("/").filter(Boolean).at(-1)
}

export const createCodexRealtimeCall = async (
	options: CreateCodexRealtimeCallOptions,
): Promise<CodexRealtimeCall> => {
	if (options.sdp.trim() === "") {
		throw new Error("A non-empty WebRTC SDP offer is required.")
	}
	const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis)
	if (!fetchImpl) {
		throw new Error("A fetch implementation is required for Codex Realtime.")
	}
	const response = await fetchImpl(
		options.endpoint ?? DEFAULT_REALTIME_ENDPOINT,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				sdp: options.sdp,
				session: createCodexRealtimeSession(options),
			}),
			signal: options.signal,
		},
	)
	if (!response.ok) {
		const detail = await response.text()
		throw new Error(
			`Realtime call creation failed (${response.status})${detail ? `: ${detail}` : "."}`,
		)
	}
	const location = response.headers.get("location") ?? undefined
	return {
		sdp: await response.text(),
		callId: resolveCallId(location ?? null),
		location,
	}
}

const waitForDataChannel = (
	channel: CodexRealtimeDataChannel,
): Promise<void> => {
	if (channel.readyState === "open") {
		return Promise.resolve()
	}
	return new Promise<void>((resolve, reject) => {
		const onOpen = () => {
			cleanup()
			resolve()
		}
		const onClose = () => {
			cleanup()
			reject(new Error("Realtime data channel closed before it became ready."))
		}
		const cleanup = () => {
			channel.removeEventListener("open", onOpen)
			channel.removeEventListener("close", onClose)
		}
		channel.addEventListener("open", onOpen)
		channel.addEventListener("close", onClose)
	})
}

const bytesToBase64 = (audio: Uint8Array | ArrayBuffer): string => {
	const bytes = audio instanceof Uint8Array ? audio : new Uint8Array(audio)
	let binary = ""
	for (let offset = 0; offset < bytes.length; offset += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
	}
	return btoa(binary)
}

const base64ToBytes = (audio: string): Uint8Array => {
	const binary = atob(audio)
	const bytes = new Uint8Array(binary.length)
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index)
	}
	return bytes
}

const chunkUtf8 = (text: string, maxBytes = 500): string[] => {
	const chunks: string[] = []
	let chunk = ""
	let size = 0
	for (const character of text) {
		const characterSize = new TextEncoder().encode(character).byteLength
		if (size > 0 && size + characterSize > maxBytes) {
			chunks.push(chunk)
			chunk = ""
			size = 0
		}
		chunk += character
		size += characterSize
	}
	if (chunk) {
		chunks.push(chunk)
	}
	return chunks
}

export const connectCodexRealtime = async (
	options: ConnectCodexRealtimeOptions,
): Promise<CodexRealtimeConnection> => {
	const peerConnection = options.peerConnection
	await options.preparePeer?.(peerConnection)
	if (options.addAudioTransceiver ?? true) {
		peerConnection.addTransceiver?.("audio", { direction: "recvonly" })
	}
	if (options.onTrack) {
		peerConnection.addEventListener("track", options.onTrack)
	}
	peerConnection.addEventListener("connectionstatechange", () => {
		options.onConnectionStateChange?.(
			peerConnection.connectionState ?? "unknown",
		)
	})

	const dataChannel = peerConnection.createDataChannel("oai-events")
	const pendingEvents: string[] = []
	const sendSerialized = (payload: string) => {
		if (dataChannel.readyState === "open") {
			dataChannel.send(payload)
		} else if (dataChannel.readyState === "connecting") {
			pendingEvents.push(payload)
		} else {
			throw new Error("Realtime data channel is not open.")
		}
	}
	dataChannel.addEventListener("open", () => {
		for (const payload of pendingEvents.splice(0)) {
			dataChannel.send(payload)
		}
	})
	dataChannel.addEventListener("message", (message: unknown) => {
		const data = isRecord(message) ? message.data : undefined
		if (typeof data !== "string") {
			return
		}
		let parsed: unknown
		try {
			parsed = JSON.parse(data)
		} catch {
			return
		}
		const event = parseRealtimeEvent(parsed)
		if (!event) {
			return
		}
		options.onEvent?.(event)
		if (
			event.type === "output_audio.delta" &&
			typeof event.audio === "string"
		) {
			options.onAudio?.({
				data: base64ToBytes(event.audio),
				sampleRate: 24_000,
				numChannels: 1,
				event,
			})
		}
		const transcript = parseCodexRealtimeTranscriptEvent(event)
		if (transcript) {
			options.onTranscript?.(transcript)
		}
	})

	let closed = false
	const close = () => {
		if (closed) {
			return
		}
		closed = true
		if (dataChannel.readyState === "open") {
			dataChannel.send(JSON.stringify({ type: "session.close" }))
		}
		dataChannel.close()
		peerConnection.close()
	}
	options.signal?.addEventListener("abort", close, { once: true })

	try {
		const offer = await peerConnection.createOffer()
		await peerConnection.setLocalDescription(offer)
		const sdp = peerConnection.localDescription?.sdp
		if (!sdp) {
			throw new Error("The WebRTC adapter did not produce an SDP offer.")
		}
		const call = await createCodexRealtimeCall({ ...options, sdp })
		await peerConnection.setRemoteDescription({
			type: "answer",
			sdp: call.sdp,
		})

		const sendEvent = (event: CodexRealtimeEvent) =>
			sendSerialized(JSON.stringify(event))
		const appendAudio = (audio: CodexRealtimeAudioChunk) => {
			sendEvent({
				type: "input_audio.append",
				audio: typeof audio === "string" ? audio : bytesToBase64(audio),
			})
		}
		return {
			peerConnection,
			dataChannel,
			callId: call.callId,
			ready: waitForDataChannel(dataChannel),
			sendEvent,
			sendText: (text) => {
				if (text.trim() === "") {
					return
				}
				for (const chunk of chunkUtf8(text)) {
					sendEvent({
						type: "session.context.append",
						content: [{ type: "input_text", text: chunk }],
					})
				}
			},
			appendAudio,
			streamAudio: async (source, streamOptions) => {
				await waitForDataChannel(dataChannel)
				for await (const chunk of source) {
					if (streamOptions?.signal?.aborted) {
						break
					}
					appendAudio(chunk)
				}
			},
			interrupt: appendAudio,
			close,
		}
	} catch (error) {
		close()
		throw error
	}
}

export const connectCodexRealtimeBrowser = async (
	options: ConnectCodexRealtimeBrowserOptions = {},
): Promise<CodexRealtimeBrowserConnection> => {
	const peerConnection =
		options.peerConnection ??
		(typeof RTCPeerConnection === "function"
			? new RTCPeerConnection()
			: undefined)
	if (!peerConnection) {
		throw new Error("RTCPeerConnection is not available in this runtime.")
	}
	const ownsInputStream = options.mediaStream === undefined
	const inputStream =
		options.mediaStream ??
		(await globalThis.navigator?.mediaDevices?.getUserMedia(
			options.mediaConstraints ?? { audio: true },
		))
	if (!inputStream) {
		peerConnection.close()
		throw new Error("Microphone access is not available in this runtime.")
	}
	const remoteStream = new MediaStream()
	const audioElement =
		options.audioElement ??
		(typeof Audio === "function" ? new Audio() : undefined)
	if (audioElement) {
		audioElement.autoplay = true
		audioElement.srcObject = remoteStream
	}

	const connection = await connectCodexRealtime({
		...options,
		peerConnection,
		addAudioTransceiver: false,
		preparePeer: () => {
			for (const track of inputStream.getAudioTracks()) {
				peerConnection.addTrack(track, inputStream)
			}
		},
		onTrack: (value) => {
			const event = value as RTCTrackEvent
			if (
				!remoteStream.getTracks().some((track) => track.id === event.track.id)
			) {
				remoteStream.addTrack(event.track)
			}
			options.onRemoteStream?.(remoteStream)
			if (audioElement) {
				void audioElement.play()
			}
		},
	})
	let cleanedUp = false
	const cleanupMedia = () => {
		if (cleanedUp) {
			return
		}
		cleanedUp = true
		if (options.stopInputTracksOnClose ?? ownsInputStream) {
			for (const track of inputStream.getTracks()) {
				track.stop()
			}
		}
		if (audioElement) {
			audioElement.srcObject = null
		}
	}
	options.signal?.addEventListener("abort", cleanupMedia, { once: true })
	const baseClose = connection.close
	return {
		...connection,
		peerConnection,
		dataChannel: connection.dataChannel as RTCDataChannel,
		inputStream,
		remoteStream,
		audioElement,
		close: () => {
			baseClose()
			cleanupMedia()
		},
	}
}
