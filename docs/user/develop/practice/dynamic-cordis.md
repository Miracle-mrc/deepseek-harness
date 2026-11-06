# Configure persistent plugins from a prompt

English | [中文](dynamic-cordis.zh.md)

Standard and Creator modes provide [Plugin Manager](../../../../packages/boot/plugin-manager/README.md); Creator mode adds read-only [runtime inspection](../../../../packages/extensions/tool-cordis/README.md). Plugin configuration belongs to the current profile, affects its sessions, and survives process restarts.

## Connect an MCP server

Start the Web profile and select Creator mode. With a reachable Streamable HTTP MCP server that exposes `ping`, send this prompt using its actual endpoint:

> Configure the MCP server at `<endpoint>` in this profile as `demo`. Make its tools available now, then call its ping tool and tell me the result.

The agent writes a configuration-only bundle whose patch inserts `@deepseek-ai/dsh-mcp-client`, then installs it with `plugin_manager install_bundle`. With HMR enabled, the tools appear in the same running session. Verify both the management result (`application: applied`) and a successful `mcp__demo__ping` call. A saved entry with `restart-required` has not activated yet; a failed entry needs configuration repair.

Read the bundle patch before editing its configuration. Use Plugin Manager to disable entries or remove the bundle. See the [MCP client reference](../../../../packages/mcp/mcp-client/README.md) for accepted configuration and connection failure behavior.

## Save to My Fork

Open **Plugins → Add plugin → Save to My Fork** when Creator is available. The local source download remains available without a GitHub connection: enter destination labels, inspect the captured files, acknowledge your review, and download the JSON. To publish directly, choose **Save directly to GitHub**, then explicitly load the repositories available to the Host’s existing GitHub login. Opening either dialog makes no GitHub request.

Select a writable fork owned by the displayed GitHub account and enter a branch other than `main`, `master`, or the fork’s actual default branch. Check the account and PR destination `<selected-fork>:<default-branch>`; the displayed upstream verifies fork eligibility. Preview covers every resulting PR file change and every destination write below `creator-exports/saved/`. **Before** shows the reviewed default commit, **After** shows captured source, and **Current branch before this save** shows different branch text a write will replace. Review the full paths and exact text, opening escaped whitespace when needed. Existing destinations with unrelated changes or incompatible history are refused; the [Host publication reference](../../../../packages/boot/plugin-manager/README.md#direct-github-publication) explains checks, trusted Host authority, public visibility, stale default exports, signing and publication limits.

Search paths or page through the list and select a file to inspect it. Check **I checked this file for private information** separately for every file. **Next unreviewed file**, search and paging never approve a file; filtering never changes the publication file set. **Files reviewed: N/M** must reach M/M before the separate final acknowledgement and **Confirm and open PR** become available. Revoking an individual check clears final authorization; target edits or a new receipt reset all checks. Closing and reopening an unsubmitted review preserves individual checks but clears final authorization. Confirmation creates or reuses the reviewed commit and PR, without merging. If the fork is public, publication can expose source and reachable history before a PR is merged; file review does not cover historical commit contents. Prefer a fresh branch, avoid concurrent branch or default-setting changes, and review the final PR on GitHub before further action.

For a long review, explicitly extend the review time. The Host rechecks the same retained receipt and unchanged GitHub destination, then refreshes the configured review period, which defaults to 15 minutes. An expired receipt can still be extended before reclamation. Exact text, selection and file checks remain; give final authorization again. Extension does not recapture local files or upload source. Pending or attempted saves keep their existing retry flow.

Authentication uses the Host’s existing `gh` credential store. Repair access for the original displayed account and fork before explicitly retrying the same save. Unknown or unresolved committed effects retain the approved receipt and lock new saves; a failed retry cannot erase a known commit. If the receipt is lost, inspect the original account, fork, branch and PR on GitHub and finish manually before another save. Reclaimed receipts and Host restart require a new preview and full review without transferred or automatic approval. Use local download for offline review and manual publication when extension is unavailable.

If a matching PR was closed or merged, review the linked request on GitHub; this save will not create a replacement. You can edit the destination or preview a new save, or retry the existing request after manually reopening it. Unknown writes keep editing and new previews locked until reconciliation.

The export preserves the current profile's ordered bundle selection and profile patch. Supported local bundles include their source files, Cordis patches, and text assets; registry dependencies remain package references. This covers plugin configurations, custom plugins, MCP definitions, and UI extensions implemented as bundles. It excludes credentials, sessions, home and invocation overlays, and transient dynamic Cordis experiments. Unsupported or suspicious files block preparation; correct them and retry. Secret detection is conservative and cannot establish that arbitrary source is safe to publish: review every file before staging it.

From your fork checkout, materialize the downloaded export into a new directory:

```sh
node scripts/prepare-creator-export.ts /path/to/download.json /path/to/new-customizations
```

The extractor validates every path and refuses an existing destination, including one from an earlier extraction. It runs no Git commands. Keep the generated source files in a dedicated directory in your fork. Create the branch you chose, inspect the files, then stage only those files and review `git diff --cached`. Check that the Git remote names your fork before committing or pushing. Authentication failures belong to your local Git/GitHub setup; the export itself needs no GitHub token.

To restore on another machine, clone your fork and complete the [source checkout setup](../../../development.md#setup-tutorial), including a build. Exported source is untrusted. First run `pnpm install --ignore-scripts` in each exported local bundle directory, then install the profile dependencies with scripts disabled:

```sh
pnpm --dir /path/to/new-customizations/profiles/saved install --ignore-scripts
```

Inspect lifecycle scripts in both the exported packages and their installed dependencies before approving any build. In each affected bundle or profile directory, record only reviewed dependency identities in pnpm's `allowBuilds` policy, using `pnpm approve-builds` for pending builds; approval can run scripts immediately. After reviewing the package's own install hooks too, explicitly run `pnpm rebuild` and any required plugin build commands. Rebuilding can execute project lifecycle scripts as well as approved dependency scripts. Initial script-free installation does not establish that plugin code is safe to execute. Launch through the normal CLI only after this review:

Before launching, set the `DSH_HOME` environment variable to the exported directory. In a POSIX shell use `export DSH_HOME=/path/to/new-customizations`; in PowerShell use `$env:DSH_HOME="C:\path\to\new-customizations"`.

```sh
pnpm dsh --profile saved
```

Keep `profiles/saved` and `bundles` together so relative local dependencies resolve. Use a fresh, private Harness home for each restored installation; configure credentials separately and reconnect AWS, Supabase, and authenticated MCP servers through their existing workflows. Confirm that the expected bundles and tools load before using them. No authorization or runtime Team state transfers with this export.

Direct saves use the same source capture and restoration layout as local downloads. For a directly saved copy, use `creator-exports/saved/` as the exported Harness home. Arbitrary application edits, credential transfer, and automatic merging are outside this flow.
