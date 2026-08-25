export const realtimePitchWorkletSource = `class RealtimePitchShifter extends AudioWorkletProcessor {
  constructor() {
    super()
    this.semitones = 0
    this.phase = 0
    this.windowSize = 2048
    this.minimumDelay = 256
    this.buffers = []
    this.writeIndex = 0
    this.port.onmessage = (event) => {
      if (event.data && event.data.type === "pitch" && Number.isFinite(event.data.semitones)) {
        this.semitones = Math.max(-12, Math.min(12, event.data.semitones))
      }
    }
  }

  ensureBuffers(channelCount) {
    const requiredSize = 8192
    while (this.buffers.length < channelCount) {
      this.buffers.push(new Float32Array(requiredSize))
    }
  }

  sample(buffer, position) {
    const size = buffer.length
    const wrapped = ((position % size) + size) % size
    const lower = Math.floor(wrapped)
    const upper = (lower + 1) % size
    const mix = wrapped - lower
    return buffer[lower] * (1 - mix) + buffer[upper] * mix
  }

  process(inputs, outputs) {
    const input = inputs[0]
    const output = outputs[0]
    if (!input || input.length === 0 || !output || output.length === 0) return true
    this.ensureBuffers(Math.max(input.length, output.length))
    const frameCount = output[0].length
    const pitchFactor = Math.pow(2, this.semitones / 12)
    const phaseStep = (1 - pitchFactor) / this.windowSize
    const ringSize = this.buffers[0].length

    for (let frame = 0; frame < frameCount; frame += 1) {
      for (let channel = 0; channel < this.buffers.length; channel += 1) {
        const source = input[Math.min(channel, input.length - 1)]
        this.buffers[channel][this.writeIndex] = source ? source[frame] || 0 : 0
      }

      const phaseA = ((this.phase % 1) + 1) % 1
      const phaseB = (phaseA + 0.5) % 1
      const gainA = 0.5 - 0.5 * Math.cos(2 * Math.PI * phaseA)
      const gainB = 0.5 - 0.5 * Math.cos(2 * Math.PI * phaseB)
      const delayA = this.minimumDelay + phaseA * this.windowSize
      const delayB = this.minimumDelay + phaseB * this.windowSize

      for (let channel = 0; channel < output.length; channel += 1) {
        const buffer = this.buffers[Math.min(channel, this.buffers.length - 1)]
        const valueA = this.sample(buffer, this.writeIndex - delayA)
        const valueB = this.sample(buffer, this.writeIndex - delayB)
        output[channel][frame] = valueA * gainA + valueB * gainB
      }

      this.writeIndex = (this.writeIndex + 1) % ringSize
      this.phase = ((this.phase + phaseStep) % 1 + 1) % 1
    }
    return true
  }
}

registerProcessor("realtime-pitch-shifter", RealtimePitchShifter)
`
