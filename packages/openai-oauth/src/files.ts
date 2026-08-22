import type { OpenAIOAuthTransport } from "@openai-oauth/core"
import { isRecord, toErrorResponse, toJsonResponse } from "./shared.js"

export const MAX_INPUT_FILE_BYTES = 50 * 1024 * 1024

const FINALIZE_TIMEOUT_MS = 30_000
const FINALIZE_RETRY_DELAY_MS = 250
const FILE_USE_CASE = "codex"

type FetchFunction = typeof fetch

type CreateHostedFileResponse = {
	fileId: string
	uploadUrl: string
	needsPdfReservation: boolean
}

type FinalizeHostedFileResponse = {
	status: string
	downloadUrl?: string
	filename?: string
	mimeType?: string
	bytes?: number
	errorMessage?: string
}

export type HostedInputFile = {
	id: string
	bytes: number
	createdAt: number
	downloadUrl: string
	filename: string
	mimeType?: string
	purpose: string
}

export class HostedFileError extends Error {
	readonly status: number
	readonly type: string

	constructor(message: string, status = 400, type = "invalid_request_error") {
		super(message)
		this.name = "HostedFileError"
		this.status = status
		this.type = type
	}
}

const parseJsonObject = async (
	response: Response,
	operation: string,
): Promise<Record<string, unknown>> => {
	const bodyText = await response.text()
	if (!response.ok) {
		let message = bodyText
		try {
			const parsed = JSON.parse(bodyText)
			if (isRecord(parsed)) {
				const error = isRecord(parsed.error) ? parsed.error.message : undefined
				const detail = parsed.detail ?? parsed.message ?? error
				if (typeof detail === "string" && detail.length > 0) {
					message = detail
				}
			}
		} catch {}

		throw new HostedFileError(
			`${operation} failed with HTTP ${response.status}${message ? `: ${message}` : "."}`,
			response.status,
			"upstream_error",
		)
	}

	try {
		const parsed = JSON.parse(bodyText)
		if (isRecord(parsed)) {
			return parsed
		}
	} catch {}

	throw new HostedFileError(
		`${operation} returned malformed JSON.`,
		502,
		"upstream_error",
	)
}

const toCreateResponse = (
	payload: Record<string, unknown>,
): CreateHostedFileResponse => {
	if (
		typeof payload.file_id !== "string" ||
		typeof payload.upload_url !== "string"
	) {
		throw new HostedFileError(
			"ChatGPT file creation did not return a file ID and upload URL.",
			502,
			"upstream_error",
		)
	}

	return {
		fileId: payload.file_id,
		uploadUrl: payload.upload_url,
		needsPdfReservation: payload.pdf_c2pa_reservation === true,
	}
}

const toFinalizeResponse = (
	payload: Record<string, unknown>,
): FinalizeHostedFileResponse => ({
	status: typeof payload.status === "string" ? payload.status : "error",
	downloadUrl:
		typeof payload.download_url === "string" ? payload.download_url : undefined,
	filename:
		typeof payload.file_name === "string" ? payload.file_name : undefined,
	mimeType:
		typeof payload.mime_type === "string" ? payload.mime_type : undefined,
	bytes:
		typeof payload.file_size_bytes === "number"
			? payload.file_size_bytes
			: undefined,
	errorMessage:
		typeof payload.error_message === "string"
			? payload.error_message
			: undefined,
})

const waitForRetry = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, FINALIZE_RETRY_DELAY_MS))

const assertUploadURL = (value: string): URL => {
	let url: URL
	try {
		url = new URL(value)
	} catch {
		throw new HostedFileError(
			"ChatGPT returned an invalid file upload URL.",
			502,
			"upstream_error",
		)
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new HostedFileError(
			"ChatGPT returned an unsupported file upload URL.",
			502,
			"upstream_error",
		)
	}
	return url
}

const toOpenAIFileObject = (file: HostedInputFile) => ({
	id: file.id,
	object: "file",
	bytes: file.bytes,
	created_at: file.createdAt,
	filename: file.filename,
	purpose: file.purpose,
	status: "processed",
	status_details: null,
})

