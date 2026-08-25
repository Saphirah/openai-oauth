import {
	type CodexFramelessEvent,
	type CodexFramelessVoice,
	type CodexRealtimeBrowserConnection,
	connectCodexRealtimeBrowser,
} from "@openai-oauth/core"

type CardState = "idle" | "pending" | "ok" | "warning" | "error"
type Diagnostics = {
	ok: true
	protocol: string
	referenceCommit: string
	call: { localEndpoint: string; upstreamPath: string; modelDefault: string }
	sideband: { localPath: string; upstreamPath: string }
	tools: { configured: boolean; names: string[] }
	attestation: { hostProviderConfigured: boolean }
	implementationPaths: { call: string; sideband: string; client: string }
}

const get = <T extends HTMLElement>(selector: string): T => {
	const value = document.querySelector<T>(selector)
	if (!value) throw new Error(`Missing Realtime Lab element: ${selector}`)
	return value
}

const startButton = get<HTMLButtonElement>("#start")
const stopButton = get<HTMLButtonElement>("#stop")
const muteMicrophoneButton = get<HTMLButtonElement>("#mute-microphone")
const voiceSelect = get<HTMLSelectElement>("#voice")
const instructionsInput = get<HTMLTextAreaElement>("#instructions")
const sessionStatus = get<HTMLElement>("#session-status")
const failure = get<HTMLElement>("#failure")
const transcript = get<HTMLElement>("#transcript")
const textInput = get<HTMLInputElement>("#text-input")
const sendTextButton = get<HTMLButtonElement>("#send-text")
const meterFill = get<HTMLElement>("#meter-fill")
const pitchInput = get<HTMLInputElement>("#pitch")
const pitchValue = get<HTMLOutputElement>("#pitch-value")

let diagnostics: Diagnostics | undefined
let connection: CodexRealtimeBrowserConnection | undefined
let microphoneMeter: MicrophoneMeter | undefined
let pitchOutput: PitchOutput | undefined
let partialTranscript: Partial<Record<"user" | "assistant", HTMLElement>> = {}

const setCard = (id: string, state: CardState, detail: string): void => {
	get<HTMLElement>(`#${id}-state`).dataset.state = state
	get<HTMLElement>(`#${id}-detail`).textContent = detail
}

const setStatus = (
	text: string,
	state: "idle" | "pending" | "active" | "error" = "idle",
): void => {
	sessionStatus.textContent = text
	sessionStatus.dataset.state = state
}

const setRunning = (running: boolean): void => {
	startButton.disabled = running || !diagnostics
	stopButton.disabled = !running
	textInput.disabled = !running
	sendTextButton.disabled = !running
	muteMicrophoneButton.disabled = !running
}

const showFailure = (error: unknown, stage: string): void => {
	const message = error instanceof Error ? error.message : String(error)
	get<HTMLElement>("#failure-title").textContent = `Fehler in ${stage}`
	get<HTMLElement>("#failure-code").textContent = message
	failure.classList.add("visible")
	setStatus(`Realtime fehlgeschlagen: ${message}`, "error")
}

const addEvent = (event: CodexFramelessEvent): void => {
	if (event.kind === "session") {
		setCard("sideband", "ok", `Frameless-Session ${event.sessionId} ist aktiv.`)
	}
	if (event.kind === "error") showFailure(new Error(event.message), "Upstream")
	if (event.kind === "transcript") showTranscript(event)
	if (event.kind === "unknown") {
		if (event.type === "openai_oauth.tool.started") {
			const input = typeof event.raw.input === "string" ? event.raw.input : ""
			showToolActivity(
				input ? `Tool-Handoff: ${input}` : "Tool-Handoff wird ausgeführt.",
			)
		}
		if (event.type === "openai_oauth.tool.completed") {
			const name = typeof event.raw.name === "string" ? event.raw.name : "Tool"
			const output =
				typeof event.raw.output === "string" ? event.raw.output : ""
			showToolActivity(`${name}: ${output}`)
		}
	}
}

const showToolActivity = (text: string): void => {
	if (transcript.querySelector(".empty")) transcript.replaceChildren()
	const turn = document.createElement("article")
	turn.className = "turn tool"
	const label = document.createElement("strong")
	label.textContent = "Lokales Tool"
	const line = document.createElement("p")
	line.textContent = text
	turn.append(label, line)
	transcript.append(turn)
	transcript.scrollTop = transcript.scrollHeight
}

const showTranscript = (
	event: Extract<CodexFramelessEvent, { kind: "transcript" }>,
): void => {
	if (transcript.querySelector(".empty")) transcript.replaceChildren()
	let line = partialTranscript[event.role]
	if (!line) {
		const turn = document.createElement("article")
		turn.className = `turn ${event.role}`
		const label = document.createElement("strong")
		label.textContent = event.role === "user" ? "Du" : "Codex Voice"
		line = document.createElement("p")
		turn.append(label, line)
		transcript.append(turn)
		partialTranscript[event.role] = line
	}
	line.textContent =
		event.phase === "done"
			? event.text
			: `${line.textContent ?? ""}${event.text}`
	if (event.phase === "done") delete partialTranscript[event.role]
	transcript.scrollTop = transcript.scrollHeight
}

