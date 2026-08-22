import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test, vi } from "vitest"
import { createOpenAIOAuthFetchHandler } from "../src/index.js"

const createAuthFile = async (): Promise<string> => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "openai-oauth-files-"))
	const authPath = path.join(root, "auth.json")
	await fs.writeFile(
		authPath,
		JSON.stringify({
			tokens: {
				access_token: "access-token",
				account_id: "acct-1",
			},
		}),
		"utf-8",
	)
	return authPath
}

const completedResponse = (): Response =>
	new Response(
		[
			"event: response.created",
			'data: {"type":"response.created","response":{"id":"resp_pdf","status":"in_progress"}}',
			"",
			"event: response.completed",
			'data: {"type":"response.completed","response":{"id":"resp_pdf","status":"completed","output":[]}}',
			"",
			"",
		].join("\n"),
		{ headers: { "Content-Type": "text/event-stream" } },
	)

describe("hosted input files", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	test("uploads a PDF and resolves its file ID in a Responses request", async () => {
		const authFilePath = await createAuthFile()
		let responseBody: Record<string, unknown> | undefined
		let finalizeAttempts = 0
		const fetch = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input)
				if (url.endsWith("/backend-api/files")) {
					expect(new Headers(init?.headers).get("authorization")).toBe(
						"Bearer access-token",
					)
					expect(JSON.parse(String(init?.body))).toEqual({
						file_name: "report.pdf",
						file_size: 8,
						use_case: "codex",
					})
					return Response.json({
						file_id: "file_pdf",
						upload_url: "https://blob.example/upload/file_pdf?sig=secret",
						pdf_c2pa_reservation: true,
					})
				}
				if (url.startsWith("https://blob.example/upload/file_pdf")) {
					const headers = new Headers(init?.headers)
					expect(headers.get("authorization")).toBeNull()
					expect(headers.get("content-length")).toBe("8")
					expect(headers.get("x-ms-blob-type")).toBe("BlockBlob")
					expect(init?.body).toBeInstanceOf(Blob)
					return new Response(null, { status: 201 })
				}
				if (url.endsWith("/backend-api/files/file_pdf/uploaded")) {
					finalizeAttempts += 1
					expect(JSON.parse(String(init?.body))).toEqual({
						pdf_c2pa_create_request: {
							file_name: "report.pdf",
							file_size: 8,
							use_case: "codex",
						},
					})
					if (finalizeAttempts === 1) {
						return Response.json({ status: "retry" })
					}
					return Response.json({
						status: "success",
						download_url: "https://blob.example/download/file_pdf?sig=download",
						file_name: "report.pdf",
						file_size_bytes: 8,
						mime_type: "application/pdf",
					})
				}
				if (url.includes("/backend-api/codex/models?")) {
					return Response.json({
						models: [{ slug: "gpt-5.6-terra", visibility: "list" }],
					})
				}
				if (url.endsWith("/backend-api/codex/responses")) {
					responseBody = JSON.parse(String(init?.body))
					return completedResponse()
				}
				throw new Error(`Unexpected request: ${url}`)
			},
		)
		const handler = createOpenAIOAuthFetchHandler({
			authFilePath,
			codexVersion: "0.144.1",
			ensureFresh: false,
			fetch,
		})

		const form = new FormData()
		form.set(
			"file",
			new Blob(["%PDF-1.4"], { type: "application/pdf" }),
			"report.pdf",
		)
		form.set("purpose", "user_data")
		const upload = await handler(
			new Request("http://localhost/v1/files", {
				method: "POST",
				body: form,
			}),
		)

		expect(upload.status).toBe(200)
		await expect(upload.json()).resolves.toMatchObject({
			id: "file_pdf",
			object: "file",
			bytes: 8,
			filename: "report.pdf",
			purpose: "user_data",
			status: "processed",
		})
		expect(finalizeAttempts).toBe(2)

		const list = await handler(new Request("http://localhost/v1/files"))
		await expect(list.json()).resolves.toMatchObject({
			object: "list",
			has_more: false,
			data: [{ id: "file_pdf", filename: "report.pdf" }],
		})
		const retrieve = await handler(
			new Request("http://localhost/v1/files/file_pdf"),
		)
		await expect(retrieve.json()).resolves.toMatchObject({
			id: "file_pdf",
			filename: "report.pdf",
		})

		const response = await handler(
			new Request("http://localhost/v1/responses", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "gpt-5.6-terra",
					stream: false,
					input: [
						{
							role: "user",
							content: [
								{
									type: "input_file",
									file_id: "file_pdf",
									detail: "high",
								},
								{ type: "input_text", text: "Summarize it." },
							],
						},
					],
				}),
			}),
		)

		expect(response.status).toBe(200)
		expect(responseBody).toMatchObject({
			model: "gpt-5.6-terra",
			input: [
				{
					role: "user",
					content: [
						{
							type: "input_file",
							file_url: "https://blob.example/download/file_pdf?sig=download",
							detail: "high",
						},
						{ type: "input_text", text: "Summarize it." },
					],
				},
			],
		})
		expect(JSON.stringify(responseBody).includes('"file_id":"file_pdf"')).toBe(
			false,
		)

		await fs.rm(path.dirname(authFilePath), {
			recursive: true,
			force: true,
		})
	}, 30_000)

	test("rejects malformed uploads before contacting ChatGPT", async () => {
		const fetch = vi.fn()
		const handler = createOpenAIOAuthFetchHandler({ fetch })
		const form = new FormData()
		form.set("purpose", "user_data")

		const response = await handler(
			new Request("http://localhost/v1/files", {
				method: "POST",
				body: form,
			}),
		)

		expect(response.status).toBe(400)
		await expect(response.json()).resolves.toEqual({
			error: {
				message: "Multipart field `file` must contain a file.",
				type: "invalid_request_error",
			},
		})
		expect(fetch).not.toHaveBeenCalled()
	})
})
