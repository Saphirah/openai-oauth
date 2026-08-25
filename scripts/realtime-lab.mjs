import { startOpenAIOAuthServer } from "../packages/openai-oauth/dist/index.js"
import { createRealtimeLabWeatherTools } from "../packages/openai-oauth/dist/realtime-lab-weather.js"

const port = Number.parseInt(process.env.OPENAI_OAUTH_PORT ?? "10531", 10)
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
	throw new Error("OPENAI_OAUTH_PORT must be an integer between 0 and 65535.")
}

const server = await startOpenAIOAuthServer({
	port,
	models: ["gpt-5.2"],
	realtimeTools: createRealtimeLabWeatherTools(),
})
const labUrl = server.url.replace(/\/v1$/, "/realtime")

console.log(`Realtime Voice Lab: ${labUrl}`)

const close = async () => {
	await server.close()
	process.exit(0)
}

process.once("SIGINT", () => void close())
process.once("SIGTERM", () => void close())
