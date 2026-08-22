import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { startOpenAIOAuthServer } from "../src/index.js"

const liveTest = process.env.LIVE_CODEX_E2E === "1" ? test : test.skip
const codeword = "OAUTH_PDF_CODE_7319"

const createPdf = (text: string): Uint8Array => {
	const stream = `BT\n/F1 18 Tf\n72 720 Td\n(${text}) Tj\nET`
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
	]
	let pdf = "%PDF-1.4\n"
	const offsets = [0]
	for (const [index, object] of objects.entries()) {
		offsets.push(pdf.length)
		pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
	}
	const xref = pdf.length
	pdf += `xref\n0 ${objects.length + 1}\n`
	pdf += "0000000000 65535 f \n"
	for (const offset of offsets.slice(1)) {
		pdf += `${String(offset).padStart(10, "0")} 00000 n \n`
	}
	pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`
	pdf += `startxref\n${xref}\n%%EOF\n`
	return new TextEncoder().encode(pdf)
}

describe("hosted input files live e2e", () => {
	let stop: (() => Promise<void>) | undefined
	let baseURL = ""

	beforeAll(async () => {
		const running = await startOpenAIOAuthServer({
			host: "127.0.0.1",
			port: 0,
		})
		stop = running.close
		baseURL = running.url
	})

	afterAll(async () => {
		await stop?.()
	})

	liveTest(
		"uploads a PDF through ChatGPT OAuth and reads it with Responses",
		async () => {
			const form = new FormData()
			form.set(
				"file",
				new Blob([createPdf(codeword)], { type: "application/pdf" }),
				"codeword.pdf",
			)
			form.set("purpose", "user_data")
			const upload = await fetch(`${baseURL}/files`, {
				method: "POST",
				body: form,
			})
			const uploaded = await upload.json()
			expect(upload.ok, JSON.stringify(uploaded)).toBe(true)
			expect(uploaded.id).toMatch(/^file/)

			const response = await fetch(`${baseURL}/responses`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "gpt-5.6-terra",
					stream: false,
					input: [
						{
							role: "user",
							content: [
								{ type: "input_file", file_id: uploaded.id },
								{
									type: "input_text",
									text: "Return only the exact codeword printed in this PDF.",
								},
							],
						},
					],
				}),
			})
			const result = await response.json()
			expect(response.ok, JSON.stringify(result)).toBe(true)
			const outputText = result.output
				?.flatMap((item: { content?: unknown[] }) => item.content ?? [])
				.find((item: { type?: string }) => item.type === "output_text")?.text
			expect(outputText?.trim()).toBe(codeword)
		},
		120_000,
	)
})
