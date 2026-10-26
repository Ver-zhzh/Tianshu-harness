# Public release catalog

`catalog.mjs` defines schema version 1 and source validation. The website keeps a byte-identical copy; desktop coordination remains private. Catalog revisions may change availability, but a version/platform/purpose must keep the same package bytes and updater signature. macOS installation DMGs and update archives are different artifacts.

## Release body installation preamble (mandatory)

Every release body must lead with the cross-platform installation guide. It lives in a single source, `docs/releases/install-preamble.md`, and is composed into the body — never hand-written per release:

```sh
# Full compose (install preamble + docs/releases/vX.Y.Z.md changelog):
node scripts/releases/compose-release-body.mjs --version X.Y.Z --out release/body.md
gh release edit vX.Y.Z --notes-file release/body.md

# Repair an already-published release whose body was hand-curated (prepends the preamble, keeps the existing body):
gh release view vX.Y.Z --json body --jq .body > release/existing-body.md
node scripts/releases/compose-release-body.mjs --version X.Y.Z --prepend-to release/existing-body.md --out release/body.md
gh release edit vX.Y.Z --notes-file release/body.md
```

The composer fails closed on a missing/empty preamble, rewrites relative links to absolute GitHub URLs, injects the version into artifact names (`Tianshu_<版本>_aarch64.dmg`), and is idempotent when prepending to a body that already carries the guide.

For repairing metadata of the **already controlled stable version**, after building, signing and uploading its GitHub release:

```sh
node scripts/releases/generate-catalog.mjs
for platform in darwin-aarch64 darwin-x86_64 windows-x86_64; do
  node scripts/releases/publish-atomgit.mjs --platform "$platform" --purpose update --assets-only --publish
done
node scripts/releases/generate-catalog.mjs --atomgit  # live anonymous verification before verified:true
node scripts/releases/publish-atomgit.mjs --metadata-only --catalog release-catalog.json --assets release --publish
node scripts/releases/publish-routing.mjs                # review metadata publication
node scripts/releases/publish-routing.mjs --publish --website ../tianshu-website
```

**Or repair that same controlled stable version through the fail-closed wrapper** (pre-checks + post-verify with retry). A new candidate must use the stage and promote flow below; the wrapper rejects a version different from the local `update-control.json` stable version. AtomGit is mandatory: a missing tag, tag-probe failure or explicit `--skip-atomgit` stops the wrapper before any publication step:

```sh
bash scripts/releases/publish-release-catalog.sh             # dry run (read-only pre-checks)
bash scripts/releases/publish-release-catalog.sh --publish   # publish
```

If `github.com` is unreachable from your network, Node's built-in fetch times out even when `git`/`gh` still work through `git config http.proxy` — Node ignores env proxies unless told otherwise. Prefix with `HTTPS_PROXY=<proxy> NODE_USE_ENV_PROXY=1` in that case.

AtomGit requires the version tag to be mirrored beforehand. The publisher consumes `ATOMGIT_ACCESS_TOKEN` or the system Git credential helper without displaying either. Upload credentials are never used on the anonymous readback path. `anonymous-download.mjs` streams the complete body to verify size and SHA-256 without retaining a large package, then requests an exact prefix Range and checks HTTP 206, `Content-Range`, total size and returned bytes. Login pages, truncation, wrong digests and ignored or incorrect Range responses fail verification. No signed temporary URL is persisted.

Existing attachments and newly uploaded attachments both take this path; a same-name attachment with different bytes is an immutable conflict and is never overwritten. Packages, signatures, checksums, `latest.json` and `release-catalog.json` use the same verifier. A post-upload verification failure can leave immutable attachment bytes on the provider, but does not mark the catalog source verified or publish enabled metadata; retry verifies the existing bytes instead of replacing them.

For several platforms, run `--platform <platform> --publish --assets-only` for each intended update platform. `generate-catalog.mjs --atomgit` performs fresh verification for every update platform and only then writes `verified:true, anonymous:true`; injected verifiers exist only for tests, and manual AtomGit evidence cannot replace live verification. An incomplete platform set fails before any metadata upload. Revalidation of identical bytes preserves the original proof timestamp so an interrupted metadata retry keeps the pinned catalog byte-identical.

