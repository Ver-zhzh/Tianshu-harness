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
