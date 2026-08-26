import { useCallback, useEffect, useRef, useState } from "react"

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

export function useVoiceRecorder() {
  const [isRecording, setIsRecording] = useState(false)
  const [levels, setLevels] = useState<number[]>([])
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const meterTimerRef = useRef<number | null>(null)
  const chunksRef = useRef<Blob[]>([])

  const cleanup = useCallback(() => {
    if (meterTimerRef.current !== null) {
      window.clearInterval(meterTimerRef.current)
      meterTimerRef.current = null
    }
    recorderRef.current = null
    chunksRef.current = []
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    void audioContextRef.current?.close().catch(() => {})
    audioContextRef.current = null
    analyserRef.current = null
    setLevels([])
    setIsRecording(false)
  }, [])

  useEffect(() => cleanup, [cleanup])

  const sampleMeter = useCallback(() => {
    const analyser = analyserRef.current
    if (!analyser) return
    const data = new Float32Array(analyser.fftSize)
    analyser.getFloatTimeDomainData(data)
    let sum = 0
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
    const rms = Math.sqrt(sum / data.length)
    const decibels = 20 * Math.log10(rms || 1e-8)
    const clamped = Math.max(MIN_DECIBELS, Math.min(0, decibels))
    const normalized = (clamped - MIN_DECIBELS) / -MIN_DECIBELS
    setLevels((prev) => {
      const next = prev.length >= MAX_LEVEL_SAMPLES ? prev.slice(prev.length - MAX_LEVEL_SAMPLES + 1) : prev.slice()
      next.push(normalized)
      return next
    })
  }, [])

  const startRecording = useCallback(async () => {
    setErrorMessage(null)
    if (recorderRef.current) return

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setErrorMessage("Voice messages aren't supported in this browser.")
      return
    }

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      setErrorMessage("Voice messages need microphone access.")
      return
    }

    try {
      const mimeType = MIME_CANDIDATES.find((candidate) => MediaRecorder.isTypeSupported(candidate))
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      chunksRef.current = []
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data)
      }
      recorder.start(250)

      const audioContext = new AudioContext()
      const source = audioContext.createMediaStreamSource(stream)
      const analyser = audioContext.createAnalyser()
      analyser.fftSize = 1024
      source.connect(analyser)

      streamRef.current = stream
      recorderRef.current = recorder
      audioContextRef.current = audioContext
      analyserRef.current = analyser
      setLevels([])
      setIsRecording(true)
      meterTimerRef.current = window.setInterval(sampleMeter, METER_INTERVAL_MS)
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop())
      cleanup()
      setErrorMessage(error instanceof Error ? error.message : "Could not start recording audio.")
    }
  }, [cleanup, sampleMeter])

  /** Stops the active recording and returns the captured audio. */
  const finishRecording = useCallback(async (): Promise<VoiceRecording | null> => {
    const recorder = recorderRef.current
    if (!recorder || recorder.state === "inactive") {
      cleanup()
      return null
    }

    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve()
    })
    recorder.stop()
    await stopped

    const mimeType = (recorder.mimeType || "audio/webm").split(";")[0]
    const blob = new Blob(chunksRef.current, { type: mimeType })
    cleanup()

    if (blob.size === 0) {
      setErrorMessage("The recording was empty. Try again.")
      return null
    }
    return { blob, mimeType }
  }, [cleanup])

  const cancelRecording = useCallback(() => {
    const recorder = recorderRef.current
    if (recorder && recorder.state !== "inactive") recorder.stop()
    cleanup()
  }, [cleanup])

  return { isRecording, levels, errorMessage, setErrorMessage, startRecording, finishRecording, cancelRecording }
}