After successful `--atomgit` catalog generation, finalize or resume metadata publication without reuploading/revalidating the large package (the final promotion gate independently verifies every package again):

```sh
node scripts/releases/publish-atomgit.mjs --metadata-only --catalog release-catalog.json --assets release
# Review the complete platform list, then explicitly publish:
node scripts/releases/publish-atomgit.mjs --metadata-only --catalog release-catalog.json --assets release --publish
```

This uploads and anonymously reads back both `latest.json` and `release-catalog.json`, preserving the exact catalog bytes published to GitHub/OSS and pinned by update control. Identical existing metadata is verified and reused; different immutable files are rejected. Adding platforms after immutable metadata has already been uploaded requires a new release or a separately reviewed metadata revision. Repeating a partially completed publication preserves verified proof timestamps and the revision. `--assets-only` does not publish metadata, but still requires package, signature and checksum readback to succeed.

Controlled clients prefer the pinned AtomGit catalog, then the pinned OSS **metadata**, then GitHub in automatic/AtomGit mode; explicit GitHub mode prioritizes GitHub metadata. This does not enable automatic OSS package downloads. Each metadata route retries direct after an application-proxy network failure, including fresh version manifests as well as restored manifests. Catalog digest/format/size failures stop the operation instead of falling through to another mirror. Both control sources are still checked for pause, revocation and the highest revision; a fast package mirror does not bypass policy. Existing releases without an AtomGit catalog continue through the fallback metadata routes.

Only the catalog is published to GitHub/OSS by `publish-routing.mjs`; the existing package upload workflow remains responsible for OSS backup files. Before release-notes, GitHub or root OSS writes, routing now closes out the original catalog bytes at `oss://tianshu-update/tianshu/v<version>/release-catalog.json` and anonymously reads them back. A first publication uploads exactly once; identical existing bytes are reused without upload; different bytes fail with `Pinned OSS catalog cannot be replaced` before any remote write. Dry-run only performs these reads. This version-pinned close-out must complete before `publish-update-control.mjs promote` readiness. Update-control uses the same helper for idempotent stage/retry flows; during promote its later pinned upload remains after readiness and is never moved earlier.

Routing also checks the existing GitHub catalog for immutable artifact identity and monotonic revisions, then publishes the root catalog and requests the website's existing `tianshu-release` dispatch. GitHub and OSS permissions plus website dispatch access must be configured on the publishing host. The site's daily deployment remains a compensating run. Files uploaded before a later failure stay in place for idempotent retry.

Old OSS `latest.json` is unchanged unless the operator supplies `--enable-legacy-atomgit`. That option refuses to redirect Windows unless the catalog contains verified anonymous AtomGit evidence and the original signature matches. New clients never select an OSS package automatically; a manual OSS attempt still verifies the original updater signature and catalog SHA-256 before installing. CLI/npm updates are unchanged.

Desktop source and terminal download events are stored in the application's data directory as `update-downloads.jsonl`. `report-routing.mjs <ledger>` reports source choice, fallbacks, success/failure and received bytes. These are client observations, **not** OSS billed egress or website click counts. Retrieve those separately from provider billing/access logs and website analytics.

Checks:

```sh
node --test scripts/releases/catalog.test.mjs
node scripts/releases/verify-restored-defects.mjs
cargo test --manifest-path desktop/src-tauri/Cargo.toml update_routing --lib
python3 desktop/scripts/verify-update-rust-defects.py
cd desktop
node --import tsx scripts/verify-update-routing.mjs
```

Human-facing release summaries live in `docs/releases/summaries/<version>.json`. Supply both languages and no more than three reviewed highlights. `generate-catalog.mjs` adds the optional `releaseNotesUrl` only when a matching validated summary exists. `publish-routing.mjs` publishes `release-notes.json` before the catalog and refuses to replace different bytes for the same version. The desktop bundles these same files for offline display. Existing catalogs and notes-free releases remain supported.

