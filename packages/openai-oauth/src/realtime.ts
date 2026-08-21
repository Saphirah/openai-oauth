import type { OpenAIOAuthTransport } from "@openai-oauth/core"
import { copyUpstreamResponse, isRecord, toErrorResponse } from "./shared.js"

const MAX_SDP_BYTES = 1024 * 1024
const MAX_SESSION_BYTES = 256 * 1024
const DEFAULT_CODEX_REALTIME_MODEL = "gpt-live-1-boulder-alpha"
const DEFAULT_CODEX_REALTIME_VOICE = "cove"

const CODEX_FRAMELESS_VOICES = new Set([
	"juniper",
	"maple",
	"spruce",
	"ember",
	"vale",
	"breeze",
	"arbor",
	"sol",
	"cove",
])

type ParsedRealtimeCall = {
	sdp: string
	session: Record<string, unknown>
	sessionId: string
}

const byteLength = (value: string): number =>
	new TextEncoder().encode(value).byteLength

const readFormText = async (
	form: FormData,
	name: string,
	maxBytes: number,
): Promise<string | undefined> => {
	const value = form.get(name)
	if (typeof value === "string") {
		return byteLength(value) <= maxBytes ? value : undefined
	}
	if (value instanceof Blob && value.size <= maxBytes) {
		return value.text()
	}
	return undefined
}

const parseSession = (value: string | undefined): Record<string, unknown> => {
	if (value === undefined || value.trim() === "") {
		return {}
	}

	let parsed: unknown
	try {
		parsed = JSON.parse(value)
	} catch {
		throw new Error("`session` must contain valid JSON.")
	}
	if (!isRecord(parsed)) {
		throw new Error("`session` must be a JSON object.")
	}
	return parsed
}

const parseRealtimeCall = async (
	request: Request,
): Promise<ParsedRealtimeCall> => {
	const contentType = request.headers.get("content-type") ?? ""
	let sdp: string | undefined
	let session: Record<string, unknown>

	if (contentType.includes("multipart/form-data")) {
		let form: FormData
		try {
			form = await request.formData()
		} catch {
			throw new Error("Invalid multipart/form-data request body.")
		}
		sdp = await readFormText(form, "sdp", MAX_SDP_BYTES)
		const sessionText = await readFormText(form, "session", MAX_SESSION_BYTES)
		if (form.has("session") && sessionText === undefined) {
			throw new Error("`session` exceeds the 256 KiB size limit.")
		}
		session = parseSession(sessionText)
	} else if (contentType.includes("application/json")) {
		let body: unknown
		try {
			body = await request.json()
		} catch {
			throw new Error("Invalid JSON request body.")
		}
		if (!isRecord(body)) {
			throw new Error("Realtime call body must be a JSON object.")
		}
		sdp = typeof body.sdp === "string" ? body.sdp : undefined
		if (body.session !== undefined && !isRecord(body.session)) {
			throw new Error("`session` must be a JSON object.")
		}
		session = isRecord(body.session) ? body.session : {}
	} else {
		throw new Error(
			"Realtime call creation requires multipart/form-data or application/json.",
		)
	}

	if (typeof sdp !== "string" || sdp.trim() === "") {
		throw new Error("`sdp` must be a non-empty WebRTC SDP offer.")
	}
	if (byteLength(sdp) > MAX_SDP_BYTES) {
		throw new Error("`sdp` exceeds the 1 MiB size limit.")
	}

	const requestedSessionId =
		typeof session.id === "string" && session.id.length > 0
			? session.id
			: undefined
	return {
		sdp,
		session,
		sessionId: requestedSessionId ?? globalThis.crypto.randomUUID(),
	}
}

const normalizeRealtimeSession = (
	session: Record<string, unknown>,
): Record<string, unknown> => {
	if (session.type !== undefined && session.type !== "realtime") {
		throw new Error("`session.type` must be `realtime` when provided.")
	}
	if (
		session.instructions !== undefined &&
		typeof session.instructions !== "string"
	) {
		throw new Error("`session.instructions` must be a string.")
	}
	if (session.audio !== undefined && !isRecord(session.audio)) {
		throw new Error("`session.audio` must be an object.")
	}

	const audio = isRecord(session.audio) ? { ...session.audio } : {}
	if (audio.input !== undefined && !isRecord(audio.input)) {
		throw new Error("`session.audio.input` must be an object.")
	}
	if (audio.output !== undefined && !isRecord(audio.output)) {
		throw new Error("`session.audio.output` must be an object.")
	}
	const output = isRecord(audio.output) ? { ...audio.output } : {}
	const voice =
		typeof output.voice === "string"
			? output.voice
			: typeof session.voice === "string"
				? session.voice
				: DEFAULT_CODEX_REALTIME_VOICE
	if (!CODEX_FRAMELESS_VOICES.has(voice)) {
		throw new Error(
			`Realtime voice \`${voice}\` is not supported by Codex Frameless realtime.`,
		)
	}

	if (Array.isArray(session.output_modalities)) {
		const modalities = session.output_modalities.filter(
			(value): value is string => typeof value === "string",
		)
		if (modalities.length > 0 && !modalities.includes("audio")) {
			throw new Error("Codex Frameless realtime requires audio output.")
		}
	}
	if (session.delegation !== undefined && !isRecord(session.delegation)) {
		throw new Error("`session.delegation` must be an object.")
	}
	const delegation = isRecord(session.delegation)
		? { ...session.delegation }
		: {}

	const normalized: Record<string, unknown> = {
		...session,
		model:
			typeof session.model === "string" &&
			session.model !== "gpt-realtime" &&
			session.model !== "gpt-realtime-1.5"
				? session.model
				: DEFAULT_CODEX_REALTIME_MODEL,
		instructions:
			typeof session.instructions === "string" ? session.instructions : "",
		audio: {
			...audio,
			output: {
				...output,
				voice,
			},
		},
		delegation: {
			...delegation,
			type: "client",
			ack_filler:
				typeof delegation.ack_filler === "boolean"
					? delegation.ack_filler
					: false,
		},
	}
	delete normalized.id
	delete normalized.type
	delete normalized.voice
	delete normalized.output_modalities
	if (isRecord(normalized.audio)) {
		delete normalized.audio.input
	}
	return normalized
}

export const handleRealtimeCallRequest = async (
	request: Request,
	client: OpenAIOAuthTransport,
): Promise<Response> => {
	let parsed: ParsedRealtimeCall
	let session: Record<string, unknown>
	try {
		parsed = await parseRealtimeCall(request)
		session = normalizeRealtimeSession(parsed.session)
	} catch (error) {
		return toErrorResponse(
			error instanceof Error ? error.message : "Invalid realtime call request.",
		)
	}

	const headers = new Headers({
		"Content-Type": "application/json",
		"OpenAI-Alpha": "quicksilver=v2",
		"User-Agent": "codex_cli_rs/0.0.0",
		originator: "codex_cli_rs",
		"session-id": parsed.sessionId,
		"thread-id": parsed.sessionId,
		"x-session-id": parsed.sessionId,
	})
	const upstream = await client.request(
		"/v1/realtime/calls?intent=quicksilver&architecture=avas",
		{
			method: "POST",
			headers,
			body: JSON.stringify({ sdp: parsed.sdp, session }),
			signal: request.signal,
		},
	)
	return copyUpstreamResponse(upstream)
}
