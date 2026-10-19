import { prepareCompletionCapture, type CompletionCapture } from '../tools/test-completion.js'

let capture: CompletionCapture | undefined
let queue = Promise.resolve()
process.on('message', (message: { id: number; operation: string; args: unknown[] }) => {
  queue = queue.then(async () => {
    try {
      let result: unknown
      if (message.operation === 'prepare') {
        capture = prepareCompletionCapture(...message.args as Parameters<typeof prepareCompletionCapture>)
        result = capture ? { command: capture.command, env: capture.env, preparationError: capture.preparationError } : null
      } else if (message.operation === 'delivery-plan') {
        const { buildDeliveryVerificationPlan } = await import('../agent/delivery-verification-plan.js')
        result = buildDeliveryVerificationPlan(...message.args as Parameters<typeof buildDeliveryVerificationPlan>)
      } else if (message.operation === 'delivery-scan') {
        const { scanDeliveryFiles } = await import('../agent/delivery-readonly.js')
        result = scanDeliveryFiles(...message.args as Parameters<typeof scanDeliveryFiles>)
      } else if (message.operation === 'test-plan') {
        const { buildTestExecutionPlan } = await import('../tools/test-execution-plan.js')
        result = buildTestExecutionPlan(...message.args as Parameters<typeof buildTestExecutionPlan>)
      } else if (message.operation === 'read') result = await capture?.read(message.args[0] as number)
      else if (message.operation === 'dispose') { capture?.dispose(); process.disconnect(); return }
      else throw new Error('unsupported verification worker operation')
      process.send?.({ id: message.id, result })
    } catch { process.send?.({ id: message.id, error: 'verification_worker_failed' }) }
  })
})
process.on('disconnect', () => { capture?.dispose(); process.exit(0) })
