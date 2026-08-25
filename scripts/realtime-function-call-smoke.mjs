import WebSocket from "ws"

const apiKey = process.env.OPENAI_API_KEY
if (!apiKey) throw new Error("OPENAI_API_KEY is required.")

const model = process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-1.5"
const socket = new WebSocket(
	`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`,
	{ headers: { Authorization: `Bearer ${apiKey}` } },
)

const summary = {
	model,
	sessionUpdated: false,
	functionCall: undefined,
	functionOutputSent: false,
	assistantContinuation: "",
}

const send = (event) => socket.send(JSON.stringify(event))
const timeout = setTimeout(() => {
	console.error(JSON.stringify({ ...summary, error: "timeout" }, null, 2))
	socket.close()
	process.exitCode = 1
}, 45_000)

socket.on("open", () => {
	send({
		type: "session.update",
		session: {
			type: "realtime",
			model,
			output_modalities: ["text"],
			instructions:
				"This is a deterministic function-call test. Call add_numbers exactly once with a=2 and b=3. After receiving the result, answer exactly: The result is 5.",
			tools: [
				{
					type: "function",
					name: "add_numbers",
					description: "Add two integer values.",
					parameters: {
						type: "object",
						properties: {
							a: { type: "integer", description: "First value." },
							b: { type: "integer", description: "Second value." },
						},
						required: ["a", "b"],
						additionalProperties: false,
					},
				},
			],
			tool_choice: "required",
		},
	})
})

socket.on("message", (data) => {
	const event = JSON.parse(data.toString())
	if (event.type === "error") {
		clearTimeout(timeout)
		console.error(
			JSON.stringify(
				{ ...summary, error: event.error?.message ?? event },
				null,
				2,
			),
		)
		socket.close()
		process.exitCode = 1
		return
	}
	if (event.type === "session.updated" && !summary.sessionUpdated) {
		summary.sessionUpdated = true
		send({
			type: "conversation.item.create",
			item: {
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "What is 2 plus 3?" }],
			},
		})
		send({ type: "response.create" })
		return
	}
	if (
		event.type === "response.function_call_arguments.done" &&
		!summary.functionOutputSent
	) {
		summary.functionCall = {
			name: event.name,
			callId: event.call_id,
			arguments: JSON.parse(event.arguments),
		}
		send({
			type: "session.update",
			session: { type: "realtime", tool_choice: "none" },
		})
		send({
			type: "conversation.item.create",
			item: {
				type: "function_call_output",
				call_id: event.call_id,
				output: JSON.stringify({ result: 5 }),
			},
		})
		summary.functionOutputSent = true
		send({ type: "response.create" })
		return
	}
	if (
		event.type === "response.output_text.done" &&
		summary.functionOutputSent
	) {
		summary.assistantContinuation = event.text
		clearTimeout(timeout)
		console.log(JSON.stringify(summary, null, 2))
		socket.close()
	}
})

socket.on("error", (error) => {
	clearTimeout(timeout)
	console.error(JSON.stringify({ ...summary, error: error.message }, null, 2))
	process.exitCode = 1
})