Before publishing a catalog with `releaseNotesUrl`, a release owner must review both localized summaries and supply `--release-notes-reviewed`. The checked-in 3.28.0 summary is a reviewable initial draft, not evidence of that human approval. No notes or routing data are uploaded by the desktop build.


## Controlled desktop rollout

The independent control protocol uses `update-control.json` at the OSS fixed path and at GitHub's fixed `update-control` prerelease attachment. It does not resolve through `releases/latest`. This is release metadata only; desktop implementation stays private.

First release a fully tested desktop version containing the control client. Before users install it, initialize revision 1 from the current stable catalog. Initialization must be deployed before the control client needs to update: missing or invalid control blocks new downloads and installs. Old clients continue using the existing stable endpoints.

```sh
node scripts/releases/publish-update-control.mjs init --catalog release-catalog.json
# Add --publish only after reviewing the dry run.
```

Upload the next signed numeric-version release as **prerelease**, along with its complete, source-qualified `latest.json`, `release-catalog.json` and release notes. Finish source qualification before staging: referenced catalog bytes become immutable. Keep the previous stable catalog and legacy manifests unchanged. OSS package uploads must use `bash scripts/upload-update-to-oss.sh --assets-only`; AtomGit's existing immutable package publisher can also be used with `--assets-only`; do not run the stable close-out wrapper for a candidate.

Root `latest.json` and `release-catalog.json` describe `update-control.json`'s stable release. The development package version may be newer. Check their versions, exact catalog digest, platform coverage, signatures and verified URLs with `node scripts/releases/check-workspace-metadata.mjs`. Candidate manifests belong in `release/candidates/<version>/`; generate them with explicit `--manifest` and `--out` paths. Generators and AtomGit proof writes preserve pinned root bytes and reject changes to that root. Save additional source qualification proofs in a separate draft catalog. Copy candidate metadata to the root only as part of the reviewed promotion transaction described below.

Copy `rollout-acceptance.example.json` into your release working directory and fill it from actual tests. `passed`, `sha256`, timestamp and a maintainer conclusion are required per platform. The supplied template deliberately cannot pass validation. Do not substitute an automated browser fixture for a real signed upgrade.

```sh
node scripts/releases/publish-update-control.mjs stage --catalog release/candidate-catalog.json --platforms windows-x86_64,darwin-aarch64,darwin-x86_64 --acceptance release/rollout-acceptance.json
node scripts/releases/publish-update-control.mjs set-percentage --catalog release/candidate-catalog.json --percentage 1 --acceptance release/rollout-acceptance.json
node scripts/releases/publish-update-control.mjs pause --catalog release/candidate-catalog.json --platforms windows-x86_64
node scripts/releases/publish-update-control.mjs resume --catalog release/candidate-catalog.json --platforms windows-x86_64
node scripts/releases/publish-update-control.mjs revoke --catalog release/candidate-catalog.json
```

Each command defaults to a read-only dry run. `--publish` explicitly writes remote metadata. `--control FILE` selects the local confirmed control snapshot; `--transaction FILE` selects the local retry receipt (default `release/update-control-transaction.json`). Preserve this receipt after partial failure and retry the exact command and evidence. It preserves the revision, verifies already-written bytes and completes remaining sources. Another publisher's newer revision or conflicting content stops the retry. Both sources are read back before reporting success. Candidate operations never refresh the website or replace legacy stable manifests.

Suggested manual steps are preview → 1 → 5 → 20 → 50 → 100 percent. Configure all intended platforms at staging. Each increase requires platform evidence; percentages cannot decrease. Pause freezes new download and installation attempts; an existing transfer may finish but still cannot install. Revocation applies to the whole candidate version and cannot be undone. Publish a higher version to repair an already-installed faulty release; there is no automatic downgrade. Revocation history must remain in future revisions. Control and catalog responses are capped at 256 KiB.

