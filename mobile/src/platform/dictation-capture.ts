import {
  addExpoTwoWayAudioEventListener,
  initialize,
  requestMicrophonePermissionsAsync,
  tearDown,
  toggleRecording
} from '@orca/expo-two-way-audio'
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake'
import type { DictationCapture } from './dictation-capture-contract'

/**
 * The device's microphone, which is where dictation's audio has always come from.
 *
 * Every call is the one the hook used to make, in the order it made it, because this half is the
 * seam's shape rather than a translation of it: a permission and an open, a start and a stop, the
 * two event lanes `@orca/expo-two-way-audio` emits, and the wake tag. What moved is where they are
 * written, so the page can answer the same shape without the flow above knowing which it holds.
 */
const nativeDictationCapture: DictationCapture = {
  open: async () => {
    const permission = await requestMicrophonePermissionsAsync()
    if (!permission.granted) {
      return { ok: false, reason: 'permission-denied' }
    }
    return (await initialize()) ? { ok: true } : { ok: false, reason: 'unavailable' }
  },
  begin: () => toggleRecording(true),
  // Already resolved: every microphone event reached the hook as the engine produced it, so there
  // is nothing held back for a stop to hand over.
  end: async () => {
    toggleRecording(false)
  },
  release: () => {
    void tearDown()
  },
  onChunk: (handler) =>
    addExpoTwoWayAudioEventListener('onMicrophoneData', (event) => {
      const raw = event.data
      handler({
        data: raw instanceof Uint8Array ? raw : new Uint8Array(raw),
        // Nothing is ever dropped on the way here: this process is where the microphone is, and
        // what the flow cannot keep up with is the pending-audio budget's to refuse, not this.
        droppedBytes: 0
      })
    }),
  onInterruption: (handler) =>
    addExpoTwoWayAudioEventListener('onAudioInterruption', (event) => {
      if (event.data === 'began' || event.data === 'blocked') {
        handler()
      }
    }),
  keepAwake: { activate: activateKeepAwakeAsync, deactivate: deactivateKeepAwake }
}

export function useDictationCapture(): DictationCapture {
  return nativeDictationCapture
}
