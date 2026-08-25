import { describe, expect, test, vi } from "vitest"
import { createOpenAIOAuthFetchHandler } from "../src/index.js"

describe("Realtime Voice Lab", () => {
	test("serves a manual-start browser test page without credentials", async () => {
		const handler = createOpenAIOAuthFetchHandler({ models: ["gpt-5.2"] })
		const response = await handler(new Request("http://127.0.0.1/realtime"))
		const html = await response.text()

		expect(response.status).toBe(200)
		expect(response.headers.get("content-type")).toBe(
			"text/html; charset=utf-8",
		)
		expect(response.headers.get("content-security-policy")).toContain(
			"connect-src 'self' ws: wss:",
		)
		expect(html).toContain("Codex Frameless v3")
		expect(html).toContain("Start & Mikrofon freigeben")
		expect(html).toContain('id="start" type="button" disabled')
		expect(html).toContain('id="mute-microphone"')
		expect(html).toContain('id="pitch" type="range"')
		expect(html).toContain('id="test-tools"')
		expect(html).toContain("Wie ist das Wetter in Berlin?")
		expect(html).toContain("Pitch zurücksetzen")
		expect(html).toContain("/realtime/client.js")
		expect(html).not.toContain("Protokollereignisse")
		expect(html).not.toContain("access_token")
	})

	test("serves the browser pitch-shifting AudioWorklet", async () => {
		const handler = createOpenAIOAuthFetchHandler({ models: ["gpt-5.2"] })
		const response = await handler(
			new Request("http://127.0.0.1/realtime/pitch-worklet.js"),
		)
		const source = await response.text()

		expect(response.status).toBe(200)
		expect(response.headers.get("content-type")).toBe(
			"text/javascript; charset=utf-8",
		)
		expect(source).toContain(
			'registerProcessor("realtime-pitch-shifter", RealtimePitchShifter)',
		)
		expect(source).toContain("Math.pow(2, this.semitones / 12)")
	})

	test("reports the current Codex protocol without invoking attestation", async () => {
		const realtimeAttestation = vi.fn(async () => "host-token")
		const handler = createOpenAIOAuthFetchHandler({
			models: ["gpt-5.2"],
			realtimeAttestation,
		})
		const response = await handler(
			new Request("http://127.0.0.1/v1/realtime/diagnostics"),
		)

		expect(response.status).toBe(200)
		await expect(response.json()).resolves.toMatchObject({
			ok: true,
			protocol: "codex-frameless-v3",
			autoStart: false,
			referenceCommit: "068c49f075cf287a1fe7d1ee36cf005efac922e7",
			call: {
				localEndpoint: "/v1/realtime/calls",
				modelDefault: "gpt-live-1-codex",
			},
			attestation: { hostProviderConfigured: true },
			tools: { configured: false, names: [] },
			security: {
				browserReceivesOAuthTokens: false,
				browserReceivesAttestation: false,
			},
		})
		expect(realtimeAttestation).not.toHaveBeenCalled()
	})

	test("keeps the old prototype URL as an alias", async () => {
		const handler = createOpenAIOAuthFetchHandler({ models: ["gpt-5.2"] })
		const response = await handler(
			new Request("http://127.0.0.1/realtime-prototype"),
		)

		expect(response.status).toBe(200)
		expect(await response.text()).toContain("Realtime Voice Lab")
	})
})
