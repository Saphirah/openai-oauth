import {
	type CodexFramelessEvent,
	type CodexFramelessOutboundEvent,
	type CodexFramelessSessionConfig,
	type CodexRealtimeContextChannel,
	createCodexDelegationContextEvents,
	createCodexFramelessSession,
	createCodexSessionContextEvents,
	parseCodexFramelessEvent,
} from "./realtime-protocol.js"
import type { FetchFunction } from "./runtime.js"
import { isRecord } from "./utils.js"

const DEFAULT_REALTIME_CALL_ENDPOINT =
	"http://127.0.0.1:10531/v1/realtime/calls"
const SIDEBAND_CONNECTED_EVENT = "openai_oauth.sideband.connected"
const SIDEBAND_ERROR_EVENT = "openai_oauth.sideband.error"

const resolveRealtimeEndpoint = (endpoint: string): string => {
	const browserBase = globalThis.location?.href
	return new URL(
		endpoint,
		browserBase ?? DEFAULT_REALTIME_CALL_ENDPOINT,
	).toString()
}

export type CodexRealtimeCall = {
	sdp: string
	callId: string
	sidebandUrl?: string
}

export type CodexRealtimeDataChannel = {
	readonly readyState: string
	send(data: string): void
	close(): void
	addEventListener(type: string, listener: (event: unknown) => void): void
}

export type CodexRealtimeWebSocket = {
	readonly readyState: number
	send(data: string): void
	close(code?: number, reason?: string): void
	addEventListener(
		type: string,
		listener: (event: unknown) => void,
		options?: { once?: boolean },
	): void
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

export type ConnectCodexRealtimeOptions = CodexFramelessSessionConfig & {
	peerConnection: CodexRealtimePeerConnection
	endpoint?: string
	fetch?: FetchFunction
	signal?: AbortSignal
	preparePeer?: (
		peerConnection: CodexRealtimePeerConnection,
	) => void | Promise<void>
	onTrack?: (event: unknown) => void
	onEvent?: (event: CodexFramelessEvent) => void
	onConnectionStateChange?: (state: string) => void
	webSocket?: (url: string) => CodexRealtimeWebSocket
}

export type CodexRealtimeConnection = {
	peerConnection: CodexRealtimePeerConnection
	dataChannel: CodexRealtimeDataChannel
	call: CodexRealtimeCall
	ready: Promise<void>
	send(event: CodexFramelessOutboundEvent): void
	sendText(text: string, channel?: CodexRealtimeContextChannel): void
	sendDelegationText(
		delegationItemId: string,
		text: string,
		channel?: CodexRealtimeContextChannel,
	): void
	appendAudio(audio: string): void
	close(): void
}

export type ConnectCodexRealtimeBrowserOptions = Omit<
	ConnectCodexRealtimeOptions,
	"peerConnection" | "preparePeer" | "onTrack"
> & {
	mediaStream?: MediaStream
	mediaConstraints?: MediaStreamConstraints
	peerConnection?: RTCPeerConnection
	audioElement?: HTMLAudioElement
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

const realtimeCallId = (location: string | null): string | undefined => {
	if (!location) return undefined
	const segments = location.split("?", 1)[0]?.split("/").reverse() ?? []
	return segments.find(
		(segment) =>
			(/^rtc_.+/.test(segment) && segment.length > 4) ||
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
				segment,
			),
	)
}

export const createCodexRealtimeCall = async (
	sdp: string,
	config: CodexFramelessSessionConfig & {
		endpoint?: string
		fetch?: FetchFunction
		signal?: AbortSignal
	},
): Promise<CodexRealtimeCall> => {
	if (sdp.trim() === "") throw new Error("A WebRTC SDP offer is required.")
	const fetchImpl = config.fetch ?? globalThis.fetch?.bind(globalThis)
	if (!fetchImpl) throw new Error("A fetch implementation is required.")
	const endpoint = resolveRealtimeEndpoint(
		config.endpoint ?? DEFAULT_REALTIME_CALL_ENDPOINT,
	)
	const response = await fetchImpl(endpoint, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			sdp,
			session: createCodexFramelessSession(config),
			session_id: config.sessionId,
		}),
		signal: config.signal,
	})
	if (!response.ok) {
		const detail = await response.text()
		throw new Error(
			`Realtime call creation failed (${response.status})${detail ? `: ${detail}` : ""}`,
		)
	}
	const callId =
		response.headers.get("x-openai-oauth-realtime-call-id") ??
		realtimeCallId(response.headers.get("location"))
	if (!callId) throw new Error("Realtime call response is missing a call id.")
	const sidebandPath = response.headers.get("x-openai-oauth-realtime-sideband")
	let sidebandUrl: string | undefined
	if (sidebandPath) {
		const url = new URL(sidebandPath, endpoint)
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
		sidebandUrl = url.toString()
	}
	return {
		sdp: await response.text(),
		callId,
		...(sidebandUrl ? { sidebandUrl } : {}),
	}
}

const messageText = (message: unknown): string | undefined => {
	if (!isRecord(message)) return undefined
	if (typeof message.data === "string") return message.data
	return undefined
}

const waitForDataChannel = (
	channel: CodexRealtimeDataChannel,
): Promise<void> => {
	if (channel.readyState === "open") return Promise.resolve()
	return new Promise((resolve, reject) => {
		channel.addEventListener("open", () => resolve())
		channel.addEventListener("error", () =>
			reject(new Error("Realtime data channel failed to open.")),
		)
	})
}

