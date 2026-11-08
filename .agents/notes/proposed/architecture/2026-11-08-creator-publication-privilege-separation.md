# Agent Note: Creator publication privilege separation

Status: proposed

English | [中文](2026-11-08-creator-publication-privilege-separation.zh.md)

## Problem

Creator's per-file checks and final confirmation protect the first-party Client workflow. They do not prove human authorization to the Host: owner Remote callers and trusted in-process plugins can call `publish(id, true)`. An untrusted process that can read the Host's usable GitHub credentials can also publish without CreatorFork.

The shipped [sandbox vocabulary](../../../../packages/sandbox/sandbox/src/index.ts) controls file effects. Linux profiles permit root reads, macOS allows operations other than the selected file writes, and Windows documents unconfined reads and network. The [filesystem provider](../../../../packages/fs/fs-sandbox/README.md) also preserves reads. Environment scrubbing therefore cannot isolate credential files, helpers, agents, keyrings or authenticated IPC. A second same-user process alone does not establish isolation.

A second path uses the durable browser-session signing record. Its holder can sign an authority-bound browser cookie; [Connection](../../../../packages/client/connection/src/rpc-host.ts) admits that cookie as an owner Peer. That caller can obtain its own immutable source receipt and attest confirmation without running the Client controller. Host/Origin checks and cookie signatures still work as designed; they do not distinguish the person from a process possessing the same authority. Real exploitation additionally requires a reachable Host and usable GitHub account and fork; those prerequisites have not been tested against a live account.

The current [approval seam](../../implemented/feature/2026-07-06-approval-seam.md) and [Windows file-write policy](../../implemented/feature/2026-08-08-windows-acl-restricted-token-sandbox.md) retain their existing responsibilities. This proposal neither supersedes them nor claims their current guarantees include credential isolation. The [credential snapshot and registration decision](../../implemented/architecture/2026-07-30-credential-boundaries-and-atomic-registration.md) also remains active; its deferred keychain provider cannot by itself supply the exclusion required here.

## Proposal

Do not extend the Phase 2 sandbox implementation until the owner approves a separate privilege-separation design. Preserve local download and the current explicitly documented trusted-Host publication workflow; keep the stronger isolation requirement blocked.

The minimum viable design places an audited publication broker and its owner confirmation channel outside every untrusted model capability's filesystem, process, keyring, IPC, network and UI-automation authority. A remote execution world or dedicated OS security identity can supply that separation; an ordinary same-user helper cannot. The broker may reuse the existing GitHub login only through an owner-authorized credential migration or protected credential mediator. It must never return reusable credentials to the executor.

### Trusted and untrusted code

The broker, confirmation renderer and explicitly installed Host plugins belong to the trusted computing base. Model-generated programs, Bash/pwsh/PTY descendants, PTC programs and arbitrary native MCP servers require an isolated execution world. Model filesystem/search tools must use that world's provider too. Every additional tool needs an audited capability policy; changing only shell execution leaves alternate readers and network clients.

Model-writable source, configuration, hooks and plugin directories must not silently become broker or trusted renderer code through HMR, dependency installation or later execution. Promotion to trusted Host code requires separate owner authorization. A deployment that lets model-controlled computer/browser tools operate the approval UI cannot claim that those controls prove human confirmation.

### Receipt-bound authorization

The broker retains immutable source bytes and a canonical manifest binding their digest to account ID, repository/network IDs, destination paths, branch, actual default branch, base/head OIDs, expiry and operation ID. The trusted owner channel displays that same retained receipt and records explicit individual review and final authorization. A caller boolean or a token readable by the executor is insufficient.

Publication consumes a narrow authorization for exactly that operation after fresh identity and head checks. Concurrent calls coalesce; retries reconcile the same operation and its known remote effects rather than minting approval again or treating replay as a second save. Changed source, destination, account or receipt requires new review. Durable journal recovery must preserve committed and unknown effects without persisting credentials or source in ordinary logs.

### Required implementation changes

Implement the broker credential/receipt/journal owner and a typed, least-privilege protocol; add an owner confirmation transport inaccessible to model tools; route source capture and GitHub mutations through that owner. Replace or constrain all model execution and file providers, raw network access, browser/computer automation and native extension routes. Prevent access to owner cookies and trusted executable/configuration paths, including alternate file names, inherited handles, process inspection and keyring/agent endpoints. Unsupported platforms or missing isolation must refuse the stronger mode.

Linux, macOS and Windows need separate native enforcement and adversarial evidence. Existing filesystem/subprocess seams can carry providers, but the shipped providers and SSH combinations do not establish this complete Web/Desktop guarantee. Credential migration, remote workspace capture, plugin development and AWS/Supabase integrations need explicit compatibility plans rather than broader ambient grants.

## Alternatives considered

**Environment sanitization or hiding common gh paths.** File-based credentials, configurable stores, helpers, keyrings, owner cookies and inherited channels remain alternative authority sources. A name blacklist cannot establish the requested exclusion.

**A nonce, more checkboxes or generic owner-RPC approval.** A process holding owner authority can submit the same inputs or answer the same approval channel. Only a separately protected owner channel can supply the required authorization.

**A same-user broker with a narrow RPC API.** This reduces accidental misuse but does not prevent file/process/IPC credential reuse by an adversarial executor. It is useful only after an enforced isolation layer protects it.

**Disable every generic model capability while publication credentials exist.** A separately audited allowlist deployment can reduce the trusted execution set, but it removes normal Creator development and tool behavior. It is not a compatible silent change to existing profiles, and a UI switch does not revoke credentials or already-running processes.

## Acceptance criteria

- Run dummy-credential adversarial tests through every shipped model execution and filesystem route on Linux, macOS and Windows. Secret reads, helper/keyring/IPC reuse, owner-cookie acquisition and authenticated writes outside the broker must be rejected.
- Reject forged, expired, altered or replayed authorization; account, receipt, source and destination changes; unauthorized approval replies; and approval through model-driven UI automation. Include positive authorized publication and intentional invalid controls.
- Preserve exact reviewed bytes, default/fork checks, head-CAS conflicts, idempotent retry, timeout/lost-response recovery and partial-effect reporting. Do not promise atomic protection of GitHub default metadata.
- Verify restart recovery, lifecycle cleanup and no secret-bearing logs, export data, tool results or errors. Run the complete relevant regression and packaging matrix without weaker gates.
- Complete the [manually authorized disposable-fork acceptance](../../../../docs/cookbook/testing-creator-fork.md) after the security design is implemented. Fixture success alone does not close live compatibility.

## Risks

This is a substantial security architecture change, not implemented behavior. OS accounts, containers or remote executors add provisioning, filesystem-transfer and packaging costs. Remote owner approval changes deployment and offline behavior; hardware-backed user presence may be necessary when UI automation remains available. Additional typed mediators can restrict legitimate Git, plugin and cloud workflows. Trusted malicious Host/plugin code, compromised OS administrators and credentials the owner deliberately supplies to untrusted code remain outside the proposed guarantee and must be stated explicitly.

No test in Phase 2 establishes the new cross-platform exclusion. Preserve the security blocker and require an explicit architecture decision before implementation.
