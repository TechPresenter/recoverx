import { IpcChannel } from '@shared/ipc/channels'
import type { IpcRegistry } from '../ipc-registry'

/**
 * Preview channel.
 *
 * One call per file, on demand. Previews are never generated eagerly: a scan
 * can produce millions of results, and reading even the first block of each
 * would turn a metadata scan back into a full-surface read.
 */
export function registerPreviewHandlers(registry: IpcRegistry): void {
  registry.register(IpcChannel.PreviewFile, async ({ fileId }, { app: context }) =>
    context.previews.preview(fileId),
  )
}
