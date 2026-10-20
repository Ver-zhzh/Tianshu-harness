import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { launcherConfigPath } from '../../config/paths.js'

for (const scenario of ['launcher', 'environment', 'blank-environment', 'default', 'broken-launcher', 'launcher-at-default'] as const) {
  test(`real logs CLI reports the selected data root and source: ${scenario}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'logs-launcher-source-'))
    try {
      const home = join(root, 'home'), cwd = join(root, 'project')
      mkdirSync(home); mkdirSync(cwd)
      const env: NodeJS.ProcessEnv = {
        ...process.env, HOME: home, USERPROFILE: home,
        APPDATA: join(home, 'Roaming'), LOCALAPPDATA: join(home, 'Local'), XDG_CONFIG_HOME: join(home, '.config'),
      }
      for (const key of ['RIVET_HOME', 'RIVET_SESSION_DIR', 'RIVET_CONFIG_PATH', 'RIVET_DESKTOP_DIR', 'RIVET_DESKTOP_SESSION_DIR', 'NODE_TEST_CONTEXT']) delete env[key]
      const platformDefault = process.platform === 'win32' ? join(env.LOCALAPPDATA!, '.rivet') : join(home, '.rivet')
      const launcherHome = scenario === 'launcher-at-default' ? platformDefault : join(root, 'desktop-data')
      const launcher = launcherConfigPath({ home, env })
      if (scenario !== 'default') {
        mkdirSync(dirname(launcher), { recursive: true })
        writeFileSync(launcher, scenario === 'broken-launcher' ? '{broken' : JSON.stringify({ rivetHome: launcherHome }))
      }
      if (scenario === 'environment') env.RIVET_HOME = join(root, 'env-data')
      if (scenario === 'blank-environment') env.RIVET_HOME = '   '
      const expectedSource = scenario === 'environment' ? 'RIVET_HOME'
        : scenario === 'default' || scenario === 'broken-launcher' ? 'platform-default' : 'launcher.json'
      const expectedHome = scenario === 'environment' ? env.RIVET_HOME!
        : expectedSource === 'platform-default' ? platformDefault : launcherHome
      const expectedLabel = expectedSource === 'RIVET_HOME' ? 'RIVET_HOME 环境变量'
        : expectedSource === 'launcher.json' ? '桌面端 launcher.json' : `平台默认（${platformDefault}）`
      const source = `
        import assert from 'node:assert/strict';
        import { mkdirSync, writeFileSync } from 'node:fs';
        import { join } from 'node:path';
        import { runLogsCLI } from ${JSON.stringify(new URL('../logs-cli.ts', import.meta.url).href)};
        import { projectSlug, rivetHome } from ${JSON.stringify(new URL('../../config/paths.ts', import.meta.url).href)};
        const cwd = ${JSON.stringify(cwd)}, home = ${JSON.stringify(expectedHome)};
        const session = join(home, 'sessions', projectSlug(cwd), 'fixture');
        mkdirSync(session, { recursive: true });
        writeFileSync(join(session, 'cache-log.jsonl'), '{}\\n');
        const json = JSON.parse(runLogsCLI(['--session', 'fixture', '--json'], { cwd }).output);
        assert.equal(rivetHome(), home);
        assert.equal(json.rivetHome, home);
        assert.equal(json.homeSource, ${JSON.stringify(expectedSource)});
        assert.equal(json.locations.find(l => l.id === 'cache-log').exists, true);
        const text = runLogsCLI(['--session', 'fixture'], { cwd }).output;
        assert.equal(text.split('\\n').find(l => l.includes('来源')), ${JSON.stringify('        来源 ' + expectedLabel)});
        assert.equal(json.overrides.some(o => o.env === 'RIVET_HOME'), ${scenario === 'environment'});
      `
      const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
        env, encoding: 'utf8', timeout: 20_000,
      })
      assert.equal(result.status, 0, result.stderr || String(result.error ?? result.signal))
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
}
