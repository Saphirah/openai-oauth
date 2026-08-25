import { describe, expect, test, vi } from "vitest"
import {
	CODEX_ATTESTATION_TIMEOUT_MS,
	codexAttestationEnvelope,
	resolveCodexAttestation,
} from "../src/index.js"

describe("Codex attestation envelope", () => {
	test("matches the Codex app-server wire shape", async () => {
		expect(codexAttestationEnvelope(0, "v1.opaque")).toBe(
			'{"v":1,"s":0,"t":"v1.opaque"}',
		)
		expect(codexAttestationEnvelope(1)).toBe('{"v":1,"s":1}')
		await expect(
			resolveCodexAttestation(async () => "v1.opaque", {
				sessionId: "thread-1",
			}),
		).resolves.toEqual({
			header: '{"v":1,"s":0,"t":"v1.opaque"}',
			status: 0,
		})
	})

	test("omits the header when no host opted into attestation", async () => {
		await expect(
			resolveCodexAttestation(undefined, { sessionId: "thread-1" }),
		).resolves.toEqual({})
	})

	test("maps provider failure and timeout to Codex status codes", async () => {
		await expect(
			resolveCodexAttestation(
				async () => {
					throw new Error("secret must not escape")
				},
				{ sessionId: "thread-1" },
			),
		).resolves.toEqual({ header: '{"v":1,"s":2}', status: 2 })

		vi.useFakeTimers()
		try {
			const result = resolveCodexAttestation(
				() => new Promise(() => undefined),
				{ sessionId: "thread-1" },
			)
			await vi.advanceTimersByTimeAsync(CODEX_ATTESTATION_TIMEOUT_MS)
			await expect(result).resolves.toEqual({
				header: '{"v":1,"s":1}',
				status: 1,
			})
		} finally {
			vi.useRealTimers()
		}
	})
})
