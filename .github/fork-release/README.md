---
description: "Build unsigned Desktop and Python previews in the Miracle-mrc fork, validate their source and local wheels, and prepare a draft GitHub prerelease."
---

# Fork preview releases

English | [中文](README.zh.md)

## Summary

The Miracle-mrc fork builds unsigned Windows x64 and macOS Intel/Apple Silicon installers together with the Python SDK and five native runtime wheels. Relevant pull requests run a packaging smoke. A manual release run from `master` rebuilds a checked candidate tag and uploads eleven files to a draft prerelease in this fork.

## Table of Contents

- [Scope and verification](#scope-and-verification)
- [Pull request previews](#pull-request-previews)
- [Candidate sources](#candidate-sources)
- [Prepare a draft prerelease](#prepare-a-draft-prerelease)
- [Artifacts and recovery](#artifacts-and-recovery)
- [Dev Note](#dev-note)

<a id="scope-and-verification"></a>
## Scope and verification

This reference applies only to `Miracle-mrc/deepseek-harness`. The fork workflows use GitHub-hosted runners and require no repository publishing secrets. They do not publish packages to npm or PyPI, upload to COS, or invoke upstream Desktop publication. AWS and Supabase deployment remain outside this release path.

Desktop packaging uses the normal unsigned packaging commands with `--fork-preview`. The preview identity separates the app from the canonical Desktop distribution, and the preview omits automatic-update metadata and mandatory-policy configuration. The installers carry no production signing or macOS notarization. Windows SmartScreen and macOS Gatekeeper warnings are expected.

GitHub Actions owns native build and installed-runtime verification. Local workflow and helper tests validate source rules, bundle contents and failure handling; they do not establish Windows/macOS installation or signed-release readiness.

<a id="pull-request-previews"></a>
## Pull request previews

The [packaging smoke workflow](../workflows/fork-preview.yml) runs for Desktop, CLI, Python, native, release, build-workflow and dependency-lock changes listed in its path filter. Unrelated documentation and package-source edits do not start the eight native packaging targets. Ordinary technical CI remains separate.

The [shared builder](../workflows/fork-preview-build.yml) produces these installers on native public runners:

| Installer | Runner | Mode |
|---|---|---|
| Windows x64 EXE | `windows-2025` | Unsigned |
| macOS Apple Silicon DMG | `macos-latest` | Unsigned |
| macOS Intel DMG | `macos-15-intel` | Unsigned |

The existing [Python native builder](../workflows/build-exe-for-python-sdk.yml) builds one SDK wheel and runtime wheels for Linux x64/ARM64, macOS ARM64/x64 and Windows x64 with `release: true` and `ci: false`. No secrets are passed. Each native target installs its local SDK and matching runtime wheel with `--no-index` after preparing the SDK's declared external dependency. The shared workflow also runs the installed SDK on Python 3.10 and 3.14, checks all six wheels with Twine and the canonical wheel validator, and rejects any incomplete bundle.

Successful PR runs retain `fork-preview-bundle` for seven days. Its manifest records the exact checked commit, with a null candidate tag. A failed or skipped required build prevents the final preview verdict from succeeding.

<a id="candidate-sources"></a>
## Candidate sources

A release candidate uses a pre-existing tag named `fork-v<productVersion>-miracle.<N>`, where `<N>` is a positive integer. The product version comes from the tagged root `package.json`; the Python wheel version keeps its canonical PEP 440 spelling. Candidate numbering changes the tag, never the product or Python package versions.

The [source validator](../../scripts/fork-preview-release.py) requires the tag commit to be reachable from current fork `master` and to identify exactly one merged PR into that branch. The tagged source tree must equal that PR's final head tree. Synchronize the PR with master and obtain successful technical checks before merging; a merge that introduces different content cannot be released through this path.

The latest `pull_request` runs of `ci.yml`, `ci-windows.yml` and `ci-python.yml` must succeed on that final PR head, using the expected workflow paths and repositories. The latest `ci-master.yml` push run must also succeed on the exact tagged commit. A newer failed or unfinished attempt blocks release. The current release dispatch and unrelated optional checks do not supply source evidence.

Candidate tags are immutable by operating policy. Use repository tag protection to restrict their modification, and create a new number for a new candidate. The workflow compares the remote tag object with its local object, records the resolved commit and tag object before building, and checks both again before creating the draft. It refuses any candidate that already has a release, including a draft.

<a id="prepare-a-draft-prerelease"></a>
## Prepare a draft prerelease

Repository operators perform the tag and Actions steps; native builds and GitHub publication require a real Actions run and are not exercised by local helper tests.

1. Merge a PR containing the fork preview support, with the final checked PR head synchronized to master. Wait for its master push validation to succeed.
2. Create a new candidate tag on that checked master commit using the required format. Keep the tagged commit and tag object unchanged.
3. Open **Actions → Fork draft release → Run workflow**, select the `master` branch, and enter the candidate in `source_tag`. Selecting another workflow branch or repository cannot enter the build path.
4. Wait for source validation, three unsigned Desktop builds, five native Python builds, Python compatibility checks and bundle validation. Only the final publication job receives `contents: write`.
5. Inspect the resulting draft prerelease in this fork, its manifest, checksums and installer behavior before deciding whether to publish it. The workflow leaves the release in draft state and marks it as a prerelease.

<a id="artifacts-and-recovery"></a>
## Artifacts and recovery

The draft uploads exactly three installers, six wheels, `manifest.json` and `SHA256SUMS`. Installer filenames include `miracle-preview`, the product version, native target and `unsigned`. Python wheel filenames and distribution names remain canonical; install the candidate SDK and matching runtime from the same bundle.

The manifest identifies the repository, tag, commit, product version and wheel version, and records every asset's size and SHA256. `SHA256SUMS` covers all nine binaries and the manifest. The final job downloads the validated bundle and rechecks its exact filenames, wheel metadata, identity and hashes before uploading.

Source failures stop before native builds. Build or compatibility failures prevent bundle publication; failed Desktop jobs retain packaging diagnostics for seven days. Resolve missing or failed technical checks before rerunning. A source-tree mismatch requires a newly synchronized and checked PR; moving an existing candidate tag is not a recovery path.

If a draft already exists, inspect and retain that candidate instead of attempting an overwrite. Use a new candidate number for a rebuilt release. Product-version reuse across candidate tags is intentional, so the manifest and checksums distinguish their bytes.

<a id="dev-note"></a>
## Dev Note

None.
