import { useMemo } from 'react'
import {
  BRIDGE_AUDIO_RING_MAX_BYTES,
  type BridgeAudioChunk
} from '../mobile-web-shell/bridge/bridge-audio-verbs'
import { useNativeVerbs, type NativeVerbs } from '../mobile-web-shell/bridge/use-native-verbs'
import { MOBILE_DICTATION_PCM_SAMPLE_RATE } from '../hooks/mobile-dictation-pending-audio-budget'
import {
  DICTATION_CAPTURE_DRAIN_INTERVAL_MS,
  type DictationCapture,
  type DictationCaptureChunk,
  type DictationCaptureOpen,
  type DictationCaptureSubscription
} from './dictation-capture-contract'

/**
 * Web sibling: the page has no microphone, so the shell holds one and the page drains it.
 *
 * Pulled rather than pushed, because the page-facing seam is request/reply by rule and the one
 * shell-to-page push there is belongs to an RPC `subscribe`. A push lane for bytes the page hands
 * straight back to the desktop would be a new frame kind, capability-negotiated, carrying audio
 * that is already in this process.
 *
 * So the shell rings and this drains on a timer, turning replies into the events
 * `dictation-capture.ts` gets from the engine directly. Above the seam neither host is visible: the
 * same state machine, the same budget, the same routing.
 *
 * Every refusal rejects as the `NativeVerbError` the bridge built, with the reason on it — except
 * a read, whose refusal is a capture that is gone and reaches the interruption lane instead,
 * because that is the state it is and the one the flow already knows how to leave.
 */

/** One read takes the whole ring: the shell bounds what it holds, so a smaller ask would leave
 *  audio behind for no gain and a larger one is refused by the verb's own schema. */
const READ_MAX_BYTES = BRIDGE_AUDIO_RING_MAX_BYTES

/**
 * The shell's reply back into the bytes a chunk carries.
 *
 * The sender encodes them again on the way to the desktop, which is a decode and an encode of
 * 32 KB a second inside one process — the price of one chunk shape rather than two, and of a
 * pending-audio budget that counts the same raw bytes on both hosts.
 */
function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

type Handlers<Handler> = Set<Handler>

function subscribe<Handler>(
  handlers: Handlers<Handler>,
  handler: Handler
): DictationCaptureSubscription {
  handlers.add(handler)
  return {
    remove: () => {
      handlers.delete(handler)
    }
  }
}

/** Split from the hook so a caller can drive it with a client of its own; the hook is the wiring. */
export function createPageDictationCapture(
  verbs: NativeVerbs,
  drainIntervalMs: number = DICTATION_CAPTURE_DRAIN_INTERVAL_MS
): DictationCapture {
  const chunkHandlers: Handlers<(chunk: DictationCaptureChunk) => void> = new Set()
  const interruptionHandlers: Handlers<() => void> = new Set()
  let timer: ReturnType<typeof setInterval> | null = null
  /** The read in flight, if there is one. At most one: two would double the slots dictation spends
   *  and can settle out of order, which is a splice of two moments reaching the transcriber as
   *  speech. Held rather than flagged so a stop can wait for it before taking its own turn. */
  let reading: Promise<void> | null = null

  function stopDraining(): void {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  function interrupted(): void {
    // Before the handlers, so a handler that ends the capture finds the drain already stopped.
    stopDraining()
    for (const handler of interruptionHandlers) {
      handler()
    }
  }

  function deliver(reply: BridgeAudioChunk): void {
    if (reply.base64.length > 0 || reply.droppedBytes > 0) {
      const chunk: DictationCaptureChunk = {
        data: decodeBase64(reply.base64),
        droppedBytes: reply.droppedBytes
      }
      for (const handler of chunkHandlers) {
        handler(chunk)
      }
    }
    if (reply.interruption !== null || !reply.recording) {
      interrupted()
    }
  }

  async function readOnce(): Promise<void> {
    try {
      deliver(await verbs.readAudio(READ_MAX_BYTES))
    } catch {
      // A read the shell refused is a capture it no longer has, whatever the code says. The flow
      // above leaves the same way it leaves a phone call, which is the honest answer: there is no
      // microphone, and there will not be one without another start.
      interrupted()
    }
  }

  function drain(): Promise<void> {
    if (reading !== null) {
      return reading
    }
    const run = readOnce().finally(() => {
      reading = null
    })
    reading = run
    return run
  }

  /** Best effort, and deliberately quiet, for the reason `end` never rejects. */
  async function stopShell(): Promise<void> {
    await verbs.stopAudio().catch(() => undefined)
  }

  /**
   * The tail, then the stop, in that order.
   *
   * Whatever is in the ring when the user lifts the button is up to one interval of what they
   * actually said, and no timer is coming for it — `stopDraining` has just cancelled the one that
   * was. Stopping first would take the capture away and the read after it would be refused, so the
   * order here is the whole fix. An in-flight drain is awaited before the last read rather than
   * raced with it, because two reads settling out of order splice two moments together.
   */
  async function endCapture(): Promise<void> {
    stopDraining()
    await reading
    reading = null
    await readOnce()
    await stopShell()
  }

  return {
    open: async (): Promise<DictationCaptureOpen> => {
      const started = await verbs.startAudio(MOBILE_DICTATION_PCM_SAMPLE_RATE)
      if (started.started) {
        return { ok: true }
      }
      return {
        ok: false,
        reason: started.permission === 'granted' ? 'unavailable' : 'permission-denied'
      }
    },
    begin: () => {
      // The shell began capturing inside `start`; this is the page's half, which is the drain.
      stopDraining()
      timer = setInterval(() => {
        void drain()
      }, drainIntervalMs)
      return true
    },
    end: endCapture,
    // No last read: a release is the screen going away, and there is nobody left to hand the tail
    // to. The shell sweeps the ring with the capture.
    release: () => {
      stopDraining()
      void stopShell()
    },
    onChunk: (handler) => subscribe(chunkHandlers, handler),
    onInterruption: (handler) => subscribe(interruptionHandlers, handler),
    keepAwake: {
      activate: async (tag) => {
        await verbs.setWakelock(true, tag)
      },
      deactivate: async (tag) => {
        await verbs.setWakelock(false, tag)
      }
    }
  }
}

export function useDictationCapture(): DictationCapture {
  const verbs = useNativeVerbs()
  return useMemo(() => createPageDictationCapture(verbs), [verbs])
}
