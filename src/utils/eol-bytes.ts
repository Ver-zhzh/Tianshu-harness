/**
 * 行尾归一化 —— 候选 ref / 提交基准的哈希共用这一份判据。
 *
 * 为什么需要：验证快照由 `git worktree` 检出（LF blob），而工作区文件可能被编辑器
 * 存成 CRLF（`core.autocrlf=input` 明确不做检出转换）。按原始字节哈希时两者必然不等，
 * `candidateSnapshotRef(cwd) !== candidateSnapshotRef(snapshot.path)` → 报「候选快照不可用」，
 * 而 HEAD 与 index 根本没变（issue #537 的 A 项）。
 *
 * 归一化与 git 自身的比较语义对齐：`autocrlf=input|true` 下 git 同样认为 CRLF 与 LF
 * 是同一份内容。**失效方向（有意选择）**：只改行尾的净变化不再被视为变化——宁可漏检
 * 行尾噪声，也不让共享工作区里别的会话的行尾抖动把本会话的验证证据判废。
 * 在 `autocrlf=false` 且无 `.gitattributes` 的仓库里，这一点会与 git 的判断不一致；
 * 那种仓库需要显式的行尾规范，不该由 ref 哈希来守。
 *
 * 二进制（前 8KB 含 NUL）一律按原始字节，不做任何归一化——哈希不能被编码猜测影响。
 *
 * @module eol-bytes
 */

/** 二进制探测窗口：只看前 8KB，与 git 的 text/binary 判别同量级。 */
const BINARY_PROBE_BYTES = 8192

/** 超过这个大小不做归一化（保持流式原样哈希），避免整文件读入内存。 */
export const EOL_NORMALIZE_INLINE_LIMIT_BYTES = 2 * 1024 * 1024

const CR = 0x0d
const LF = 0x0a

/** 前 N 字节含 NUL 即视为二进制。 */
export function looksBinary(buffer: Uint8Array): boolean {
  const end = Math.min(buffer.length, BINARY_PROBE_BYTES)
  for (let i = 0; i < end; i++) {
    if (buffer[i] === 0) return true
  }
  return false
}

/**
 * 把 CRLF 归一为 LF。
 *
 * 不含 CRLF、或疑似二进制时原样返回同一个对象（零拷贝快路径）——
 * 绝大多数文件走这条，调用方不必先自己判断。
 */
export function normalizeEolBytes(buffer: Buffer): Buffer {
  if (looksBinary(buffer)) return buffer
  let firstCr = -1
  for (let i = 0; i + 1 < buffer.length; i++) {
    if (buffer[i] === CR && buffer[i + 1] === LF) { firstCr = i; break }
  }
  if (firstCr === -1) return buffer
  const out = Buffer.allocUnsafe(buffer.length)
  buffer.copy(out, 0, 0, firstCr)
  let w = firstCr
  for (let i = firstCr; i < buffer.length; i++) {
    if (buffer[i] === CR && i + 1 < buffer.length && buffer[i + 1] === LF) continue
    out[w++] = buffer[i]!
  }
  return out.subarray(0, w)
}