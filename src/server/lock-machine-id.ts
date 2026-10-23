import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { parseNativeDeviceFingerprint } from '../auth/account-device.js'

/** Native machine identity only: a shared .device-id cannot prove two writers are on one host. */
export async function probeLockMachineId(): Promise<string | undefined> {
  let identity: string | undefined
  if (process.platform === 'linux') {
    for (const path of ['/var/lib/dbus/machine-id', '/etc/machine-id']) {
      try { identity = parseNativeDeviceFingerprint('linux', readFileSync(path, 'utf8')) } catch { /* next source */ }
      if (identity) break
    }
  }
  if (!identity && process.platform === 'darwin') {
    identity = parseNativeDeviceFingerprint('darwin', await probe('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']))
  }
  if (!identity && process.platform === 'win32') {
    identity = parseNativeDeviceFingerprint('win32', await probe('reg.exe', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64']))
  }
  return identity ? createHash('sha256').update('tianshu-lock-machine-v1\0').update(identity).digest('hex') : undefined
}

function probe(command: string, args: string[]): Promise<string> {
  return new Promise(resolve => {
    try {
      const child = execFile(command, args, { encoding: 'utf8', timeout: 2_000, windowsHide: true }, (error, output) => resolve(error ? '' : output))
      child.unref?.()
    } catch { resolve('') }
  })
}
