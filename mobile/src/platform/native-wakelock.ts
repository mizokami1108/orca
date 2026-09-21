import { wakelockSetParamsSchema } from '../mobile-web-shell/bridge/bridge-audio-verbs'

/**
 * The device side of `native.wakelock.set`, on the shell where `expo-keep-awake` exists.
 *
 * Dictation holds the screen awake from the moment recording starts until the transcript is back,
 * because a screen lock mid-processing suspends the app and loses it. On the page that tag has to
 * be asked for, which is this verb; natively the same seam calls `expo-keep-awake` directly.
 *
 * The shell tracks what it is holding for two reasons. A page that releases a tag it never took
 * asks the device nothing, because `deactivateKeepAwake` on an unheld tag is a native call whose
 * failure would read to the page as a wake lock it could not drop. And a page session that ends
 * with a tag still held has it given back for it — the page is a document that can navigate, fault
 * or be swiped away mid-dictation, and nothing else would ever call `deactivate`, so the screen
 * would stay awake for the app's lifetime.
 *
 * So the set means "the device still has this tag", not "the page asked for it": a deactivation the
 * device refused leaves the tag recorded, because the page's owner queues exactly that failure for
 * a retry and the retry has to reach the device.
 */
export type WakelockDevice = {
  readonly activate: (tag: string) => Promise<void>
  readonly deactivate: (tag: string) => Promise<void>
}

export type NativeWakelockServer = {
  readonly serve: (params: unknown) => Promise<{ active: boolean }>
  /** Gives back every tag this session still holds. The page session's end and the screen's
   *  unmount both call it, exactly as they do for a staged media handle and a live microphone. */
  readonly dispose: () => void
}

export function createNativeWakelockServer(device: WakelockDevice): NativeWakelockServer {
  const held = new Set<string>()
  let disposed = false
  return {
    serve: async (params) => {
      const { active, tag } = wakelockSetParamsSchema.parse(params)
      if (active) {
        await device.activate(tag)
        // The session can end between the call and its reply — the page is a document that can be
        // swiped away mid-dictation — and a tag recorded after that dispose is held by nobody:
        // `dispose` has already walked the set and nothing will walk it again. So it is given back
        // here instead, and the page is told it is not held.
        if (disposed) {
          void device.deactivate(tag).catch(() => undefined)
          return { active: false }
        }
        held.add(tag)
        return { active: true }
      }
      if (held.has(tag)) {
        // Deleted only once the device has really dropped it. A refusal rejects out of here, which
        // is how the page's owner learns to queue a retry — and that retry arrives as another
        // `active: false`, so the tag has to still be recorded or it would answer "not held"
        // without calling anything and leave the native tag on for the life of the app.
        await device.deactivate(tag)
        held.delete(tag)
      }
      return { active: false }
    },
    dispose: () => {
      disposed = true
      for (const tag of held) {
        // Quiet, for the reason every other dispose here is: this runs while a screen is going
        // away, and a device that would not drop a tag is not something the page can be told about.
        // Forgotten only on success, so one this device refused stays recorded and a later release
        // still reaches it.
        void device.deactivate(tag).then(
          () => {
            held.delete(tag)
          },
          () => undefined
        )
      }
    }
  }
}
