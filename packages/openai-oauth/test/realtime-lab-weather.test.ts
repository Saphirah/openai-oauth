import { describe, expect, test, vi } from "vitest"
import { createRealtimeLabWeatherTools } from "../src/realtime-lab-weather.js"
import { RealtimeToolDispatcher } from "../src/realtime-tool-dispatcher.js"

describe("Realtime Lab get_weather tool", () => {
	test("selects Berlin, fetches Open-Meteo and returns speakable weather", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						results: [
							{
								name: "Berlin",
								country: "Deutschland",
								latitude: 52.52,
								longitude: 13.41,
							},
						],
					}),
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						current: {
							time: "2026-08-24T14:15",
							temperature_2m: 23.4,
							apparent_temperature: 22.8,
							relative_humidity_2m: 51,
							weather_code: 2,
							wind_speed_10m: 11.2,
						},
						current_units: {
							temperature_2m: "°C",
							apparent_temperature: "°C",
							relative_humidity_2m: "%",
							wind_speed_10m: "km/h",
						},
					}),
				),
			)
		const progress = vi.fn()
		const dispatcher = new RealtimeToolDispatcher(
			createRealtimeLabWeatherTools(fetchMock),
		)

		const result = await dispatcher.dispatch({
			callId: "weather-berlin-1",
			input: "Wie ist das Wetter in Berlin?",
			reportProgress: progress,
		})

		expect(result).toMatchObject({ ok: true, name: "get_weather" })
		expect(result.output).toContain("Berlin, Deutschland")
		expect(result.output).toContain("23.4°C")
		expect(result.output).toContain("teilweise bewölkt")
		expect(progress).toHaveBeenCalledWith(
			"Aktuelles Wetter für Berlin wird abgerufen.",
		)
		expect(fetchMock).toHaveBeenCalledTimes(2)
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
			"geocoding-api.open-meteo.com/v1/search",
		)
		expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
			"api.open-meteo.com/v1/forecast",
		)
	})

	test("does not invent a tool selection for unrelated delegations", async () => {
		const dispatcher = new RealtimeToolDispatcher(
			createRealtimeLabWeatherTools(vi.fn<typeof fetch>()),
		)
		const result = await dispatcher.dispatch({
			callId: "not-weather-1",
			input: "Erzähle mir einen kurzen Witz.",
		})

		expect(result.ok).toBe(false)
		expect(result.output).toContain("did not select a tool")
	})

	test("extracts the location when the delegated text contains acknowledgement", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						results: [
							{
								name: "Berlin",
								latitude: 52.52,
								longitude: 13.41,
							},
						],
					}),
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						current: { temperature_2m: 20, weather_code: 0 },
					}),
				),
			)
		const dispatcher = new RealtimeToolDispatcher(
			createRealtimeLabWeatherTools(fetchMock),
		)

		const result = await dispatcher.dispatch({
			callId: "weather-ack-1",
			input: "Wie ist das Wetter in Berlin? Moment, ich schau kurz nach.",
		})

		expect(result.ok).toBe(true)
		expect(fetchMock).toHaveBeenCalledTimes(2)
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain("name=Berlin")
	})
})
