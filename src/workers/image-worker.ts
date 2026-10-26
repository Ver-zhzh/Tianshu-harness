import { parentPort } from 'node:worker_threads'
// @ts-ignore — source workers run without parent test/loader flags.
import { createVisionImagePreview } from '../utils/vision-image-core.ts'

parentPort?.on('message', async ({ id, dataUrl }: { id: number; dataUrl: string }) => {
  try { parentPort!.postMessage({ id, result: await createVisionImagePreview(dataUrl) }) }
  catch { parentPort!.postMessage({ id, result: { dataUrl, reason: 'processor-unavailable' } }) }
})
