import {
	CODEX_REALTIME_REFERENCE_COMMIT,
	type CodexFramelessSessionConfig,
	type CodexFramelessVoice,
	type CodexRealtimeInitialItem,
	createCodexFramelessSession,
	DEFAULT_CODEX_FRAMELESS_MODEL,
	type OpenAIOAuthTransport,
} from "@openai-oauth/core"
import {
	type CodexAttestationProvider,
	resolveCodexAttestation,
} from "./realtime-attestation.js"
import { isRecord, toErrorResponse } from "./shared.js"

const MAX_SDP_BYTES = 1024 * 1024
const MAX_SESSION_BYTES = 256 * 1024

export type ParsedCodexRealtimeCall = {
	sdp: string
	session: ReturnType<typeof createCodexFramelessSession>
	sessionId: string
}

export type CodexRealtimeCallResult = {
	response: Response
	callId?: string
	sessionId: string
	attestationHeader?: string
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
	if (value instanceof Blob && value.size <= maxBytes) return value.text()
	return undefined
}

const parseJsonObject = (
	value: string | undefined,
): Record<string, unknown> => {
	if (!value?.trim()) return {}
	let parsed: unknown
	try {
		parsed = JSON.parse(value)
	} catch {
		throw new Error("`session` must contain valid JSON.")
	}
	if (!isRecord(parsed)) throw new Error("`session` must be a JSON object.")
	return parsed
}

const parseInitialItems = (value: unknown): CodexRealtimeInitialItem[] => {
	if (value === undefined) return []
	if (!Array.isArray(value))
		throw new Error("`session.initial_items` must be an array.")
	return value.map((item) => {
		if (!isRecord(item) || item.type !== "message") {
			throw new Error("Every realtime initial item must be a message.")
		}
		if (
			item.role !== "user" &&
			item.role !== "developer" &&
			item.role !== "assistant"
		) {
			throw new Error("Realtime initial item has an unsupported role.")
		}
		if (!Array.isArray(item.content)) {
			throw new Error("Realtime initial item content must be an array.")
		}
		const text = item.content
			.filter(isRecord)
			.map((content) => content.text)
			.filter((content): content is string => typeof content === "string")
			.join("")
		return { role: item.role, text }
	})
}

const sessionConfig = (
	session: Record<string, unknown>,
): CodexFramelessSessionConfig => {
	if (session.tools !== undefined || session.tool_choice !== undefined) {
		throw new Error(
			"Regular function tools are not supported by Codex Frameless v3. Official Codex supports them through Realtime v2, which requires API-key authentication instead of the ChatGPT OAuth AVAS endpoint.",
		)
	}
	if (
		session.instructions !== undefined &&
		typeof session.instructions !== "string"
	) {
		throw new Error("`session.instructions` must be a string.")
	}
	const audio = session.audio === undefined ? undefined : session.audio
	if (audio !== undefined && !isRecord(audio)) {
		throw new Error("`session.audio` must be an object.")
	}
	const output = isRecord(audio?.output) ? audio.output : undefined
	const voice = output?.voice
	if (voice !== undefined && typeof voice !== "string") {
		throw new Error("`session.audio.output.voice` must be a string.")
	}
	const delegation = session.delegation
	if (delegation !== undefined && !isRecord(delegation)) {
		throw new Error("`session.delegation` must be an object.")
	}
	const ackFiller = isRecord(delegation) ? delegation.ack_filler : undefined
	if (ackFiller !== undefined && typeof ackFiller !== "boolean") {
		throw new Error("`session.delegation.ack_filler` must be a boolean.")
	}
	return {
		model:
			typeof session.model === "string"
				? session.model
				: DEFAULT_CODEX_FRAMELESS_MODEL,
		instructions:
			typeof session.instructions === "string" ? session.instructions : "",
		...(typeof voice === "string"
			? { voice: voice as CodexFramelessVoice }
			: {}),
		...(typeof ackFiller === "boolean"
			? { delegationAckFiller: ackFiller }
			: {}),
		initialItems: parseInitialItems(session.initial_items),
	}
}

