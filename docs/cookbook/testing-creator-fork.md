---
description: "Verify Creator fork publication with fixtures and an explicitly authorized disposable GitHub target."
---

# Cookbook: testing Creator fork publication

English | [中文](testing-creator-fork.zh.md)

## Summary

Use this procedure to separate deterministic fixture evidence from real GitHub acceptance. A maintainer first runs the existing tests; a human then authorizes a named disposable fork and checks publication through the normal Creator UI. No live target is authorized by this guide. Credential isolation remains an unresolved requirement: the current Host accepts caller attestation, and tools with Host credentials can publish outside the UI. The [privilege-separation proposal](../../.agents/notes/proposed/architecture/2026-11-08-creator-publication-privilege-separation.md) is not implemented.

## Table of Contents

- [1. Record the authorization](#authorization)
- [2. Run deterministic fixtures](#fixtures)
- [3. Prepare the dedicated Host and baseline](#baseline)
- [4. Review without publishing](#review)
- [5. Publish and update the approved branch](#publish)
- [6. Check conflicts and recovery](#recovery)
- [7. Check auth, rules and signatures](#policies)
- [8. Review merge safeguards separately](#governance)
- [9. Record the result](#result)
- [Dev Note](#dev-note)

-----

<a id="authorization"></a>
## 1. Record the authorization

Stop live actions until the decision owner approves the security assumptions for this bounded exercise or requires privilege separation first. A dedicated account alone does not fix the isolation gap. Never use this product repository or its upstream as a disposable write target.

Record the operator, dedicated account, disposable upstream and personal fork, their numeric IDs, allowed branch names, public fixture source, permitted Git-object/ref/PR writes, time window and cleanup owner. Authorize fault injection and second-actor changes separately. Repository creation, policy/default changes, account switching, branch deletion, force pushes and merging are not implied by permission to publish a test PR. Leave unapproved actions unexecuted.

<a id="fixtures"></a>
## 2. Run deterministic fixtures

From a contributor checkout with dependencies installed, run the Host and controller/component tests:

```sh
pnpm exec vitest run packages/boot/plugin-manager/tests/creator-fork.spec.ts packages/boot/plugin-manager/tests/fork-github.spec.ts
pnpm exec vitest run packages/client/ui-agent-preset/tests/fork-publish.client.spec.tsx packages/client/ui-agent-preset/tests/fork-publish-store.client.spec.ts
```

After the current complete build and Chromium/WebKit prerequisites, run the assembled browser fixture:

```sh
DSH_SNAPSHOT=replay pnpm run test:web:built apps/web/tests/creator-source-export.e2e.ts
```

These tests simulate GitHub; they do not establish real login, signing, ruleset compatibility or model credential isolation. The [Host tests](../../packages/boot/plugin-manager/tests/creator-fork.spec.ts) cover new/existing branches, actual default names, immutable receipts, full PR diffs, ownership, races and lost responses. The [transport tests](../../packages/boot/plugin-manager/tests/fork-github.spec.ts) check sanitized API/policy failures. The [Client tests](../../packages/client/ui-agent-preset/tests/fork-publish.client.spec.tsx) and browser fixture cover explicit per-file review, privacy warnings, renewal and recovery. Preserve their negative controls and quality thresholds.

<a id="baseline"></a>
## 3. Prepare the dedicated Host and baseline

Use only disposable public source in a dedicated profile; include a small Unicode/BOM/CRLF sample. Review its complete captured file set and any retained branch history. Start through a supported named `dsh` profile, with an operator-reviewed patch setting Plugin Manager's `fork.upstreamRepository` to the authorized disposable network. Record the profile and patch; invocation overlays are not exported. Use the normal GitHub CLI transport, without credentials in configuration, source or command arguments.

The human prepares the Host's existing GitHub CLI login using its [normal login flow](https://cli.github.com/manual/gh_auth_login), if that action is authorized. The product has no browser token-entry flow. Never print tokens, device codes, authenticated launch URLs or raw CLI diagnostics. Do not log out a shared account, expose token storage or broaden scopes to bypass a refusal. CLI storage can fall back to a plaintext file; login does not prove isolation.

Before the first mutation, record account/repository/network identities, the fork's actual default name/OID, the upstream default name/OID, destination absence/head, and applicable rules/signature requirements. Choose a unique absent branch other than `main`, `master`, `HEAD` or the fork's actual default. Keep the default setting and both default heads stable during ordinary acceptance.

<a id="review"></a>
## 4. Review without publishing

Open **Plugins → Add plugin → Save to My Fork → Save directly to GitHub**. Opening must cause no GitHub request. Explicitly load repositories, verify the displayed account, and select only the authorized owned writable fork. If it is absent, stop. Preview must perform reads only: no uploaded source, Git-object creation, ref change or PR creation.

Check the PR destination is the selected fork's actual default branch. Inspect every full path and exact Before/After value. Before comes from the reviewed default commit; optional Current branch before this save shows target text a write replaces. The required file set includes all resulting PR changes and restoration-only writes. Read the public-source/history warning: the preview does not review all private information in historical commits.

With multiple files, verify 0/M and 1/M cannot enable final confirmation. Search, paging, selection and Next unreviewed file must not mark files. Check each file individually, then give the separate final acknowledgement. Unchecking a file or editing the destination must revoke final authorization; destination edits require a new complete review.

For a long unsubmitted review, close/reopen and explicitly extend it. Retain the same receipt, bytes, selection and individual checks; clear final consent. Extension performs revalidation reads only. Expired retained receipts may extend; reclaimed/unloaded receipts require a new preview and full review. Attempted saves use their existing recovery flow. These Client behaviors are not proof that arbitrary owner callers received human authorization.

<a id="publish"></a>
## 5. Publish and update the approved branch

After reviewing every file and granting final consent, confirm once. Independently inspect GitHub: the new non-default branch has the reviewed parent/tree and exact UTF-8 bytes; one PR has both head/base repositories in the authorized fork and targets its reviewed actual default. Leave it unmerged. Check default names/OIDs, upstream OID and unrelated files against the baseline. Source can already be public before PR creation succeeds.

For the existing-branch case, select the branch and still-open PR just created, and modify an existing public fixture file. Prepare a fresh preview of that export-only descendant. Review the full default-relative diff and every target write again, including earlier export text. Confirm the PR is reused; an already-correct eligible head needs no empty commit. Unrelated leaf changes, behind/diverged histories and extra reserved export files must block preview. Do not delete or rewrite them automatically; the [publication reference](../../packages/boot/plugin-manager/README.md#direct-github-publication) describes when manual Git publication is required.

<a id="recovery"></a>
## 6. Check conflicts and recovery

Only with separately authorized second-actor writes, move an existing target after preview and confirm the stale receipt. Verify refusal/reconciliation preserves that actor's head. For an absent target, create it between preview and confirmation and verify exclusive creation does not overwrite it. Keep default-setting/head drift fixture-only unless those changes were separately authorized. Head CAS does not protect default metadata; assume the default setting remains stable and inspect the final PR.

Under an approved transport-fault plan, interrupt a response after explicit confirmation. Do not assume remote effects are absent. Preserve the Host/browser state, inspect the original branch/PR, restore access for the same account, then retry the same save. Verify exact bytes/destination, one attached save commit and its matching PR, without recapture or duplicate branch/PR results. A lost response can require repeated REST object preparation; unreachable objects are not duplicate attached saves. Known commits must remain known after later failures.

Unresolved effects must keep target edits and new saves locked. If a separately authorized dedicated-Host restart loses the receipt, inspect the original account/fork/branch/PR and finish manually before another save; do not transfer old review marks to a new receipt. Do not terminate a shared Host or session to induce this case. Cleanup requires its own authorization.

<a id="policies"></a>
## 7. Check auth, rules and signatures

Use a dedicated unauthenticated/unauthorized fixture or separately authorized test account/policy. Verify sanitized refusals, retained effects and no automatic credential broadening or protection bypass. A 403/422 is not a unique diagnosis of signing failure; inspect the actual repository rules.

Test new-ref and existing-branch publication separately. REST commit preparation supplies no signature; GraphQL signing remains conditional. Inspect actual verification status and [signature requirements](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-signed-commits). If unsupported, stop and use an approved manual signed-Git workflow. Do not fabricate signatures or weaken rules.

A failure reporting no branch/PR effect does not prove no source upload: REST preparation can leave unreachable objects. Record none/unknown/committed effects and inspect GitHub before recovery. Public history and partial publication remain privacy concerns even if a later operation fails.

<a id="governance"></a>
## 8. Review merge safeguards separately

Read the current default-branch summary, active/effective rules, formal approvals and exact-head checks. A protection-detail 403 means inaccessible details, not a 404 or proof of absent protection. Independent agent reviews and Auto Review are not submitted GitHub approvals. Record unavailable metadata rather than requesting broader administration scope.

After owner approval, consider one active rule for the existing default: independent approval of the latest push, stale-approval dismissal, resolved conversations, an up-to-date base, blocked force pushes/deletion, and no broad administrator/App bypass. Keep auto-merge disabled. Candidate PR aggregate contexts are `all checks passed`, `windows checks passed` and `python checks passed`, with their verified GitHub Actions source. Their cancellation guards can skip the aggregate; GitHub can accept a skipped required context. Before using aggregates alone, verify cancellation behavior and choose stable required child checks or a separately approved fail-closed verdict design. Until then, manually require actual success of every relevant lane on the final SHA. Check-source pinning does not make PR-authored workflows trustworthy.

Do not globally require `preview / fork preview checks passed` while its [trigger](../../.github/workflows/fork-preview.yml) is path-filtered. For a PR that triggers packaging, require its actual final-head packaging evidence, including supported Desktop and native platforms. Making it universally required needs a separately approved always-reported check design. GitHub documents [filtered required checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks#handling-skipped-but-required-checks); skipped policy jobs are not executed acceptance tests.

Have the owner inspect the installed upstream-sync App's real identity, branch, permissions, mode and bypass settings. A connector's own installation metadata does not establish another App's configuration. Prefer reviewed side-branch/PR synchronization preserving fork commits; direct default writes conflict with PR-only protection. Do not grant broad or PR-only bypass as though checks remained enforced. Any sync change needs separate approval. Keep the default branch and upstream relationship unchanged; do not enable destructive reset or forced synchronization.

Do not enable a merge queue as a Settings-only change: current core workflows need trigger and event-guard work for queued checks. Apply approved safeguards only after checking ordinary PRs and the actual sync path; re-read active rules and approvals afterward. No Settings change or merge is authorized by this procedure.

<a id="result"></a>
## 9. Record the result

Record the authorizing decision, exact tested SHA/build/profile, dedicated account and repository/network IDs, approved branches/actions, baseline/final OIDs, receipt and explicit consent, effects, exact byte comparison, actual PR identities, rules/signature outcomes and UTC times. Use secret-free evidence; never include credentials, device codes, private source or authenticated URLs.

Mark every unexecuted live case NOT RUN. Fixture results do not close real API compatibility or the isolation blocker. Any acceptance decision must name its threat model and remaining limitations. Keep the PR open until the separate independent review and merge decision.

<a id="dev-note"></a>
## Dev Note

None.
