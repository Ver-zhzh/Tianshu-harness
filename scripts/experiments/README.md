# Obstacle followthrough experiment

This is a live DeepSeek continuation experiment with controlled tool results. It
uses the production `PromptEngine`, the domain's main-controller volatile block,
and (where applicable) the actual error-diagnosis hook. It is **not** a complete
AgentLoop, operating-system, desktop, or Windows integration benchmark.

The tool world is a finite fixture. No model-generated shell commands execute.
The fixture's facts measure observed actions, not whether the assistant's final
claims are correct. Review final claims against the JSONL tools independently.
In particular, the sidecar fixture deliberately retains the original experiment's
one-line-file / 26-rendered-lines inconsistency for reproducibility; it cannot
prove complete rendering acceptance. An adapter-unsupported result is not a
product failure and must be scored separately.

Run a baseline **before** editing production prompts:

```sh
rtk node --import tsx scripts/experiments/obstacle-followthrough.ts --phase A --output /absolute/path/to/new-experiment
```

After making and checking the prompt changes, run the same protocol:

```sh
rtk node --import tsx scripts/experiments/obstacle-followthrough.ts --phase B --output /absolute/path/to/new-experiment
```

Use `--phase B2` for a revised candidate; evidence directories are never
overwritten. `--repetitions 1..3` must be identical across phases. Each trial is
limited to 12 model requests, with an output-token stop threshold of 24,000 and
8,192 maximum tokens per request. There is a 30-minute phase deadline. No network
request is automatically retried. HTTP rejection stops the phase for inspection.

Only the official HTTPS DeepSeek endpoint is supported. `DEEPSEEK_API_KEY`, or
the configured official provider's normal credential resolver, authenticates the
request in memory. The script does not invoke config migrations, install models,
or print credential material. It performs a model-catalog preflight. Runtime
session roots are redirected before importing the prompt renderer. Running it
makes billable model calls; it is never part of the default test suite.

Each phase contains:

- `manifest.json`: source hashes, model options, fixture/tool hashes and budgets.
- `<domain>-<case>-<repetition>.jsonl`: initial prompt, visible model responses,
  tool calls/results, response identity, finish reason, usage and fact observations.
  Thinking is carried in memory when required by the API; only its length and hash
  are persisted.
- `results.jsonl` and `summary.json`: per-trial facts, final/timeout/budget status,
  adapter limits and final prose. `objectiveObserved` does not mean the entire
  product task passed, especially for proxy and missing-credential scenarios.

The B guard requires identical model/options, fixture/tools, repetitions and
budgets, plus unchanged engine and volatile-renderer source. It intentionally
allows changes to static/domain prompts and error-diagnosis content. Compare
response fingerprints as an additional check; a fingerprint is not a weights
checksum. Record local dirty-tree limitations and inspect actual initial prompt
diffs before attributing a change to the candidate.

The first run should be treated as a small exploratory sample. Do not turn
`adopted`, tool count, first observed fact, or a single final response into a
general adherence score. Keep all candidates and report neutral/negative results.

## Domain scope and evidence-bound acknowledgement experiment

`domain-recovery.ts` is a separate 2×2 exploratory protocol: current/scoped Qisha
volatile text crossed with neutral/positive wording around identical facts and
next actions. It does not change production domain definitions or hook defaults.
It uses real local tools, POSIX Python and SessionJobs in temporary directories,
with finite per-case command/file/patch capabilities. Review-only, actual missing
environment fields and running jobs remain separate from successful repairs.

```sh
rtk npm test -- scripts/__tests__/domain-recovery-experiment.test.ts
rtk node --import tsx scripts/experiments/domain-recovery.ts --output /absolute/new-design-directory
rtk node --import tsx scripts/experiments/domain-recovery.ts --live --output /absolute/new-live-directory
```

