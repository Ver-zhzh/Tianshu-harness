import { chmodSync, lstatSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

// Replace the DACL: /grant:r alone retains unrelated explicit ACEs.
export const PRIVATE_PATH_ACL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$path = $env:RIVET_PRIVATE_PATH
$item = Get-Item -LiteralPath $path -Force
if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse points are not private storage' }
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = if ($item.PSIsContainer) { New-Object Security.AccessControl.DirectorySecurity } else { New-Object Security.AccessControl.FileSecurity }
$acl.SetAccessRuleProtection($true, $false)
$inherit = if ($item.PSIsContainer) { 'ContainerInherit, ObjectInherit' } else { 'None' }
foreach ($sid in @($user.Value, 'S-1-5-18', 'S-1-5-32-544')) {
  $id = New-Object Security.Principal.SecurityIdentifier($sid)
  $rule = New-Object Security.AccessControl.FileSystemAccessRule($id, 'FullControl', $inherit, 'None', 'Allow')
  $acl.AddAccessRule($rule)
}
$current = $item.GetAccessControl()
if (@($user.Value, 'S-1-5-18', 'S-1-5-32-544') -notcontains $current.GetOwner([Security.Principal.SecurityIdentifier]).Value) { throw 'Untrusted storage owner is unsafe' }
# issue #450: normalize the SDDL before comparing (see normalizeAclSddlForComparison).
# Windows may read the DACL back as D:PAI(...) while the constructed target is
# D:P(...); with P (no parent inheritance) already set, AI is only a provenance
# marker and the effective grants are identical. Without normalization the two
# are forever judged "different", causing a tens-of-seconds full-subtree
# rewrite on every startup.
$curSddl = $current.GetSecurityDescriptorSddlForm('Access') -replace '^D:PAI', 'D:P'
$newSddl = $acl.GetSecurityDescriptorSddlForm('Access')
if ($curSddl -ne $newSddl) {
  if ($item.PSIsContainer) { [IO.Directory]::SetAccessControl($item.FullName, $acl) }
  else { [IO.File]::SetAccessControl($item.FullName, $acl) }
}
`

/**
 * issue #450: SDDL 语义归一化（与 PRIVATE_PATH_ACL_SCRIPT 内的 PowerShell
 * `-replace '^D:PAI', 'D:P'` 同规则）。读回的 DACL 头带 `AI`（自动继承标记，
 * 如 `D:PAI(...)`）而目标是 `D:P(...)` 时，有效权限完全相同，应判为已收敛，
 * 避免每次启动都在整棵子树上重跑数十秒的无效写入。
 */
export function normalizeAclSddlForComparison(sddl: string): string {
  return sddl.replace(/^D:PAI/, 'D:P')
}

export function protectPrivatePath(path: string, platform = process.platform): void {
  if (lstatSync(path).isSymbolicLink()) throw new Error('Private storage cannot be a symbolic link')
  if (platform !== 'win32') {
    chmodSync(path, lstatSync(path).isDirectory() ? 0o700 : 0o600)
    const effective = lstatSync(path)
    if (effective.isSymbolicLink() || (effective.mode & 0o077) !== 0) {
      throw new Error('Private storage permissions could not be enforced')
    }
    return
  }
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', PRIVATE_PATH_ACL_SCRIPT], {
    env: { ...process.env, RIVET_PRIVATE_PATH: path }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, timeout: 10_000,
  })
}

export function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  protectPrivatePath(path)
}
