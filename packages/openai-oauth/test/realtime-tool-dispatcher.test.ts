import { describe, expect, test, vi } from "vitest"
import {
	RealtimeToolDispatcher,
	type RealtimeToolExecutionContext,
} from "../src/index.js"

describe("RealtimeToolDispatcher", () => {
	test("selects, validates, executes, reports progress, and deduplicates by call id", async () => {
		const execute = vi.fn(
			async (
				argumentsValue: unknown,
				context: RealtimeToolExecutionContext,
			) => {
				context.reportProgress("Switching the light now.")
				return {
					room: (argumentsValue as { room: string }).room,
					state: "on",
				}
			},
		)
		const selectTool = vi.fn(async (request) => {
			expect(request.callId).toBe("delegation-1")
			expect(request.input).toBe("Turn on the kitchen light")
			expect(request.tools).toEqual([
				{
					name: "set_light",
					description: "Set a room light.",
					parameters: expect.objectContaining({ type: "object" }),
				},
			])
			return {
				name: "set_light",
				arguments: JSON.stringify({ room: "kitchen", state: "on" }),
			}
		})
		const dispatcher = new RealtimeToolDispatcher({
			tools: [
				{
					name: "set_light",
					description: "Set a room light.",
					parameters: {
						type: "object",
						properties: {
							room: { type: "string" },
							state: { enum: ["on", "off"] },
						},
						required: ["room", "state"],
						additionalProperties: false,
					},
					execute,
				},
			],
			selectTool,
		})
		const progress: string[] = []
		const request = {
			callId: "delegation-1",
			input: "Turn on the kitchen light",
			reportProgress: (text: string) => progress.push(text),
		}

		const first = dispatcher.dispatch(request)
		const duplicate = dispatcher.dispatch(request)
		expect(duplicate).toBe(first)
		await expect(first).resolves.toEqual({
			callId: "delegation-1",
			name: "set_light",
			ok: true,
			output: 'Tool set_light completed.\n{"room":"kitchen","state":"on"}',
		})
		expect(progress).toEqual(["Switching the light now."])
		expect(selectTool).toHaveBeenCalledTimes(1)
		expect(execute).toHaveBeenCalledTimes(1)
	})

	test("rejects invalid selected arguments before invoking the handler", async () => {
		const execute = vi.fn()
		const dispatcher = new RealtimeToolDispatcher({
			tools: [
				{
					name: "set_temperature",
					parameters: {
						type: "object",
						properties: { celsius: { type: "number" } },
						required: ["celsius"],
						additionalProperties: false,
					},
					execute,
				},
			],
			selectTool: async () => ({
				name: "set_temperature",
				arguments: { celsius: "warm" },
			}),
		})

		const result = await dispatcher.dispatch({
			callId: "delegation-invalid",
			input: "Make it warm",
		})
		expect(result).toMatchObject({
			callId: "delegation-invalid",
			name: "set_temperature",
			ok: false,
			output: expect.stringContaining("Invalid arguments"),
		})
		expect(execute).not.toHaveBeenCalled()
	})
})
