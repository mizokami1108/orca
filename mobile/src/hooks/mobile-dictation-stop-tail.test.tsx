/**
 * The ordering `stop()` depends on: the capture hands over its tail, and only then does the flow
 * stop accepting chunks.
 *
 * On the page the tail is real audio — up to one drain interval of what the user was still saying
 * as they lifted the button, fetched by the last read inside `end()`. Refusing chunks first drops
 * exactly that, and taking the pending set before it lets `finish` overtake the last send. Neither
 * shows up in a source-text check: both orders put `end()` before `Promise.allSettled`, and
 * reversing the two lines left the whole mobile suite green.
 *
 * Driven against a capture whose `end()` delivers a chunk, which is what the page's seam does and
 * what the device's never does, so this is the one case that can tell the orders apart.
 */
import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type {
  DictationCapture,
  DictationCaptureChunk
} from '../platform/dictation-capture-contract'

const seam = vi.hoisted(() => ({
  chunkHandlers: new Set<(chunk: DictationCaptureChunk) => void>(),
  /** Bytes the capture is still holding when `end()` is called, as the shell's ring would be. */
  tail: null as Uint8Array | null
}))

vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  Platform: { OS: 'ios' }
}))

// One object for the life of the module, because the hook keys its effects on the capture's
// identity: the teardown effect runs whenever it changes, so a seam returning a fresh object per
// render would cancel the dictation on every render. Both real seams are stable — the native one is
// a module const, the page's is a `useMemo` on the client.
vi.mock('../platform/dictation-capture', () => {
  const capture: DictationCapture = {
    open: async () => ({ ok: true }),
    begin: () => true,
    end: async () => {
      // The page's seam reads once more here, and that read can carry audio.
      const tail = seam.tail
      seam.tail = null
      if (tail !== null) {
        for (const handler of seam.chunkHandlers) {
          handler({ data: tail, droppedBytes: 0 })
        }
      }
    },
    release: () => {},
    onChunk: (handler) => {
      seam.chunkHandlers.add(handler)
      return {
        remove: () => {
          seam.chunkHandlers.delete(handler)
        }
      }
    },
    onInterruption: () => ({ remove: () => {} }),
    keepAwake: { activate: async () => {}, deactivate: async () => {} }
  }
  return { useDictationCapture: () => capture }
})

import { useMobileDictation, type UseMobileDictationResult } from './use-mobile-dictation'

type Sent = { method: string; params: Record<string, unknown> }

function createClient(sent: Sent[]): RpcClient {
  return {
    sendRequest: async (method: string, params: unknown) => {
      sent.push({
        method,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every dictation operation sends an object, and this fake only records what it was given.
        params: (params ?? {}) as Record<string, unknown>
      })
      return method === 'speech.dictation.finish'
        ? { ok: true, result: { text: 'a sentence' } }
        : { ok: true, result: {} }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reaches only `sendRequest` on the client; every other member is unused on this path.
  } as unknown as RpcClient
}

const held: { dictation: UseMobileDictationResult | null } = { dictation: null }

function mount(client: RpcClient): void {
  function Probe(): null {
    held.dictation = useMobileDictation({
      client,
      enabled: true,
      onTranscript: () => {},
      onError: () => {}
    })
    return null
  }
  act(() => {
    create(createElement(Probe))
  })
}

function dictation(): UseMobileDictationResult {
  const current = held.dictation
  if (current === null) {
    throw new Error('nothing mounted')
  }
  return current
}

beforeEach(() => {
  seam.chunkHandlers.clear()
  seam.tail = null
  held.dictation = null
})

describe('the audio a capture hands over as it ends', () => {
  it('is still accepted, and reaches the desktop before the finish', async () => {
    const sent: Sent[] = []
    mount(createClient(sent))
    await act(async () => {
      await dictation().start()
    })
    // What the user was still saying when they lifted the button, which no timer will come for.
    seam.tail = Uint8Array.from([7, 8, 9, 10])
    await act(async () => {
      await dictation().stop()
    })
    const methods = sent.map((request) => request.method)
    expect(methods).toContain('speech.dictation.chunk')
    // Refusing chunks before `end()` drops this one silently: the handler reads
    // `acceptingChunksRef` and returns, and the transcript loses the end of the sentence.
    const chunk = sent.find((request) => request.method === 'speech.dictation.chunk')
    expect(chunk?.params.audioBase64).toBe('BwgJCg==')
    // And it is sent before the finish, or the desktop transcribes without it.
    expect(methods.indexOf('speech.dictation.chunk')).toBeLessThan(
      methods.indexOf('speech.dictation.finish')
    )
  })

  it('stops being accepted once the capture has ended', async () => {
    const sent: Sent[] = []
    mount(createClient(sent))
    await act(async () => {
      await dictation().start()
    })
    await act(async () => {
      await dictation().stop()
    })
    const before = sent.filter((request) => request.method === 'speech.dictation.chunk').length
    // A late event from a capture that has already ended is not this dictation's audio.
    for (const handler of seam.chunkHandlers) {
      handler({ data: Uint8Array.from([1, 2, 3, 4]), droppedBytes: 0 })
    }
    await act(async () => {
      await Promise.resolve()
    })
    expect(sent.filter((request) => request.method === 'speech.dictation.chunk')).toHaveLength(
      before
    )
  })
})
