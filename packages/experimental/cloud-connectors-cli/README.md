---
description: "Terminal commands for AWS and Supabase sign-in, connection status, explicit MCP tool permissions, and local disconnect."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-cloud-connectors-cli

English | [中文](README.zh.md)

## Summary

Manage AWS and Supabase connections from a terminal by enabling this optional bundle in a dedicated `cloud` profile. It shares saved grants and tool selections with Web and Desktop profiles using the same Harness home. It starts no model or Agent and writes no Session log. Login and tool permission changes remain separate commands.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Create the custom `cloud` profile and enable the bundle carried by the installation once, without downloading or publishing a package:

```sh
dsh plugin --profile cloud enable --empty @deepseek-ai/dsh-experimental-cloud-connectors-cli
```

This complete application declares `dsh.bundle.standalone: true` and must be the profile's only selected bundle. It cannot share a bundle stack with base, Web, or Desktop. `--empty` initializes a missing custom profile without default bundles; it preserves an existing profile and rejects conflicting bundle selections before writing them. Use a new custom profile if `cloud` already selects other bundles. Ordinary profile, home, and `--patch` overlays remain allowed. Run its commands through the normal launcher:

```sh
dsh cloud --help
dsh cloud login --help
dsh cloud login supabase
dsh cloud login aws --aws-profile dsh-cloud --aws-method login --region us-east-1
dsh cloud status
dsh cloud tools supabase
dsh cloud tools supabase --enable execute_sql,apply_migration
dsh cloud tools aws --all
dsh cloud tools aws --none
dsh cloud disconnect supabase
```

`login` prints the provider's browser URL and any public verification code, then waits for completion. AWS defaults to the named `dsh-cloud` profile, `login` method, and `us-east-1` MCP region. Select `--aws-method sso` for a preconfigured IAM Identity Center profile or `--aws-method existing` to reuse current profile credentials without browser sign-in. Install the latest AWS CLI v2 on the Host; the minimum accepted version is 2.32.0, and the MCP token command must be available. The [cloud connection reference](../cloud-connectors/README.md#use-this-package) owns provider prerequisites and the remote-browser flow.

When AWS `login` asks for its private browser response, paste it into the hidden terminal input. Supabase can complete its Host loopback callback automatically; for a remote Host or SSH session, paste the complete failed callback URL when prompted. Replacing a saved AWS CLI login requires an explicit yes/no answer. These responses never belong in command arguments or agent chat.

For non-terminal responses, add `--secret-stdin` to `login` and supply one response per LF- or CRLF-terminated line through a private standard-input stream. Without that option, non-terminal AWS sign-in fails when it requires a private response or replacement confirmation; Supabase can continue waiting for its browser callback. The CLI prints no private responses or provider error bodies. EOF while a response is requested, interruption, or failed input cancels and drains only this command's admitted attempt.

`tools` without options lists raw MCP tool names and their enabled state. `--enable` replaces the selection with exactly the named tools; `--all` enables every currently offered tool; `--none` disables every tool while retaining sign-in. These options are mutually exclusive. Login does not confirm tool permissions. Provider permissions still limit every enabled tool.

`status` accepts an optional `aws` or `supabase` argument. Help makes no cloud requests; `status` and `tools` may contact providers while restoring saved connections. `disconnect` deletes the saved grant in this Harness home; it does not run `aws logout` or revoke provider credentials. Select another home with the launcher's normal `DSH_HOME` setting when connections must be separate.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [bundle patch](cordis.patch.yml) owns the complete terminal application: argument handling, credentials, authorization, a tool registry, and the [shared cloud service](../cloud-connectors/README.md). It mounts no model, Agent, Session persistence, or persistent application server. `restoreOnStart: false` keeps help independent of provider I/O; commands restore only the provider they need.

The [argument parser](src/args.ts) uses `dsh-cmdline`; the [command runner](src/run.ts) waits for committed application startup and requests shutdown through `appExit`. It drains owned cancellation before releasing terminal state and process listeners. `pollIntervalMs` sets the pending-login status-read interval, with a default of 500 milliseconds; provider deadlines belong to the cloud service.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Cloud connections](../cloud-connectors/README.md): authentication, credential storage, consent, and provider limits.
- [Web and Desktop bundle](../cloud-connectors-bundle/README.md): using the same connections from the Plugins page.
- [Command-line application support](../../boot/cmdline/README.md): profile argument parsing and shutdown.

-----

<a id="model-experience"></a>
## Model Experience

### Terminal connection commands

#### What the model sees

This profile starts no model. Saved tool permissions affect later model requests in profiles that mount `cloudConnections` and use the same Harness home; the [cloud service](../cloud-connectors/README.md#model-experience) owns those effects.

#### Token effect

The CLI contributes no model tokens. Enabled cloud tool schemas and results consume tokens in the profile that uses them.

#### KV Cache effect

The CLI adds no model context. Changing permitted tools can change later tool-schema prefixes in another profile.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Terminal connection management has these limits:

- Live provider login, token refresh, and cloud operations remain manual acceptance checks for the account user. Automated tests use external stubs, including private-input and cancellation cases.
- Linux has keyless built-CLI acceptance coverage. Native macOS and Windows CLI, Web, and Desktop sign-in still require manual acceptance; the mocked flows do not verify browser or account behavior on those platforms.
- A browser on another machine needs the cloud service's private response or manual callback support; this CLI creates no public callback relay.
- The local credential provider cannot isolate saved credentials from another process running as the same OS user.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