export const connectCodexRealtime = async (
	options: ConnectCodexRealtimeOptions,
): Promise<CodexRealtimeConnection> => {
	const peer = options.peerConnection
	const dataChannel = peer.createDataChannel("oai-events")
	const pending: string[] = []
	let sideband: CodexRealtimeWebSocket | undefined
	let sidebandReady = false
	let closed = false

	const dispatch = (serialized: string) => {
		if (sideband && !sidebandReady) {
			pending.push(serialized)
			return
		}
		const target = sideband ?? dataChannel
		const isOpen = sideband
			? target.readyState === 1
			: target.readyState === "open"
		const isConnecting = sideband
			? target.readyState === 0
			: target.readyState === "connecting"
		if (isOpen) target.send(serialized)
		else if (isConnecting) pending.push(serialized)
		else throw new Error("Realtime control channel is not open.")
	}
	const receive = (message: unknown) => {
		const text = messageText(message)
		if (!text) return
		let value: unknown
		try {
			value = JSON.parse(text)
		} catch {
			return
		}
		if (
			isRecord(value) &&
			(value.type === SIDEBAND_CONNECTED_EVENT ||
				value.type === SIDEBAND_ERROR_EVENT)
		) {
			return
		}
		const event = parseCodexFramelessEvent(value)
		if (event) options.onEvent?.(event)
	}
	dataChannel.addEventListener("message", receive)
	dataChannel.addEventListener("open", () => {
		if (sideband) return
		for (const payload of pending.splice(0)) dataChannel.send(payload)
	})
	peer.addEventListener("track", (event) => options.onTrack?.(event))
	peer.addEventListener("connectionstatechange", () =>
		options.onConnectionStateChange?.(peer.connectionState ?? "unknown"),
	)
	options.signal?.addEventListener(
		"abort",
		() => {
			if (!closed) peer.close()
		},
		{ once: true },
	)

	try {
		await options.preparePeer?.(peer)
		if (!options.preparePeer)
			peer.addTransceiver?.("audio", { direction: "sendrecv" })
		const offer = await peer.createOffer()
		await peer.setLocalDescription(offer)
		const sdp = peer.localDescription?.sdp
		if (!sdp)
			throw new Error("The WebRTC adapter did not produce an SDP offer.")
		const call = await createCodexRealtimeCall(sdp, options)
		await peer.setRemoteDescription({ type: "answer", sdp: call.sdp })

		let ready: Promise<void>
		if (call.sidebandUrl) {
			const createSocket =
				options.webSocket ?? ((url: string) => new WebSocket(url))
			sideband = createSocket(call.sidebandUrl)
			sideband.addEventListener("message", receive)
			ready = new Promise<void>((resolve, reject) => {
				sideband?.addEventListener("message", (message) => {
					const text = messageText(message)
					if (!text) return
					try {
						const event = JSON.parse(text)
						if (event.type === SIDEBAND_CONNECTED_EVENT) {
							sidebandReady = true
							for (const payload of pending.splice(0)) sideband?.send(payload)
							resolve()
						} else if (event.type === SIDEBAND_ERROR_EVENT) {
							reject(
								new Error(String(event.message ?? "Realtime sideband failed.")),
							)
						}
					} catch {}
				})
				sideband?.addEventListener("error", () =>
					reject(new Error("Realtime sideband failed to open.")),
				)
			})
		} else {
			ready = waitForDataChannel(dataChannel)
		}

		const send = (event: CodexFramelessOutboundEvent) =>
			dispatch(JSON.stringify(event))
		const close = () => {
			if (closed) return
			closed = true
			try {
				dispatch(JSON.stringify({ type: "session.close" }))
			} catch {}
			sideband?.close(1000, "Session closed")
			dataChannel.close()
			peer.close()
		}
		return {
			peerConnection: peer,
			dataChannel,
			call,
			ready,
			send,
			sendText: (text, channel) => {
				for (const event of createCodexSessionContextEvents(text, channel)) {
					send(event)
				}
			},
			sendDelegationText: (delegationItemId, text, channel) => {
				for (const event of createCodexDelegationContextEvents(
					delegationItemId,
					text,
					channel,
				)) {
					send(event)
				}
			},
			appendAudio: (audio) => send({ type: "input_audio.append", audio }),
			close,
		}
	} catch (error) {
		dataChannel.close()
		peer.close()
		throw error
	}
}

export const connectCodexRealtimeBrowser = async (
	options: ConnectCodexRealtimeBrowserOptions = {},
): Promise<CodexRealtimeBrowserConnection> => {
	const peer = options.peerConnection ?? new RTCPeerConnection()
	const ownsInputStream = options.mediaStream === undefined
	const inputStream =
		options.mediaStream ??
		(await navigator.mediaDevices.getUserMedia(
			options.mediaConstraints ?? { audio: true },
		))
	const remoteStream = new MediaStream()
	const audioElement = options.audioElement
	if (audioElement) {
		audioElement.autoplay = true
		audioElement.srcObject = remoteStream
	}
	const connection = await connectCodexRealtime({
		...options,
		peerConnection: peer,
		preparePeer: () => {
			for (const track of inputStream.getAudioTracks()) {
				peer.addTrack(track, inputStream)
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
			if (audioElement) void audioElement.play()
		},
	})
	let cleaned = false
	const cleanup = () => {
		if (cleaned) return
		cleaned = true
		if (options.stopInputTracksOnClose ?? ownsInputStream) {
			for (const track of inputStream.getTracks()) track.stop()
		}
		if (audioElement) audioElement.srcObject = null
	}
	const baseClose = connection.close
	return {
		...connection,
		peerConnection: peer,
		dataChannel: connection.dataChannel as RTCDataChannel,
		inputStream,
		remoteStream,
		...(audioElement ? { audioElement } : {}),
		close: () => {
			baseClose()
			cleanup()
		},
	}
}
