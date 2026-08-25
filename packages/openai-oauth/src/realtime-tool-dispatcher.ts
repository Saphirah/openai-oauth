import { Ajv, type ValidateFunction } from "ajv"
import type { JsonObject } from "./types.js"

export type RealtimeToolSchema = {
	name: string
	description?: string
	parameters: JsonObject
}

export type RealtimeToolSelection = {
	name: string
	arguments: unknown
}

export type RealtimeToolSelectionRequest = {
	callId: string
	input: string
	tools: RealtimeToolSchema[]
}

export type RealtimeToolExecutionContext = {
	callId: string
	input: string
	reportProgress: (text: string) => void
}

export type RealtimeToolDefinition = RealtimeToolSchema & {
	execute: (
		argumentsValue: unknown,
		context: RealtimeToolExecutionContext,
	) => unknown | Promise<unknown>
}

export type RealtimeToolDispatcherOptions = {
	tools: RealtimeToolDefinition[]
	/**
	 * Provider-agnostic tool selection boundary. Send `input` and `tools` to the
	 * AI backend of your choice and return its explicit name/arguments decision.
	 */
	selectTool: (
		request: RealtimeToolSelectionRequest,
	) => RealtimeToolSelection | null | Promise<RealtimeToolSelection | null>
	maxRememberedCalls?: number
}

export type RealtimeToolDispatchRequest = {
	callId: string
	input: string
	reportProgress?: (text: string) => void
}

export type RealtimeToolDispatchResult = {
	callId: string
	name?: string
	ok: boolean
	output: string
}

type RegisteredTool = {
	definition: RealtimeToolDefinition
	validate: ValidateFunction
}

const selectionArguments = (value: unknown): unknown => {
	if (typeof value !== "string") return value
	try {
		return JSON.parse(value)
	} catch {
		throw new Error("Tool arguments must be valid JSON.")
	}
}

const outputText = (value: unknown): string => {
	if (typeof value === "string") return value
	const serialized = JSON.stringify(value)
	return serialized === undefined ? String(value) : serialized
}

const errorText = (error: unknown): string =>
	error instanceof Error ? error.message : String(error)

/**
 * Executes generic application tools for Codex Frameless v3 handoffs.
 *
 * V3 does not expose arbitrary function schemas to the voice model. The
 * upstream `delegation.created` item id is therefore the stable call id, while
 * `selectTool` is the explicit application/AI-backend boundary that turns the
 * natural-language delegation into a registered name and arguments object.
 */
export class RealtimeToolDispatcher {
	private readonly calls = new Map<
		string,
		Promise<RealtimeToolDispatchResult>
	>()
	private readonly tools = new Map<string, RegisteredTool>()
	private readonly schemas: RealtimeToolSchema[]
	private readonly maxRememberedCalls: number

	constructor(private readonly options: RealtimeToolDispatcherOptions) {
		if (options.tools.length === 0) {
			throw new Error("At least one realtime tool must be registered.")
		}
		const ajv = new Ajv({ allErrors: true, strict: false })
		for (const definition of options.tools) {
			if (!definition.name.trim()) {
				throw new Error("Realtime tool names must not be empty.")
			}
			if (this.tools.has(definition.name)) {
				throw new Error(`Duplicate realtime tool name: ${definition.name}`)
			}
			this.tools.set(definition.name, {
				definition,
				validate: ajv.compile(definition.parameters),
			})
		}
		this.schemas = options.tools.map(({ name, description, parameters }) => ({
			name,
			...(description ? { description } : {}),
			parameters,
		}))
		this.maxRememberedCalls = Math.max(1, options.maxRememberedCalls ?? 1_024)
	}

	dispatch(
		request: RealtimeToolDispatchRequest,
	): Promise<RealtimeToolDispatchResult> {
		const existing = this.calls.get(request.callId)
		if (existing) return existing

		while (this.calls.size >= this.maxRememberedCalls) {
			const oldest = this.calls.keys().next().value
			if (typeof oldest !== "string") break
			this.calls.delete(oldest)
		}
		const result = this.dispatchOnce(request)
		this.calls.set(request.callId, result)
		return result
	}

	private async dispatchOnce(
		request: RealtimeToolDispatchRequest,
	): Promise<RealtimeToolDispatchResult> {
		let selectedName: string | undefined
		try {
			const selection = await this.options.selectTool({
				callId: request.callId,
				input: request.input,
				tools: this.schemas,
			})
			if (!selection) {
				throw new Error("The configured AI backend did not select a tool.")
			}
			selectedName = selection.name
			const registered = this.tools.get(selection.name)
			if (!registered) {
				throw new Error(`Unknown realtime tool: ${selection.name}`)
			}
			const argumentsValue = selectionArguments(selection.arguments)
			if (!registered.validate(argumentsValue)) {
				const details = registered.validate.errors
					?.map((error) => `${error.instancePath || "/"} ${error.message}`)
					.join("; ")
				throw new Error(
					`Invalid arguments for realtime tool ${selection.name}${details ? `: ${details}` : "."}`,
				)
			}
			const output = await registered.definition.execute(argumentsValue, {
				callId: request.callId,
				input: request.input,
				reportProgress: request.reportProgress ?? (() => {}),
			})
			return {
				callId: request.callId,
				name: selection.name,
				ok: true,
				output: `Tool ${selection.name} completed.\n${outputText(output)}`,
			}
		} catch (error) {
			return {
				callId: request.callId,
				...(selectedName ? { name: selectedName } : {}),
				ok: false,
				output: `Tool execution failed. ${errorText(error)}`,
			}
		}
	}
}
