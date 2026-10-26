/**
 * 只读工具并发（`tools.readConcurrency`）的默认值与上下限——唯一来源。
 *
 * schema 校验、默认配置、主控调度器、worker 与子进程 worker 都从这里取，
 * 不再各自写 `?? 4` 或本地 `Math.min(4, …)`：两处各写一份上限时，放宽 schema
 * 会让调度器静默封顶，而且没有任何断言能发现。
 */
export const READ_CONCURRENCY = { min: 1, max: 4, default: 4 } as const

/** 上下限的形状（默认值取 READ_CONCURRENCY）。测试用它注入放宽/收窄的边界，
 *  证明 clamp 的边界完全来自参数——没有内嵌的 `4`。 */
export interface ReadConcurrencyBounds { readonly min: number; readonly max: number; readonly default: number }

/**
 * 把任意输入收敛到合法区间。非数字、NaN、Infinity 走默认值；小数向下取整。
 * 调度器用它做防御（配置已由 schema 校验，worker 间传参仍需自证合法）。
 */
export function clampReadConcurrency(value: number | undefined, bounds: ReadConcurrencyBounds = READ_CONCURRENCY): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return bounds.default
  return Math.min(bounds.max, Math.max(bounds.min, Math.floor(value)))
}
