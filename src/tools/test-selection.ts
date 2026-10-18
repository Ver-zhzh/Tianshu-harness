/** Project and suite partitioning are orthogonal to case filtering. */
export interface TestSelection {
  projects: string[]
  ignoredProjects: string[]
  shard?: { index: number; total: number }
  allProjects?: boolean
  unsharded: boolean
  overrideProjects: string[]
  rest: string[]
  reason?: string
}
export function parseTestSelection(argv: readonly string[]): TestSelection {
  const result: TestSelection = { projects: [], ignoredProjects: [], overrideProjects: [], unsharded: false, rest: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!, key = arg.split('=')[0]!
    if (arg === '--') { result.rest.push(...argv.slice(i)); break }
    if (arg === '--rivet-all-projects') { result.allProjects = true; continue }
    if (arg === '--rivet-unsharded') { result.unsharded = true; continue }
    if (!['--project', '--selectProjects', '--ignoreProjects', '--shard', '--test-shard', '--rivet-project'].includes(key)) { result.rest.push(arg); continue }
    const values: string[] = []
    if (arg.includes('=')) values.push(arg.slice(key.length + 1))
    else if (argv[i + 1] && !argv[i + 1]!.startsWith('-')) values.push(argv[++i]!)
    if (['--selectProjects', '--ignoreProjects'].includes(key) && !arg.includes('=')) while (argv[i + 1] && !argv[i + 1]!.startsWith('-')) values.push(argv[++i]!)
    if (!values.length || values.some(value => !value)) { result.reason = `选项缺少值：${key}`; break }
    if (key === '--shard' || key === '--test-shard') {
      const match = /^(\d+)\/(\d+)$/.exec(values[0]!)
      const index = Number(match?.[1]), total = Number(match?.[2])
      if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || index < 1 || total < index) { result.reason = `无效分片：${values[0]}`; break }
      result.shard = { index, total }
    } else (key === '--ignoreProjects' ? result.ignoredProjects : key === '--rivet-project' ? result.overrideProjects : result.projects).push(...values)
  }
  return result
}