class PitchOutput {
	private readonly context = new AudioContext({ latencyHint: "interactive" })
	private readonly wetGain = this.context.createGain()
	private source?: MediaStreamAudioSourceNode
	private node?: AudioWorkletNode

	constructor(private readonly audioElement: HTMLAudioElement) {
		this.wetGain.gain.value = 0
		this.wetGain.connect(this.context.destination)
	}

	async prepare(semitones: number): Promise<void> {
		await this.context.audioWorklet.addModule("/realtime/pitch-worklet.js")
		this.node = new AudioWorkletNode(this.context, "realtime-pitch-shifter", {
			numberOfInputs: 1,
			numberOfOutputs: 1,
			outputChannelCount: [2],
		})
		this.node.connect(this.wetGain)
		this.node.addEventListener("processorerror", () => {
			this.audioElement.muted = false
			this.wetGain.gain.value = 0
			setCard(
				"media",
				"warning",
				"Pitch-Prozessor ausgefallen; Originalaudio ist weiterhin aktiv.",
			)
		})
		this.setSemitones(semitones)
		if (this.context.state === "suspended") await this.context.resume()
	}

	attach(stream: MediaStream): void {
		if (!this.node) return
		this.source?.disconnect()
		this.source = this.context.createMediaStreamSource(stream)
		this.source.connect(this.node)
		if (this.context.state === "suspended") void this.context.resume()
	}

	setSemitones(semitones: number): void {
		const bypass = Math.abs(semitones) < 0.01
		this.audioElement.muted = !bypass
		this.wetGain.gain.setTargetAtTime(
			bypass ? 0 : 1,
			this.context.currentTime,
			0.012,
		)
		this.node?.port.postMessage({ type: "pitch", semitones })
	}

	async close(): Promise<void> {
		this.source?.disconnect()
		this.node?.disconnect()
		this.wetGain.disconnect()
		this.audioElement.pause()
		this.audioElement.srcObject = null
		await this.context.close()
	}
}

class MicrophoneMeter {
	private readonly context = new AudioContext()
	private readonly analyser = this.context.createAnalyser()
	private readonly samples = new Uint8Array(512)
	private frame?: number

	constructor(stream: MediaStream) {
		this.analyser.fftSize = this.samples.length
		this.context.createMediaStreamSource(stream).connect(this.analyser)
	}

	start(): void {
		const draw = () => {
			this.analyser.getByteTimeDomainData(this.samples)
			let sum = 0
			for (const sample of this.samples) {
				const centered = (sample - 128) / 128
				sum += centered * centered
			}
			meterFill.style.width = `${Math.min(100, Math.sqrt(sum / this.samples.length) * 360)}%`
			this.frame = requestAnimationFrame(draw)
		}
		draw()
	}

	async close(): Promise<void> {
		if (this.frame !== undefined) cancelAnimationFrame(this.frame)
		meterFill.style.width = "0"
		await this.context.close()
	}
}

const stop = async (message = "Session wurde beendet."): Promise<void> => {
	const previousConnection = connection
	const previousMeter = microphoneMeter
	const previousPitchOutput = pitchOutput
	connection = undefined
	microphoneMeter = undefined
	pitchOutput = undefined
	previousConnection?.close()
	await Promise.allSettled([
		previousMeter?.close(),
		previousPitchOutput?.close(),
	])
	setRunning(false)
	setCard("call", "idle", "Call wurde beendet.")
	setCard("sideband", "idle", "Sideband wurde geschlossen.")
	setCard("media", "idle", "Peer-Verbindung wurde geschlossen.")
	setCard("microphone", "idle", "Mikrofon ist nicht aktiv.")
	muteMicrophoneButton.textContent = "Mikrofon stumm"
	setStatus(message)
}

