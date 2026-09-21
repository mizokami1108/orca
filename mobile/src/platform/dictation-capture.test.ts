/**
 * The native half of the capture seam: the calls it makes, and which interruptions end a capture.
 *
 * Thin by design — this file is five device calls behind a shape the page can answer — but the
 * interruption rule is shared with `dictation-capture.web.ts` and is exactly where the two drifted:
 * the page treated every interruption as a loss while this one has always gated on `began` and
 * `blocked`, so an `ended` on its own cancelled a live dictation on the page and nothing natively.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const engine = vi.hoisted(() => ({
  listeners: new Map<string, (event: { data: unknown }) => void>(),
  calls: new Array<string>()
}))

vi.mock('@orca/expo-two-way-audio', () => ({
  addExpoTwoWayAudioEventListener: (name: string, handler: (event: { data: unknown }) => void) => {
    engine.listeners.set(name, handler)
    return {
      remove: () => {
        engine.listeners.delete(name)
      }
    }
  },
  initialize: () => {
    engine.calls.push('initialize')
    return Promise.resolve(true)
  },
  requestMicrophonePermissionsAsync: () => {
    engine.calls.push('permission')
    return Promise.resolve({ granted: true })
  },
  tearDown: () => {
    engine.calls.push('tearDown')
  },
  toggleRecording: (on: boolean) => {
    engine.calls.push(`toggleRecording(${String(on)})`)
    return true
  }
}))
vi.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: (tag: string) => {
    engine.calls.push(`+${tag}`)
    return Promise.resolve()
  },
  deactivateKeepAwake: (tag: string) => {
    engine.calls.push(`-${tag}`)
    return Promise.resolve()
  }
}))

import { useDictationCapture } from './dictation-capture'

beforeEach(() => {
  engine.listeners.clear()
  engine.calls.length = 0
})

describe('which interruptions end a native capture', () => {
  it('ends on the two the OS means by it, and not on the one it does not', () => {
    const capture = useDictationCapture()
    let interrupted = 0
    capture.onInterruption(() => {
      interrupted += 1
    })
    const fire = (data: string) => engine.listeners.get('onAudioInterruption')?.({ data })
    // `ended` on its own is the OS handing the session back, not taking it away. A dictation that
    // cancelled on it would end itself the moment a notification chime finished playing.
    fire('ended')
    expect(interrupted).toBe(0)
    fire('began')
    expect(interrupted).toBe(1)
    fire('blocked')
    expect(interrupted).toBe(2)
    // And a kind from a newer engine is not an interruption this build can describe.
    fire('something-new')
    expect(interrupted).toBe(2)
  })
})

describe('the calls the native half makes', () => {
  it('asks for the permission, opens the engine, and reports what it got', async () => {
    const capture = useDictationCapture()
    await expect(capture.open()).resolves.toEqual({ ok: true })
    expect(engine.calls).toEqual(['permission', 'initialize'])
    expect(capture.begin()).toBe(true)
    await capture.end()
    capture.release()
    expect(engine.calls).toEqual([
      'permission',
      'initialize',
      'toggleRecording(true)',
      'toggleRecording(false)',
      'tearDown'
    ])
  })

  it('hands every microphone event over with nothing dropped', () => {
    const capture = useDictationCapture()
    const chunks: { data: Uint8Array; droppedBytes: number }[] = []
    capture.onChunk((chunk) => chunks.push(chunk))
    const bytes = Uint8Array.from([1, 2, 3, 4])
    engine.listeners.get('onMicrophoneData')?.({ data: bytes })
    expect(chunks).toEqual([{ data: bytes, droppedBytes: 0 }])
  })

  it('takes the wake tag through expo-keep-awake', async () => {
    const capture = useDictationCapture()
    await capture.keepAwake.activate('orca-a')
    await capture.keepAwake.deactivate('orca-a')
    expect(engine.calls).toEqual(['+orca-a', '-orca-a'])
  })
})