export const parseCodexRealtimeCallRequest = async (
	request: Request,
): Promise<ParsedCodexRealtimeCall> => {
	const contentType = request.headers.get("content-type") ?? ""
	let sdp: string | undefined
	let session: Record<string, unknown>
	let requestedSessionId: string | undefined
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
		session = parseJsonObject(sessionText)
		const formSessionId = form.get("session_id")
		requestedSessionId =
			typeof formSessionId === "string" ? formSessionId : undefined
	} else if (contentType.includes("application/json")) {
		let body: unknown
		try {
			body = await request.json()
		} catch {
			throw new Error("Invalid JSON request body.")
		}
		if (!isRecord(body))
			throw new Error("Realtime call body must be an object.")
		sdp = typeof body.sdp === "string" ? body.sdp : undefined
		if (body.session !== undefined && !isRecord(body.session)) {
			throw new Error("`session` must be a JSON object.")
		}
		session = isRecord(body.session) ? body.session : {}
		requestedSessionId =
			typeof body.session_id === "string" ? body.session_id : undefined
	} else {
		throw new Error(
			"Realtime call creation requires multipart/form-data or application/json.",
		)
	}
	if (!sdp?.trim()) throw new Error("`sdp` must be a non-empty WebRTC offer.")
	if (byteLength(sdp) > MAX_SDP_BYTES) {
		throw new Error("`sdp` exceeds the 1 MiB size limit.")
	}
	const sessionId =
		requestedSessionId ||
		(typeof session.id === "string" ? session.id : undefined) ||
		globalThis.crypto.randomUUID()
	return {
		sdp,
		session: createCodexFramelessSession(sessionConfig(session)),
		sessionId,
	}
}

export const codexRealtimeCallId = (
	location: string | null,
): string | undefined => {
	if (!location) return undefined
	return location
		.split("?", 1)[0]
		?.split("/")
		.reverse()
		.find(
			(segment) =>
				(/^rtc_.+/.test(segment) && segment.length > 4) ||
				/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
					segment,
				),
		)
}

export const createCodexRealtimeCallResponse = async (
	request: Request,
	client: OpenAIOAuthTransport,
	options: {
		codexVersion?: string
		attestationProvider?: CodexAttestationProvider
	} = {},
): Promise<CodexRealtimeCallResult> => {
	let parsed: ParsedCodexRealtimeCall
	try {
		parsed = await parseCodexRealtimeCallRequest(request)
	} catch (error) {
		return {
			response: toErrorResponse(
				error instanceof Error
					? error.message
					: "Invalid realtime call request.",
			),
			sessionId: "",
		}
	}
	const attestation = await resolveCodexAttestation(
		options.attestationProvider,
		{ sessionId: parsed.sessionId, signal: request.signal },
	)
	const headers = new Headers({
		"content-type": "application/json",
		"openai-alpha": "quicksilver=v2",
		"x-session-id": parsed.sessionId,
		originator: "codex_cli_rs",
		"user-agent": `codex_cli_rs/${options.codexVersion ?? "0.0.0"}`,
	})
	if (attestation.header) {
		headers.set("x-oai-attestation", attestation.header)
	}
	const upstream = await client.request(
		"/v1/realtime/calls?intent=quicksilver&architecture=avas",
		{
			method: "POST",
			headers,
			body: JSON.stringify({ sdp: parsed.sdp, session: parsed.session }),
			signal: request.signal,
		},
	)
	const location = upstream.headers.get("location")
	const callId = codexRealtimeCallId(location)
	const responseHeaders = new Headers(upstream.headers)
	responseHeaders.delete("content-encoding")
	responseHeaders.delete("content-length")
	responseHeaders.set("content-type", "application/sdp")
	responseHeaders.set("x-openai-oauth-realtime-version", "v3")
	responseHeaders.set(
		"x-openai-oauth-realtime-reference",
		CODEX_REALTIME_REFERENCE_COMMIT,
	)
	responseHeaders.set("x-openai-oauth-realtime-session-id", parsed.sessionId)
	if (callId) responseHeaders.set("x-openai-oauth-realtime-call-id", callId)
	if (upstream.ok && !callId) {
		return {
			response: toErrorResponse(
				"Realtime call response is missing a valid Location call id.",
				502,
				"upstream_error",
			),
			sessionId: parsed.sessionId,
			...(attestation.header ? { attestationHeader: attestation.header } : {}),
		}
	}
	return {
		response: new Response(upstream.body, {
			status: upstream.status,
			statusText: upstream.statusText,
			headers: responseHeaders,
		}),
		...(callId ? { callId } : {}),
		sessionId: parsed.sessionId,
		...(attestation.header ? { attestationHeader: attestation.header } : {}),
	}
}