export class HostedInputFileStore {
	readonly #client: OpenAIOAuthTransport
	readonly #fetch: FetchFunction
	readonly #files = new Map<string, HostedInputFile>()

	constructor(client: OpenAIOAuthTransport, fetchImpl?: FetchFunction) {
		this.#client = client
		this.#fetch = fetchImpl ?? globalThis.fetch.bind(globalThis)
	}

	list(): HostedInputFile[] {
		return [...this.#files.values()]
	}

	get(fileId: string): HostedInputFile | undefined {
		return this.#files.get(fileId)
	}

	async upload(
		file: File,
		purpose: string,
		signal?: AbortSignal,
	): Promise<HostedInputFile> {
		if (file.size === 0) {
			throw new HostedFileError("Uploaded file must not be empty.")
		}
		if (file.size > MAX_INPUT_FILE_BYTES) {
			throw new HostedFileError(
				`Uploaded file is ${file.size} bytes; input files may be at most ${MAX_INPUT_FILE_BYTES} bytes.`,
			)
		}

		const filename = file.name.trim() || "upload"
		if (filename.length > 512) {
			throw new HostedFileError("Uploaded filename is too long.")
		}

		const createBody = {
			file_name: filename,
			file_size: file.size,
			use_case: FILE_USE_CASE,
		}
		const createResponse = await this.#client.requestChatGPT("/files", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(createBody),
			signal,
		})
		const created = toCreateResponse(
			await parseJsonObject(createResponse, "ChatGPT file creation"),
		)

		const uploadUrl = assertUploadURL(created.uploadUrl)
		const uploadResponse = await this.#fetch(uploadUrl, {
			method: "PUT",
			headers: {
				"Content-Length": String(file.size),
				"x-ms-blob-type": "BlockBlob",
				"x-ms-client-request-id": crypto.randomUUID(),
			},
			body: file,
			signal,
		})
		if (!uploadResponse.ok) {
			throw new HostedFileError(
				`File blob upload to ${uploadUrl.host} failed with HTTP ${uploadResponse.status}.`,
				502,
				"upstream_error",
			)
		}

		const finalized = await this.#finalize(
			created.fileId,
			created.needsPdfReservation
				? { pdf_c2pa_create_request: createBody }
				: {},
			signal,
		)
		const hosted: HostedInputFile = {
			id: created.fileId,
			bytes: finalized.bytes ?? file.size,
			createdAt: Math.floor(Date.now() / 1000),
			downloadUrl: finalized.downloadUrl,
			filename: finalized.filename ?? filename,
			mimeType: finalized.mimeType || file.type || undefined,
			purpose,
		}
		this.#files.set(hosted.id, hosted)
		return hosted
	}

	async resolve(
		fileId: string,
		signal?: AbortSignal,
	): Promise<HostedInputFile> {
		const existing = this.#files.get(fileId)
		if (existing) {
			return existing
		}

		const finalized = await this.#finalize(fileId, {}, signal)
		const hosted: HostedInputFile = {
			id: fileId,
			bytes: finalized.bytes ?? 0,
			createdAt: Math.floor(Date.now() / 1000),
			downloadUrl: finalized.downloadUrl,
			filename: finalized.filename ?? fileId,
			mimeType: finalized.mimeType,
			purpose: "user_data",
		}
		this.#files.set(hosted.id, hosted)
		return hosted
	}

	async #finalize(
		fileId: string,
		body: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<FinalizeHostedFileResponse & { downloadUrl: string }> {
		const deadline = Date.now() + FINALIZE_TIMEOUT_MS
		while (true) {
			const response = await this.#client.requestChatGPT(
				`/files/${encodeURIComponent(fileId)}/uploaded`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
					signal,
				},
			)
			const finalized = toFinalizeResponse(
				await parseJsonObject(response, "ChatGPT file finalization"),
			)
			if (finalized.status === "success" && finalized.downloadUrl) {
				return { ...finalized, downloadUrl: finalized.downloadUrl }
			}
			if (finalized.status !== "retry") {
				throw new HostedFileError(
					finalized.errorMessage ??
						`ChatGPT could not finalize file ${fileId}.`,
					502,
					"upstream_error",
				)
			}
			if (Date.now() >= deadline) {
				throw new HostedFileError(
					`ChatGPT file ${fileId} was not ready within ${FINALIZE_TIMEOUT_MS} ms.`,
					504,
					"upstream_error",
				)
			}
			await waitForRetry()
		}
	}
}

