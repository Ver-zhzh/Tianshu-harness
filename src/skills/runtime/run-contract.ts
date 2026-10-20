/**
 * Skill Python 运行时共享契约（issue #523）。
 * WP1 落地声明解析与诊断；后续工作包（环境准备 / 执行）复用这里的类型与错误码。
 * 本模块只放类型——不得引入运行时依赖，供 loader / CLI / server 各层引用。
 */

/** 技能运行环境状态机。WP1 只会产出 undeclared / invalid / interpreter-missing / not-prepared；
 *  WP2 起增加 preparing / ready / failed / environment_stale（解释器漂移，需显式重建）。 */
export type RuntimeStatus =
  | 'undeclared'
  | 'interpreter-missing'
  | 'not-prepared'
  | 'preparing'
  | 'ready'
  | 'invalid'
  | 'failed'
  | 'environment_stale'

export type RuntimeErrorCode =
  | 'interpreter_missing'
  | 'version_mismatch'
  | 'venv_missing'
  | 'pip_missing'
  | 'invalid_declaration'
  | 'invalid_requirements'
  | 'network_failure'
  | 'no_wheel'
  | 'source_build_failed'
  | 'permission_denied'
  | 'sandbox_denied'
  | 'environment_stale'
  | 'script_failed'
  | 'timeout'
  | 'cancelled'
  | 'environment_not_prepared'
  | 'environment_busy'
  | 'package_version_unavailable'
  | 'process_cleanup_failed'
  | 'preview_mismatch'

/** 一次运行时操作（探测 / 准备 / 执行）的结构化结果。字段按需出现，保持精简。 */
export interface RuntimeResult {
  operationId?: string
  stage: 'detect' | 'prepare' | 'run'
  errorCode?: RuntimeErrorCode
  message: string
  exitCode?: number
  stdout?: string
  stderr?: string
  /** 持久化日志的引用（artifact 路径或 id）。 */
  logRef?: string
  /** 执行类操作的结构化产出。 */
  outputs?: Record<string, unknown>
  /** 实际使用的解释器路径。 */
  interpreter?: string
  /** 技能包版本（fingerprint）。 */
  packageVersion?: string
  /** 沙箱画像标识。 */
  sandbox?: string
}
