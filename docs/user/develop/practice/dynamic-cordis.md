# Configure persistent plugins from a prompt

English | [中文](dynamic-cordis.zh.md)

Standard and Creator modes provide [Plugin Manager](../../../../packages/boot/plugin-manager/README.md); Creator mode adds read-only [runtime inspection](../../../../packages/extensions/tool-cordis/README.md). Plugin configuration belongs to the current profile, affects its sessions, and survives process restarts.

## Connect an MCP server

Start the Web profile and select Creator mode. With a reachable Streamable HTTP MCP server that exposes `ping`, send this prompt using its actual endpoint:

> Configure the MCP server at `<endpoint>` in this profile as `demo`. Make its tools available now, then call its ping tool and tell me the result.

The agent writes a configuration-only bundle whose patch inserts `@deepseek-ai/dsh-mcp-client`, then installs it with `plugin_manager install_bundle`. With HMR enabled, the tools appear in the same running session. Verify both the management result (`application: applied`) and a successful `mcp__demo__ping` call. A saved entry with `restart-required` has not activated yet; a failed entry needs configuration repair.

Read the bundle patch before editing its configuration. Use Plugin Manager to disable entries or remove the bundle. See the [MCP client reference](../../../../packages/mcp/mcp-client/README.md) for accepted configuration and connection failure behavior.

## Save to My Fork

Open **Plugins → Add plugin → Save to My Fork** when Creator is available. Enter your GitHub repository as `owner/repository` and a destination branch other than `master` or `main`. These are export labels: DSH does not verify repository access, create branches, commit, or push. Inspect the generated paths and contents, acknowledge the review requirement, then download the captured JSON export. Editing the target requires a new preview.

The export preserves the current profile's ordered bundle selection and profile patch. Supported local bundles include their source files, Cordis patches, and text assets; registry dependencies remain package references. This covers plugin configurations, custom plugins, MCP definitions, and UI extensions implemented as bundles. It excludes credentials, sessions, home and invocation overlays, and transient dynamic Cordis experiments. Unsupported or suspicious files block preparation; correct them and retry. Secret detection is conservative and cannot establish that arbitrary source is safe to publish: review every file before staging it.

From your fork checkout, materialize the downloaded export into a new directory:

```sh
node scripts/prepare-creator-export.ts /path/to/download.json /path/to/new-customizations
```

The extractor validates every path and refuses an existing destination, including one from an earlier extraction. It runs no Git commands. Keep the generated source files in a dedicated directory in your fork, inspect `git diff`, create the branch you chose, and stage only those files. Check that the Git remote names your fork before committing or pushing. Authentication failures belong to your local Git/GitHub setup; the export itself needs no GitHub token.

To restore on another machine, clone your fork and complete the [source checkout setup](../../../development.md#setup-tutorial), including a build. Review the exported plugins before executing them. Install dependencies and run any required build scripts in the exported local bundle directories, then install the profile dependencies from `profiles/saved`. Launch through the normal CLI with the exported directory as the Harness home:

Before launching, set the `DSH_HOME` environment variable to the exported directory. In a POSIX shell use `export DSH_HOME=/path/to/new-customizations`; in PowerShell use `$env:DSH_HOME="C:\path\to\new-customizations"`.

```sh
pnpm --dir /path/to/new-customizations/profiles/saved install
pnpm dsh --profile saved
```

Keep `profiles/saved` and `bundles` together so relative local dependencies resolve. Use a fresh, private Harness home for each restored installation; configure credentials separately and reconnect AWS, Supabase, and authenticated MCP servers through their existing workflows. Confirm that the expected bundles and tools load before using them. No authorization or runtime Team state transfers with this export.

Automatic repository discovery, GitHub authorization, branch creation, commits, pushes, pull requests, and arbitrary application edits are deferred. Phase 1 prepares source files for your own Git review and publication.