const start = async (): Promise<void> => {
	if (!diagnostics || connection) return
	failure.classList.remove("visible")
	startButton.disabled = true
	setStatus("Mikrofon und AVAS-Call werden vorbereitet.", "pending")
	setCard("microphone", "pending", "Browser fragt nach Mikrofonzugriff.")
	setCard("call", "pending", `POST ${diagnostics.call.localEndpoint}`)
	setCard("sideband", "pending", "Wartet auf Call-ID.")
	setCard("media", "pending", "WebRTC-Offer wird erzeugt.")
	try {
		const remoteAudio = new Audio()
		remoteAudio.autoplay = true
		pitchOutput = new PitchOutput(remoteAudio)
		await pitchOutput.prepare(Number(pitchInput.value))
		connection = await connectCodexRealtimeBrowser({
			endpoint: diagnostics.call.localEndpoint,
			voice: voiceSelect.value as CodexFramelessVoice,
			instructions: instructionsInput.value,
			sessionId: `realtime-lab:${crypto.randomUUID()}`,
			audioElement: remoteAudio,
			mediaConstraints: {
				audio: {
					channelCount: 1,
					echoCancellation: true,
					noiseSuppression: true,
				},
			},
			onEvent: addEvent,
			onConnectionStateChange: (state) => {
				const cardState: CardState =
					state === "connected"
						? "ok"
						: state === "failed" || state === "disconnected"
							? "error"
							: "pending"
				setCard("media", cardState, `RTCPeerConnection: ${state}`)
			},
			onRemoteStream: (stream) => {
				pitchOutput?.attach(stream)
				setCard(
					"media",
					"ok",
					`Remote MediaStream: ${stream.getAudioTracks().length} Audio-Track(s).`,
				)
			},
		})
		setCard("call", "ok", `Call ${connection.call.callId} wurde erstellt.`)
		setCard(
			"sideband",
			"pending",
			"Lokaler Sideband verbindet zum Codex-Live-Endpunkt.",
		)
		microphoneMeter = new MicrophoneMeter(connection.inputStream)
		microphoneMeter.start()
		setCard(
			"microphone",
			"ok",
			`${connection.inputStream.getAudioTracks().length} Mikrofon-Track(s) aktiv.`,
		)
		await connection.ready
		setCard("sideband", "ok", "Authentifizierter Codex-Sideband ist bereit.")
		setRunning(true)
		setStatus("Realtime-Session aktiv. Sprich oder sende Text.", "active")
	} catch (error) {
		showFailure(error, "Realtime-Start")
		await stop("Realtime-Start fehlgeschlagen.")
		setStatus(error instanceof Error ? error.message : String(error), "error")
	}
}

const sendText = (): void => {
	const text = textInput.value.trim()
	if (!text || !connection) return
	connection.sendText(text)
	textInput.value = ""
}

const bootstrap = async (): Promise<void> => {
	try {
		const response = await fetch("/v1/realtime/diagnostics", {
			cache: "no-store",
		})
		if (!response.ok)
			throw new Error(`Diagnostik fehlgeschlagen (${response.status}).`)
		diagnostics = (await response.json()) as Diagnostics
		setCard("proxy", "ok", `${location.origin} · ${diagnostics.protocol}`)
		setCard("call", "idle", diagnostics.call.upstreamPath)
		setCard("sideband", "idle", diagnostics.sideband.upstreamPath)
		get<HTMLElement>("#model").textContent = diagnostics.call.modelDefault
		get<HTMLElement>("#test-tools").textContent = diagnostics.tools.configured
			? `${diagnostics.tools.names.join(", ")} · Backend-Ausführung aktiv`
			: "Keine Test-Tools konfiguriert"
		get<HTMLElement>("#implementation-paths").textContent =
			`Codex: ${diagnostics.referenceCommit}\nCall: ${diagnostics.implementationPaths.call}\nSideband: ${diagnostics.implementationPaths.sideband}`
		setStatus("Bereit. Erst Start fordert Mikrofonzugriff an.")
		setRunning(false)
	} catch (error) {
		setCard(
			"proxy",
			"error",
			error instanceof Error ? error.message : String(error),
		)
		showFailure(error, "Initialisierung")
	}
}

startButton.addEventListener("click", () => void start())
stopButton.addEventListener("click", () => void stop())
sendTextButton.addEventListener("click", sendText)
muteMicrophoneButton.addEventListener("click", () => {
	if (!connection) return
	const tracks = connection.inputStream.getAudioTracks()
	const shouldMute = tracks.some((track) => track.enabled)
	for (const track of tracks) track.enabled = !shouldMute
	muteMicrophoneButton.textContent = shouldMute
		? "Mikrofon aktivieren"
		: "Mikrofon stumm"
	setCard(
		"microphone",
		shouldMute ? "warning" : "ok",
		shouldMute
			? "Mikrofon-Track für reproduzierbare Texteingabe stummgeschaltet."
			: `${tracks.length} Mikrofon-Track(s) aktiv.`,
	)
})
textInput.addEventListener("keydown", (event) => {
	if (event.key === "Enter") sendText()
})
get<HTMLButtonElement>("#clear-transcript").addEventListener("click", () => {
	transcript.innerHTML = '<div class="empty">Transkript wurde geleert.</div>'
	partialTranscript = {}
})
const updatePitch = (): void => {
	const semitones = Number(pitchInput.value)
	pitchValue.textContent = `${semitones > 0 ? "+" : ""}${semitones.toFixed(1)} st`
	pitchOutput?.setSemitones(semitones)
}
pitchInput.addEventListener("input", updatePitch)
get<HTMLButtonElement>("#reset-pitch").addEventListener("click", () => {
	pitchInput.value = "0"
	updatePitch()
})
window.addEventListener("beforeunload", () => connection?.close())

updatePitch()
void bootstrap()
