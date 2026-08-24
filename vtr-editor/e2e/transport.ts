import { expect, type Page } from '@playwright/test'

/**
 * Park the transport, and wait until it stays parked.
 *
 * A take punches vtr-player's transport in and leaves it running when the
 * take stops (see tap_client::punch_in), and the push reaches the editor
 * whenever it reaches it. A spec that drives playback or reads the playhead
 * has to start from a known stop, or a live playhead drifts under it.
 */
export async function stopTransport(page: Page): Promise<void> {
  const pause = page.getByRole('button', { name: 'Pause' })
  const play = page.getByRole('button', { name: 'Play' })
  await expect
    .poll(
      async () => {
        if ((await pause.count()) > 0) await pause.click({ timeout: 2000 }).catch(() => {})
        return play.count()
      },
      { timeout: 15_000 }
    )
    .toBeGreaterThan(0)
}
