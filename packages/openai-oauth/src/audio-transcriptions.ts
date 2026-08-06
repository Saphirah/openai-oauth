import type { OpenAIOAuthTransport } from "@openai-oauth/core"
import {
	copyUpstreamResponse,
	isRecord,
	toErrorResponse,
	toJsonResponse,
} from "./shared.js"

const MAX_AUDIO_BYTES = 50 * 1024 * 1024
const MAX_PROMPT_LENGTH = 16_000

const TRANSCRIPTION_MODEL_ALIASES = new Set([
	"whisper-1",
	"gpt-4o-transcribe",
	"gpt-4o-mini-transcribe",
])

const MIME_BY_EXTENSION: Record<string, string> = {
	flac: "audio/flac",
	m4a: "audio/mp4",
	mp3: "audio/mpeg",
	mp4: "audio/mp4",
	mpeg: "audio/mpeg",
	mpga: "audio/mpeg",
	oga: "audio/ogg",
	ogg: "audio/ogg",
	wav: "audio/wav",
	webm: "audio/webm",
}

const canonicalAudioMime = (mime: string): string | undefined => {
	const normalized = mime.toLowerCase().split(";", 1)[0]?.trim()
	if (
		normalized === "audio/wav" ||
		normalized === "audio/x-wav" ||
		normalized === "audio/wave" ||
		normalized === "audio/vnd.wave"
	) {
		return "audio/wav"
	}
	if (normalized === "audio/mpeg" || normalized === "audio/mp3") {
		return "audio/mpeg"
	}
	if (
		normalized === "audio/mp4" ||
		normalized === "audio/m4a" ||
		normalized === "audio/x-m4a" ||
		normalized === "video/mp4"
	) {
		return "audio/mp4"
	}
	if (normalized === "audio/webm" || normalized === "video/webm") {
		return "audio/webm"
	}
	if (normalized === "audio/ogg" || normalized === "application/ogg") {
		return "audio/ogg"
	}
	if (normalized === "audio/flac" || normalized === "audio/x-flac") {
		return "audio/flac"
	}
	return undefined
}

const fileName = (file: Blob): string | undefined => {
	const name = (file as Blob & { name?: unknown }).name
	return typeof name === "string" ? name : undefined
}

const audioMime = (file: Blob): string | undefined => {
	const fromType = canonicalAudioMime(file.type)
	if (fromType) {
		return fromType
	}

	const name = fileName(file)
	const extension = name?.split(".").pop()?.toLowerCase()
	return extension ? MIME_BY_EXTENSION[extension] : undefined
}

const textField = (form: FormData, name: string): string | undefined => {
	const value = form.get(name)
	return typeof value === "string" && value.length > 0 ? value : undefined
}

const readTranscriptionResponse = async (
	response: Response,
): Promise<Record<string, unknown> | undefined> => {
	try {
		const parsed: unknown = await response.json()
		return isRecord(parsed) ? parsed : undefined
	} catch {
		return undefined
	}
}

export const handleAudioTranscriptionRequest = async (
	request: Request,
	client: OpenAIOAuthTransport,
): Promise<Response> => {
	if (!request.headers.get("content-type")?.includes("multipart/form-data")) {
		return toErrorResponse(
			"Audio transcription requires a multipart/form-data request body.",
		)
	}

	let form: FormData
	try {
		form = await request.formData()
	} catch {
		return toErrorResponse("Invalid multipart/form-data request body.")
	}

	const file = form.get("file")
	if (!(file instanceof Blob)) {
		return toErrorResponse("`file` must be an uploaded audio file.")
	}
	if (file.size === 0) {
		return toErrorResponse("`file` must not be empty.")
	}
	if (file.size > MAX_AUDIO_BYTES) {
		return toErrorResponse(
			"Audio input exceeds the Codex 50 MiB size limit.",
			413,
		)
	}

	const mime = audioMime(file)
	if (!mime) {
		return toErrorResponse(
			"Unsupported audio format. Use flac, wav, mp3, m4a, mp4, webm, or ogg.",
		)
	}

	const requestedModel = textField(form, "model")
	if (!requestedModel) {
		return toErrorResponse("`model` is required.")
	}
	if (!TRANSCRIPTION_MODEL_ALIASES.has(requestedModel)) {
		return toErrorResponse(
			`Model \`${requestedModel}\` is not available for ChatGPT OAuth transcription. Use \`whisper-1\`, \`gpt-4o-transcribe\`, or \`gpt-4o-mini-transcribe\`.`,
			400,
			"invalid_request_error",
		)
	}

	const responseFormat = textField(form, "response_format") ?? "json"
	if (responseFormat !== "json" && responseFormat !== "text") {
		return toErrorResponse(
			"`response_format` must be `json` or `text` for Codex-backed transcriptions.",
		)
	}
	if (textField(form, "stream") === "true") {
		return toErrorResponse(
			"Streaming audio transcriptions are not supported by this proxy.",
		)
	}

	const language = textField(form, "language")
	if (language && !/^[a-z]{2,3}(?:-[a-z0-9]+)*$/i.test(language)) {
		return toErrorResponse("`language` must be an ISO language code.")
	}
	const prompt = textField(form, "prompt")
	if (prompt && prompt.length > MAX_PROMPT_LENGTH) {
		return toErrorResponse(
			`\`prompt\` must not exceed ${MAX_PROMPT_LENGTH} characters.`,
		)
	}

	const upstreamForm = new FormData()
	upstreamForm.set(
		"file",
		file,
		fileName(file) ?? `audio.${mime.split("/")[1]}`,
	)
	const upstream = await client.requestChatGPT("/transcribe", {
		method: "POST",
		body: upstreamForm,
		signal: request.signal,
	})

	if (!upstream.ok) {
		return copyUpstreamResponse(upstream)
	}

	const completed = await readTranscriptionResponse(upstream)
	const transcript =
		completed && typeof completed.text === "string" ? completed.text : undefined
	if (transcript === undefined) {
		return toErrorResponse(
			"Codex returned a response without transcription text.",
			502,
			"upstream_error",
		)
	}

	if (responseFormat === "text") {
		return new Response(transcript, {
			headers: { "content-type": "text/plain; charset=utf-8" },
		})
	}
	return toJsonResponse({ text: transcript })
}