Each output directory is immutable; design-only and live runs need separate paths.
`--live` makes billable official DeepSeek requests, up to 16 trials by default,
8 requests per trial, with two execution slots and a 25-minute phase deadline.
`--repetitions 2` doubles trials and should be a separately registered run.
Thinking is retained only in memory for protocol continuation; traces contain
visible replies, tool evidence and thinking length. Requests, source hashes,
actual bus delivery and final artifact checks are recorded; results do not prove
full AgentLoop, noisy advisory competition, Windows, or unrestricted coding.

The existing `systemPromptSuffix` field is display-only. All experimental domain
treatments use the actual `volatileBlock`; no worker delivery claim follows from
testing display text. In the earlier protocol above, “worker-only suffix” in the
manifest description is historical incorrect wording, not an injected component.

## Longer evidence-bound recovery pilot (group 3)

`recovery-long.ts` fixes the group-2 production domain boundaries in both arms.
A receives neutral evidence; B receives the same evidence with one specific
acknowledgement. The synthetic durable-task service covers stale results, retry,
cancellation, restart identity, namespace isolation and journal replay. It is
not a historical issue or an unrestricted shell benchmark.

```sh
rtk npm test -- scripts/__tests__/recovery-long-experiment.test.ts
rtk node --import tsx scripts/experiments/recovery-long.ts --output /absolute/new-qualification-directory
rtk node --import tsx scripts/experiments/recovery-long.ts --live --output /absolute/new-live-directory
```

The runner qualifies initial RED and reference GREEN before any provider call.
Model source patches are free-form; original checks are protected. The private
12-case grader stays outside the model workspace and runs independently after
the first natural final, truncation or budget stop. Grading checks legacy event
replay; it does not certify migration of old namespace storage layouts.

Protocol v2 permits 48 requests, 60,000 completion tokens and 18 minutes per
trial; each response is capped at 16,384 tokens. Default is one pair with two
execution slots; n=1 is exploratory. v1's 6,144-token responses were truncated
before editing, with no B feedback exposure, and are retained as qualification
failures rather than treatment-effect results. There are no automatic HTTP or
post-final retries, and no production hook/PAL changes.

Real PromptEngine, AdvisoryBus and file tools are used in a controlled loop,
not a full AgentLoop. Recognition uses the encouragement category; the pilot
controls flow off and tests suppression separately. Dispatch checks source
binding again so edits later in a tool batch cannot make stale praise current.
Response IDs, timestamps, fingerprints, usage, feedback delivery, tools and final
artifacts are retained. Reasoning remains in memory only; traces retain length.

Model-written code runs through a clean-environment Node process with Seatbelt
and Node permissions. External reads, subprocesses and network are denied;
non-macOS platforms fail closed in this first pilot. Do not claim Windows or
full runtime compatibility from this run. Scripted tests exercise isolation,
free-form edits, batch-read parity, stale/missing evidence and partial repairs.

Historical follow-up: `--task scoped-hook --repetitions 3` extracts the real
pre-`61ad99a89` delivery helpers plus a declared minimal facade/HTTP host. It
permits real Git/hook children under inherited Seatbelt restrictions and only
the current server's loopback port. The installed Git executable is resolved
before isolation; user configuration and launcher cache writes are excluded.
Qualification requires actual hook execution, correct owned-file isolation and
blocked health probes on the original, then all 12 behaviours on the reference.
Each trial allows 60 requests, 60,000 completion tokens and 25 minutes, stopping
at the first natural final. This remains an exploratory controlled loop rather
than a full production AgentLoop or Windows acceptance test.

### Protocol v4 (current)

The current `recovery-long.ts` defaults to the historical scoped-hook task.
It uses the configured model's production streaming client, high thinking and
full request output allowance (currently 256,000), with twice that completion
budget per trial. It reserves a complete request before dispatch and never
shrinks the final request to a leftover allowance. Missing/aborted usage keeps
the reservation. A length stop cannot execute any tool arguments.

Task capability contracts govern both tool descriptions and path validation.
Declared `.build` output is readable, generated/protected inputs are read-only,
and test listeners use the two assigned loopback ports through
`support/test-server.mjs`. External files/network remain denied. Preflight
proves these capabilities before provider calls; raw diagnostics remain in
evidence while expected launcher warnings are omitted from model summaries.

