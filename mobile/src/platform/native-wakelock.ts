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
  return {
    serve: async (params) => {
      const { active, tag } = wakelockSetParamsSchema.parse(params)
      if (active) {
        await device.activate(tag)
        held.add(tag)
        return { active: true }
      }
      if (held.delete(tag)) {
        await device.deactivate(tag)
      }
      return { active: false }
    },
    dispose: () => {
      for (const tag of held) {
        // Quiet, for the reason every other dispose here is: this runs while a screen is going
        // away, and a device that would not drop a tag is not something the page can be told about.
        void device.deactivate(tag).catch(() => undefined)
      }
      held.clear()
    }
  }
}
