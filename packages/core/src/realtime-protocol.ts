import { isRecord } from "./utils.js"

/** OpenAI Codex source revision this wire adapter was ported from. */
export const CODEX_REALTIME_REFERENCE_COMMIT =
	"068c49f075cf287a1fe7d1ee36cf005efac922e7"

export const DEFAULT_CODEX_FRAMELESS_MODEL = "gpt-live-1-codex"
export const DEFAULT_CODEX_FRAMELESS_VOICE = "cove"
export const CODEX_FRAMELESS_CONTEXT_CHUNK_BYTES = 500

export const CODEX_FRAMELESS_VOICES = [
	"juniper",
	"maple",
	"spruce",
	"ember",
	"vale",
	"breeze",
	"arbor",
	"sol",
	"cove",
] as const

export type CodexFramelessVoice = (typeof CODEX_FRAMELESS_VOICES)[number]
export type CodexRealtimeTextRole = "user" | "developer" | "assistant"
export type CodexRealtimeContextChannel = "speakable" | "commentary"

export type CodexRealtimeInitialItem = {
	role: CodexRealtimeTextRole
	text: string
}

export type CodexFramelessSessionConfig = {
	instructions?: string
	initialItems?: CodexRealtimeInitialItem[]
	delegationAckFiller?: boolean
	model?: string
	sessionId?: string
	voice?: CodexFramelessVoice
}

export type CodexFramelessSession = {
	model: string
	instructions: string
	audio: { output: { voice: CodexFramelessVoice } }
	delegation: { type: "client"; ack_filler?: boolean }
	initial_items?: Array<{
		type: "message"
		role: CodexRealtimeTextRole
		content: Array<{
			type: "input_text" | "output_text"
			text: string
		}>
	}>
}

export type CodexFramelessOutboundEvent =
	| {
			type: "session.context.append"
			channel?: CodexRealtimeContextChannel
			content: Array<{ type: "input_text"; text: string }>
	  }
	| {
			type: "delegation.context.append"
			delegation_item_id: string
			channel?: CodexRealtimeContextChannel
			content: Array<{ type: "input_text"; text: string }>
	  }
	| { type: "input_audio.append"; audio: string }
	| { type: "session.close" }

export type CodexFramelessEvent =
	| {
			kind: "session"
			type: "session.started" | "session.updated"
			sessionId: string
			instructions?: string
			raw: Record<string, unknown>
	  }
	| {
			kind: "audio"
			type: "output_audio.delta"
			audio: string
			sampleRate: 24_000
			channels: 1
			raw: Record<string, unknown>
	  }
	| {
			kind: "transcript"
			type: "input_transcript.added" | "output_transcript.added"
			role: "user" | "assistant"
			phase: "delta"
			text: string
			raw: Record<string, unknown>
	  }
	| {
			kind: "transcript"
			type: "turn.done"
			role: "user" | "assistant"
			phase: "done"
			text: string
			raw: Record<string, unknown>
	  }
	| {
			kind: "handoff"
			type: "delegation.created"
			handoffId: string
			inputTranscript: string
			raw: Record<string, unknown>
	  }
	| {
			kind: "error"
			type: "error"
			message: string
			raw: Record<string, unknown>
	  }
	| {
			kind: "unknown"
			type: string
			raw: Record<string, unknown>
	  }

const assertVoice = (voice: string): CodexFramelessVoice => {
	if (!(CODEX_FRAMELESS_VOICES as readonly string[]).includes(voice)) {
		throw new Error(
			`Realtime voice \`${voice}\` is not supported by Codex Frameless v3.`,
		)
	}
	return voice as CodexFramelessVoice
}

export const createCodexFramelessSession = (
	config: CodexFramelessSessionConfig = {},
): CodexFramelessSession => {
	const voice = assertVoice(config.voice ?? DEFAULT_CODEX_FRAMELESS_VOICE)
	const session: CodexFramelessSession = {
		model: config.model ?? DEFAULT_CODEX_FRAMELESS_MODEL,
		instructions: config.instructions ?? "",
		audio: { output: { voice } },
		delegation: { type: "client" },
	}
	if (config.delegationAckFiller !== undefined) {
		session.delegation.ack_filler = config.delegationAckFiller
	}
	if (config.initialItems?.length) {
		session.initial_items = config.initialItems.map((item) => ({
			type: "message",
			role: item.role,
			content: [
				{
					type: item.role === "assistant" ? "output_text" : "input_text",
					text: item.text,
				},
			],
		}))
	}
	return session
}