Checks distinguish exited flow, executed stages and passing evidence. Grading
retains pass/fail/inconclusive obligations, accepts valid cancellation status
variants, and verifies real Git contents. The historical task now has 15 cases
and a versioned experiment-only correction to its reference cleanup. Synthetic
assertions run in the parent with a separate sandboxed API process.

Every dispatch snapshots its messages and tools. An offline two-turn production
client fixture checks continuation before billing. Known pre-send guard failures
release unsent reservations; provider tool-name protocol errors are distinct
from transport failures and never trigger guessed tool execution or replay.
Cancellation status variants are declared in the task contract; unknown states
remain inconclusive and actual process/repository behaviour is still checked.

```sh
rtk node --import tsx scripts/experiments/recovery-long.ts --task scoped-hook --output /absolute/new-offline-directory
rtk node --import tsx scripts/experiments/recovery-long.ts --task scoped-hook --live --output /absolute/new-live-directory
rtk node scripts/experiments/verify-recovery-mutations.mjs /absolute/new-mutation-directory
```

Live runs first record two neutral capacity trials. Only natural completion,
measured usage and no adapter faults permit the separately recorded A/B phase;
correct candidate answers are not required for capacity qualification. Use
`--capacity-only` to stop after that phase. Prior v2/v3 records are unchanged.

## Retrieval calibration ablation (separate protocol)

`retrieval-convergence.ts` compares the current DeepSeek calibration (A), its
removal (B), and evidence-scoped retrieval guidance (C). The production prompt
is unchanged. Each initial request is independently rendered and only its
calibration suffix differs; error feedback and acknowledgement are not factors.

The three tasks are a read-only alias/default diagnosis, the synthetic durable
service and the historical scoped-hook repair. Production `GREP_TOOL` searches
a disposable copy of declared task inputs, excluding private graders, temporary
repositories, runtime files and symlinks. This is an explicit experiment scope,
not a claim of full workspace search or production AgentLoop equivalence.
Byte-checked observation mapping preserves production grep-to-editor semantics:
only files marked observed by grep are registered at their original workspace
paths in the actual editor session. An offline qualification and real write
consumer test guard against introducing an artificial extra-read requirement.

Version-bound exact repeated output is a conservative lower bound. Metrics
separate read/grep/check UTF-8 bytes from actual request usage; bytes are never
reported as tokens. Attribution and unsupported final claims require human
review alongside independent behaviour grades.

```sh
rtk npm test -- scripts/__tests__/retrieval-convergence.test.ts
rtk node --import tsx scripts/experiments/retrieval-convergence.ts --output /absolute/new-offline-directory
rtk node --import tsx scripts/experiments/retrieval-convergence.ts --live --output /absolute/new-live-directory
```

Every live run repeats offline qualification then two neutral capacity trials.
Both must end naturally with measured usage and no adapter fault before any
ablation begins. Default is one run per task/arm (nine pilot runs, concurrency
two); `--repetitions 3` is a separately registered 27-run replication. No
automatic replication, retries, continuations or budget reduction are allowed.
`--capacity-only` stops before the pilot even if capacity qualifies. Capacity,
ablation, old protocols and posthoc analyses remain separate.

New runs use `retrieval-calibration-v4-scoped-projection`; existing v3 records
and scores are unchanged. A grep projection contains only the selected path
(the declared inputs for a root query). Its 32 MiB / 2048-file ceiling rejects
the entire query without returning partial evidence, and a smaller path can
recover. File sizes are checked before bounded reads; growth during reading
also stops at the remaining budget. Qualification recognizes the production
`[truncated: showing ...]` marker rather than depending on Chinese wording.

Mutation verification now runs the same selected tests in a fresh isolated
baseline first. Only a completed GREEN followed by an applied mutation and an
assertion RED in those tests is accepted. Empty selections, file placeholders,
skips, TODOs, cancellation, startup errors and unrelated failed tests are rejected.
Each check records both `<name>.baseline.log` and `<name>.log`.
