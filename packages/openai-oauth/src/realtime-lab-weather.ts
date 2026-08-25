import type { RealtimeToolDispatcherOptions } from "./realtime-tool-dispatcher.js"

type WeatherArguments = { location: string }

type OpenMeteoGeocodingResponse = {
	results?: Array<{
		name: string
		country?: string
		latitude: number
		longitude: number
	}>
}

type OpenMeteoForecastResponse = {
	current?: {
		time?: string
		temperature_2m?: number
		apparent_temperature?: number
		relative_humidity_2m?: number
		weather_code?: number
		wind_speed_10m?: number
	}
	current_units?: Record<string, string>
}

const weatherTerms =
	/\b(?:wetter|temperatur|regen|wind|weather|temperature|rain|forecast)\b/iu

const extractWeatherLocation = (input: string): string | undefined => {
	if (!weatherTerms.test(input)) return undefined
	const normalized = input.trim().replace(/[?!.]+$/u, "")
	const match = normalized.match(
		/(?:\bin|\bfür|\bfor|\bat)\s+([\p{L}\p{M}][\p{L}\p{M}\s'-]*?)(?=\s+(?:heute|jetzt|today|now)\b|[?!.;,]|$)/iu,
	)
	return match?.[1]?.trim()
}

const weatherDescription = (code: number | undefined): string => {
	if (code === 0) return "klar"
	if (code === 1) return "überwiegend klar"
	if (code === 2) return "teilweise bewölkt"
	if (code === 3) return "bedeckt"
	if (code === 45 || code === 48) return "neblig"
	if (code === 51 || code === 53 || code === 55) return "Nieselregen"
	if (code === 56 || code === 57) return "gefrierender Nieselregen"
	if (code === 61 || code === 63 || code === 65) return "Regen"
	if (code === 66 || code === 67) return "gefrierender Regen"
	if (code === 71 || code === 73 || code === 75 || code === 77) return "Schnee"
	if (code === 80 || code === 81 || code === 82) return "Regenschauer"
	if (code === 85 || code === 86) return "Schneeschauer"
	if (code === 95 || code === 96 || code === 99) return "Gewitter"
	return "unbekannte Wetterlage"
}

const readJson = async <T>(
	response: Response,
	operation: string,
): Promise<T> => {
	if (!response.ok) {
		throw new Error(`${operation} failed with HTTP ${response.status}.`)
	}
	return (await response.json()) as T
}

export const createRealtimeLabWeatherTools = (
	fetchImplementation: typeof fetch = globalThis.fetch,
): RealtimeToolDispatcherOptions => ({
	tools: [
		{
			name: "get_weather",
			description: "Aktuelles Wetter für einen Ort über Open-Meteo abrufen.",
			parameters: {
				type: "object",
				properties: {
					location: {
						type: "string",
						minLength: 1,
						description: "Stadt oder Ortsname, zum Beispiel Berlin.",
					},
				},
				required: ["location"],
				additionalProperties: false,
			},
			async execute(argumentsValue, context) {
				const { location } = argumentsValue as WeatherArguments
				context.reportProgress(
					`Aktuelles Wetter für ${location} wird abgerufen.`,
				)
				const geocodingUrl = new URL(
					"https://geocoding-api.open-meteo.com/v1/search",
				)
				geocodingUrl.search = new URLSearchParams({
					name: location,
					count: "1",
					language: "de",
					format: "json",
				}).toString()
				const geocoding = await readJson<OpenMeteoGeocodingResponse>(
					await fetchImplementation(geocodingUrl),
					"Open-Meteo geocoding",
				)
				const place = geocoding.results?.[0]
				if (!place) throw new Error(`Ort nicht gefunden: ${location}`)

				const forecastUrl = new URL("https://api.open-meteo.com/v1/forecast")
				forecastUrl.search = new URLSearchParams({
					latitude: String(place.latitude),
					longitude: String(place.longitude),
					current:
						"temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m",
					timezone: "auto",
				}).toString()
				const forecast = await readJson<OpenMeteoForecastResponse>(
					await fetchImplementation(forecastUrl),
					"Open-Meteo forecast",
				)
				const current = forecast.current
				if (!current || current.temperature_2m === undefined) {
					throw new Error(
						`Keine aktuellen Wetterdaten für ${place.name} erhalten.`,
					)
				}
				const units = forecast.current_units ?? {}
				const resolvedPlace = [place.name, place.country]
					.filter(Boolean)
					.join(", ")
				return [
					`Aktuelles Wetter in ${resolvedPlace}: ${weatherDescription(current.weather_code)}, ${current.temperature_2m}${units.temperature_2m ?? " °C"}`,
					current.apparent_temperature === undefined
						? undefined
						: `gefühlt ${current.apparent_temperature}${units.apparent_temperature ?? " °C"}`,
					current.relative_humidity_2m === undefined
						? undefined
						: `Luftfeuchtigkeit ${current.relative_humidity_2m}${units.relative_humidity_2m ?? " %"}`,
					current.wind_speed_10m === undefined
						? undefined
						: `Wind ${current.wind_speed_10m}${units.wind_speed_10m ?? " km/h"}`,
					current.time ? `Stand ${current.time} Ortszeit` : undefined,
				]
					.filter(Boolean)
					.join(", ")
			},
		},
	],
	selectTool: ({ input }) => {
		const location = extractWeatherLocation(input)
		return location ? { name: "get_weather", arguments: { location } } : null
	},
})
