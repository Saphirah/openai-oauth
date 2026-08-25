import { describe, expect, test } from "vitest"
import {
	CODEX_REALTIME_REFERENCE_COMMIT,
	chunkCodexFramelessContext,
	createCodexDelegationContextEvents,
	createCodexFramelessSession,
	DEFAULT_CODEX_FRAMELESS_MODEL,
	parseCodexFramelessEvent,
} from "../src/index.js"

describe("Codex Frameless v3 protocol", () => {
	test("is pinned to the current Codex source revision and default model", () => {
		expect(CODEX_REALTIME_REFERENCE_COMMIT).toBe(
			"068c49f075cf287a1fe7d1ee36cf005efac922e7",
		)
		expect(DEFAULT_CODEX_FRAMELESS_MODEL).toBe("gpt-live-1-codex")
	})

	test("builds the exact Codex Frameless call session shape", () => {
		expect(
			createCodexFramelessSession({
				instructions: "Be concise.",
				voice: "cove",
				delegationAckFiller: false,
				initialItems: [
					{ role: "developer", text: "Remember this." },
					{ role: "assistant", text: "Understood." },
				],
			}),
		).toEqual({
			model: "gpt-live-1-codex",
			instructions: "Be concise.",
			audio: { output: { voice: "cove" } },
			delegation: { type: "client", ack_filler: false },
			initial_items: [
				{
					type: "message",
					role: "developer",
					content: [{ type: "input_text", text: "Remember this." }],
				},
				{
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: "Understood." }],
				},
			],
		})
	})

	test("chunks context on UTF-8 boundaries at 500 bytes", () => {
		const text = `${"a".repeat(498)}€${"b".repeat(4)}`
		const chunks = chunkCodexFramelessContext(text)
		expect(chunks.join("")).toBe(text)
		expect(
			chunks.map((chunk) => new TextEncoder().encode(chunk).byteLength),
		).toEqual([498, 7])
		expect(createCodexDelegationContextEvents("item-1", text)).toHaveLength(2)
	})

	test("parses native Frameless events without legacy aliases", () => {
		expect(
			parseCodexFramelessEvent({
				type: "output_audio.delta",
				audio: "AQI=",
			}),
		).toMatchObject({
			kind: "audio",
			audio: "AQI=",
			sampleRate: 24_000,
			channels: 1,
		})
		expect(
			parseCodexFramelessEvent({
				type: "input_transcript.added",
				item: { text: "hello" },
			}),
		).toMatchObject({
			kind: "transcript",
			role: "user",
			phase: "delta",
			text: "hello",
		})
		expect(
			parseCodexFramelessEvent({
				type: "turn.done",
				turn: { role: "assistant", transcript: "done" },
			}),
		).toMatchObject({ role: "assistant", phase: "done", text: "done" })
		expect(
			parseCodexFramelessEvent({
				type: "delegation.created",
				item: {
					id: "handoff-1",
					type: "delegation",
					target: "client",
					content: [
						{ type: "input_text", text: "run " },
						{ type: "input_text", text: "tests" },
					],
				},
			}),
		).toMatchObject({
			kind: "handoff",
			handoffId: "handoff-1",
			inputTranscript: "run tests",
		})
	})
})
