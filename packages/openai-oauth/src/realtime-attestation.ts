export const CODEX_ATTESTATION_TIMEOUT_MS = 100

export type CodexAttestationStatus = 0 | 1 | 2 | 3 | 4

export type CodexAttestationProvider = (context: {
	sessionId: string
}) => Promise<string | undefined>

export type CodexAttestationResult = {
	header?: string
	status?: CodexAttestationStatus
}

export const codexAttestationEnvelope = (
	status: CodexAttestationStatus,
	token?: string,
): string =>
	JSON.stringify({
		v: 1,
		s: status,
		...(token === undefined ? {} : { t: token }),
	})

export const resolveCodexAttestation = async (
	provider: CodexAttestationProvider | undefined,
	context: { sessionId: string; signal?: AbortSignal },
): Promise<CodexAttestationResult> => {
	if (!provider) return {}
	if (context.signal?.aborted) {
		return { header: codexAttestationEnvelope(3), status: 3 }
	}

	let timeoutId: ReturnType<typeof setTimeout> | undefined
	let abortListener: (() => void) | undefined
	const timeout = new Promise<{ status: CodexAttestationStatus }>((resolve) => {
		timeoutId = setTimeout(
			() => resolve({ status: 1 }),
			CODEX_ATTESTATION_TIMEOUT_MS,
		)
	})
	const aborted = new Promise<{ status: CodexAttestationStatus }>((resolve) => {
		abortListener = () => resolve({ status: 3 })
		context.signal?.addEventListener("abort", abortListener, { once: true })
	})
	const generated = Promise.resolve()
		.then(() => provider({ sessionId: context.sessionId }))
		.then((token) =>
			typeof token === "string" && token.length > 0
				? { status: 0 as const, token }
				: { status: 4 as const },
		)
		.catch(() => ({ status: 2 as const }))

	const result = await Promise.race([generated, timeout, aborted])
	if (timeoutId) clearTimeout(timeoutId)
	if (abortListener) context.signal?.removeEventListener("abort", abortListener)
	return {
		header: codexAttestationEnvelope(
			result.status,
			"token" in result ? result.token : undefined,
		),
		status: result.status,
	}
}
