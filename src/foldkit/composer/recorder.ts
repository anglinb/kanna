// useVoiceRecorder without React: the MediaRecorder, the microphone stream
// and the level meter, one per composer, kept here because they are live
// browser handles, not state. Commands start, finish and cancel a capture;
// the waveform's Mount reads the levels (they change every 50ms and only the
// canvas shows them).
//
// Mirrors the iOS VoiceRecorderController: a new volume sample every 50ms,
// normalized 0...1 from decibels clamped to [-55, 0], oldest first, capped
// at 160 samples.
const METER_INTERVAL_MS = 50
const MAX_LEVEL_SAMPLES = 160
const MIN_DECIBELS = -55

// Safari records audio/mp4 (m4a); Chrome/Firefox record webm/opus. The
// server's /api/transcribe maps either subtype to a format OpenRouter
// accepts.
const MIME_CANDIDATES = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"]

export interface VoiceRecording {
  blob: Blob
  mimeType: string
}

interface Capture {
  recorder: MediaRecorder
  stream: MediaStream
  audioContext: AudioContext
  analyser: AnalyserNode
  timer: number
  chunks: Blob[]
  levels: number[]
  listeners: Set<(levels: readonly number[]) => void>
}

const captures = new Map<string, Capture>()

function cleanup(key: string) {
  const capture = captures.get(key)
  if (!capture) return
  captures.delete(key)
  window.clearInterval(capture.timer)
  capture.stream.getTracks().forEach((track) => track.stop())
  void capture.audioContext.close().catch(() => {})
  capture.levels = []
  capture.listeners.forEach((listener) => listener([]))
}

function sampleMeter(capture: Capture) {
  const data = new Float32Array(capture.analyser.fftSize)
  capture.analyser.getFloatTimeDomainData(data)
  let sum = 0
  for (let i = 0; i < data.length; i++) sum += data[i]! * data[i]!
  const rms = Math.sqrt(sum / data.length)
  const decibels = 20 * Math.log10(rms || 1e-8)
  const clamped = Math.max(MIN_DECIBELS, Math.min(0, decibels))
  const normalized = (clamped - MIN_DECIBELS) / -MIN_DECIBELS
  const next = capture.levels.length >= MAX_LEVEL_SAMPLES
    ? capture.levels.slice(capture.levels.length - MAX_LEVEL_SAMPLES + 1)
    : capture.levels.slice()
  next.push(normalized)
  capture.levels = next
  capture.listeners.forEach((listener) => listener(next))
}

/** Null when it started; otherwise what to say (setErrorMessage). */
export async function startRecording(key: string): Promise<string | null> {
  if (captures.has(key)) return null

  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    return "Voice messages aren't supported in this browser."
  }

  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch {
    return "Voice messages need microphone access."
  }

  try {
    const mimeType = MIME_CANDIDATES.find((candidate) => MediaRecorder.isTypeSupported(candidate))
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    const chunks: Blob[] = []
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data)
    }
    recorder.start(250)

    const audioContext = new AudioContext()
    const source = audioContext.createMediaStreamSource(stream)
    const analyser = audioContext.createAnalyser()
    analyser.fftSize = 1024
    source.connect(analyser)

    const capture: Capture = { recorder, stream, audioContext, analyser, timer: 0, chunks, levels: [], listeners: new Set() }
    capture.timer = window.setInterval(() => sampleMeter(capture), METER_INTERVAL_MS)
    captures.set(key, capture)
    return null
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop())
    cleanup(key)
    return error instanceof Error ? error.message : "Could not start recording audio."
  }
}

/** Stops the active recording and returns the captured audio, or why there is none. */
export async function finishRecording(key: string): Promise<{ recording: VoiceRecording | null; error: string | null }> {
  const capture = captures.get(key)
  const recorder = capture?.recorder
  if (!capture || !recorder || recorder.state === "inactive") {
    cleanup(key)
    return { recording: null, error: null }
  }

  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve()
  })
  recorder.stop()
  await stopped

  const mimeType = (recorder.mimeType || "audio/webm").split(";")[0]!
  const blob = new Blob(capture.chunks, { type: mimeType })
  cleanup(key)

  if (blob.size === 0) return { recording: null, error: "The recording was empty. Try again." }
  return { recording: { blob, mimeType }, error: null }
}

export function cancelRecording(key: string) {
  const recorder = captures.get(key)?.recorder
  if (recorder && recorder.state !== "inactive") recorder.stop()
  cleanup(key)
}

/** The waveform's feed: called with the levels now, and on every sample. */
export function watchLevels(key: string, listener: (levels: readonly number[]) => void): () => void {
  const capture = captures.get(key)
  listener(capture?.levels ?? [])
  if (!capture) return () => {}
  capture.listeners.add(listener)
  return () => capture.listeners.delete(listener)
}