const isUploadedFile = (value: FormDataEntryValue | null): value is File =>
	typeof value === "object" &&
	value !== null &&
	typeof (value as File).name === "string" &&
	typeof (value as File).size === "number" &&
	typeof (value as File).arrayBuffer === "function"

export const handleFileUploadRequest = async (
	request: Request,
	store: HostedInputFileStore,
): Promise<Response> => {
	let form: FormData
	try {
		form = await request.formData()
	} catch {
		return toErrorResponse(
			"Request must be multipart/form-data with a `file` field.",
		)
	}

	const file = form.get("file")
	if (!isUploadedFile(file)) {
		return toErrorResponse("Multipart field `file` must contain a file.")
	}
	const rawPurpose = form.get("purpose")
	const purpose = typeof rawPurpose === "string" ? rawPurpose.trim() : ""
	if (!purpose) {
		return toErrorResponse("Multipart field `purpose` must be a string.")
	}

	try {
		return toJsonResponse(
			toOpenAIFileObject(await store.upload(file, purpose, request.signal)),
		)
	} catch (error) {
		if (error instanceof HostedFileError) {
			return toErrorResponse(error.message, error.status, error.type)
		}
		throw error
	}
}

export const handleFileListRequest = (store: HostedInputFileStore): Response =>
	toJsonResponse({
		object: "list",
		data: store.list().map(toOpenAIFileObject),
		has_more: false,
	})

export const handleFileRetrieveRequest = async (
	request: Request,
	store: HostedInputFileStore,
	fileId: string,
): Promise<Response> => {
	try {
		return toJsonResponse(
			toOpenAIFileObject(await store.resolve(fileId, request.signal)),
		)
	} catch (error) {
		if (error instanceof HostedFileError) {
			return toErrorResponse(error.message, error.status, error.type)
		}
		throw error
	}
}

const resolveInputValue = async (
	value: unknown,
	store: HostedInputFileStore,
	signal: AbortSignal,
	state: { bytes: number },
): Promise<unknown> => {
	if (Array.isArray(value)) {
		return Promise.all(
			value.map((item) => resolveInputValue(item, store, signal, state)),
		)
	}
	if (!isRecord(value)) {
		return value
	}

	if (value.type === "input_file" && typeof value.file_id === "string") {
		const file = await store.resolve(value.file_id, signal)
		state.bytes += file.bytes
		if (state.bytes > MAX_INPUT_FILE_BYTES) {
			throw new HostedFileError(
				`Combined input files exceed the ${MAX_INPUT_FILE_BYTES}-byte request limit.`,
			)
		}
		return {
			type: "input_file",
			file_url: file.downloadUrl,
			...(value.detail === "low" ||
			value.detail === "high" ||
			value.detail === "auto"
				? { detail: value.detail }
				: {}),
		}
	}

	const entries = await Promise.all(
		Object.entries(value).map(async ([key, item]) => [
			key,
			await resolveInputValue(item, store, signal, state),
		]),
	)
	return Object.fromEntries(entries)
}

export const resolveHostedInputFiles = async (
	body: Record<string, unknown>,
	store: HostedInputFileStore,
	signal: AbortSignal,
): Promise<Record<string, unknown>> => {
	if (!Array.isArray(body.input)) {
		return body
	}

	return {
		...body,
		input: await resolveInputValue(body.input, store, signal, { bytes: 0 }),
	}
}