export const chunkCodexFramelessContext = (text: string): string[] => {
	const encoder = new TextEncoder()
	if (encoder.encode(text).byteLength <= CODEX_FRAMELESS_CONTEXT_CHUNK_BYTES) {
		return [text]
	}
	const chunks: string[] = []
	let chunk = ""
	let chunkBytes = 0
	for (const character of text) {
		const characterBytes = encoder.encode(character).byteLength
		if (
			chunk.length > 0 &&
			chunkBytes + characterBytes > CODEX_FRAMELESS_CONTEXT_CHUNK_BYTES
		) {
			chunks.push(chunk)
			chunk = ""
			chunkBytes = 0
		}
		chunk += character
		chunkBytes += characterBytes
	}
	if (chunk.length > 0) chunks.push(chunk)
	return chunks
}

export const createCodexSessionContextEvents = (
	text: string,
	channel?: CodexRealtimeContextChannel,
): CodexFramelessOutboundEvent[] =>
	chunkCodexFramelessContext(text).map((chunk) => ({
		type: "session.context.append",
		...(channel ? { channel } : {}),
		content: [{ type: "input_text", text: chunk }],
	}))

export const createCodexDelegationContextEvents = (
	delegationItemId: string,
	text: string,
	channel?: CodexRealtimeContextChannel,
): CodexFramelessOutboundEvent[] =>
	chunkCodexFramelessContext(text).map((chunk) => ({
		type: "delegation.context.append",
		delegation_item_id: delegationItemId,
		...(channel ? { channel } : {}),
		content: [{ type: "input_text", text: chunk }],
	}))

const eventMessage = (event: Record<string, unknown>): string | undefined => {
	if (typeof event.message === "string") return event.message
	if (isRecord(event.error) && typeof event.error.message === "string") {
		return event.error.message
	}
	return event.error === undefined ? undefined : JSON.stringify(event.error)
}

export const parseCodexFramelessEvent = (
	value: unknown,
): CodexFramelessEvent | undefined => {
	if (!isRecord(value) || typeof value.type !== "string") return undefined
	const raw = value
	switch (value.type) {
		case "session.started":
		case "session.updated": {
			if (!isRecord(value.session) || typeof value.session.id !== "string") {
				return undefined
			}
			return {
				kind: "session",
				type: value.type,
				sessionId: value.session.id,
				...(typeof value.session.instructions === "string"
					? { instructions: value.session.instructions }
					: {}),
				raw,
			}
		}
		case "output_audio.delta":
			return typeof value.audio === "string"
				? {
						kind: "audio",
						type: value.type,
						audio: value.audio,
						sampleRate: 24_000,
						channels: 1,
						raw,
					}
				: undefined
		case "input_transcript.added":
		case "output_transcript.added": {
			if (!isRecord(value.item) || typeof value.item.text !== "string") {
				return undefined
			}
			return {
				kind: "transcript",
				type: value.type,
				role: value.type === "input_transcript.added" ? "user" : "assistant",
				phase: "delta",
				text: value.item.text,
				raw,
			}
		}
		case "turn.done": {
			if (
				!isRecord(value.turn) ||
				(value.turn.role !== "user" && value.turn.role !== "assistant") ||
				typeof value.turn.transcript !== "string"
			) {
				return undefined
			}
			return {
				kind: "transcript",
				type: value.type,
				role: value.turn.role,
				phase: "done",
				text: value.turn.transcript,
				raw,
			}
		}
		case "delegation.created": {
			if (
				!isRecord(value.item) ||
				value.item.type !== "delegation" ||
				value.item.target !== "client" ||
				typeof value.item.id !== "string" ||
				!Array.isArray(value.item.content)
			) {
				return undefined
			}
			const inputTranscript = value.item.content
				.filter(isRecord)
				.filter((content) => content.type === "input_text")
				.map((content) => content.text)
				.filter((text): text is string => typeof text === "string")
				.join("")
			return {
				kind: "handoff",
				type: value.type,
				handoffId: value.item.id,
				inputTranscript,
				raw,
			}
		}
		case "error": {
			const message = eventMessage(value)
			return message
				? { kind: "error", type: value.type, message, raw }
				: undefined
		}
		default:
			return { kind: "unknown", type: value.type, raw }
	}
}