The install cohort is random and stored locally, stable across upgrades, independent per version/platform, and never transmitted. Ordinary manual checks obey the same cohort rules. Explicit update preview bypasses percentages only for active candidates, downloads manually, and cannot bypass pause, revocation or verification. Turning preview off does not downgrade an installed version and blocks an unpromoted cached preview package. Preview is public access, not an authorization mechanism.

New clients fetch both control sources on checks and revalidate over the network before download, cache restoration and stopping tasks for installation. No legacy latest fallback exists. Checks currently use fresh metadata instead of caching it. During a transfer, revocation is observed by a 60-second policy poll and a completion check; this is not remote push. Policy/network failures preserve verified cached packages. Revoked packages are discarded when revocation is observed. Old-format stable receipts remain readable and can install eligible, non-revoked versions up to the current stable release. A shutdown-save override never overrides update policy.

Promote only after every published update platform reaches 100% and acceptance records include an actual updater-driven upgrade from the installed stable version through download, installation, relaunch and ready sidecar (`realSignedUpgrade: true`). Checking signatures or launching a bundled CLI alone is insufficient evidence. Record the installed source and before/after versions in each platform conclusion. The root catalog and root `latest.json` must match the candidate, and bilingual release notes require publisher review. Before saving a transaction, uploading control bytes or exposing stable, `verifyPromotionReadiness` independently requires:

- the mirrored AtomGit tag and anonymous full-byte/size/SHA-256/exact-Range verification of every update platform's AtomGit, GitHub **and legacy-client OSS** package;
- byte-identical anonymous AtomGit, GitHub and OSS version-pinned `release-catalog.json` matching the control `catalogSha256`;
- AtomGit and GitHub version-pinned `latest.json` with the same version, exact update platform set, source-specific download URLs and updater signatures as the catalog.

Failures are aggregated with the platform and stable public endpoint. This gate also runs during a promotion dry run. Emergency `pause` and `revoke` operations do not invoke it and cannot be blocked by a broken new source. Promotion remains the only controlled operation that changes the old stable endpoints and dispatches a website refresh:

At promotion, the legacy OSS root `latest.json` is generated from the candidate manifest only after its platform URLs and signatures match the controlled catalog. Its package URLs are changed to the anonymously verified OSS objects while the updater signatures remain byte-identical. The uploaded root manifest is read back by digest before the transaction is marked complete. Existing clients reading the OSS endpoint therefore keep a domestic package route; a candidate package upload uses `--assets-only` and does not move that stable pointer.

```sh
node scripts/releases/publish-update-control.mjs promote --catalog release-catalog.json --acceptance release/rollout-acceptance.json --release-notes-reviewed --website ../tianshu-website
```

Run the command as a dry run first; add `--publish` after review. Promotion is multi-step rather than globally atomic: the saved receipt identifies partial completion, and retries converge control, GitHub release status and stable manifests. Website dispatch confirms a refresh request, not a completed website deployment. Verify the deployed download page separately.

Local `update-downloads.jsonl` now includes policy selection, channel, policy revision, platform and upgrade attempts. An installer returning success means `installer_returned`; only the target version plus a ready sidecar means `confirmed`. Reopening the old version records `not_completed`; a target boot without readiness after 60 seconds records `pending` and can later become confirmed. `report-routing.mjs` retains the latest result per attempt and summarizes failure stages, including slow-source abandonment (`slow_download`) and final `download_failed` events with received bytes. Attempt identifiers are random per attempt and are unrelated to the installation cohort identifier. No feedback is uploaded.

```sh
node --test scripts/releases/update-control.test.mjs
node scripts/releases/verify-update-control-defects.mjs
cargo test --manifest-path desktop/src-tauri/Cargo.toml update_routing --lib
python3 desktop/scripts/verify-update-rust-defects.py 'install policy bypass'
node scripts/releases/report-routing.mjs /path/to/update-downloads.jsonl
```

These tests cover mocked/native boundaries and local HTTP services. They do not certify a real Windows/macOS package upgrade or public mirror deployment.
