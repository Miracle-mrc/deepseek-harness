---
description: "AWS CLI and Supabase browser sign-in for Web, Desktop, and terminal consumers, with shared local grants and explicit MCP tool consent."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-cloud-connectors

English | [中文](README.zh.md)

## Summary

Connect AWS and Supabase from Web, Desktop, or the terminal, then choose which offered MCP tools an agent may use. AWS uses a named AWS CLI profile on the Harness Host; Supabase uses browser OAuth. Sign-in never enables tools by itself. Connections and tool selections are shared by profiles using the same Harness home.

## Table of Contents

- [Use this package](#use-this-package)
- [Security boundary](#security-boundary)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Use the [cloud connectors bundle](../cloud-connectors-bundle/README.md) for the Web or Desktop Plugins page, or run the dedicated [`dsh cloud` commands](../cloud-connectors-cli/README.md). Fresh Desktop profiles include the bundle; Web and existing Desktop profiles can opt in. The package does not sign in to either provider when no grant is saved.

### Connect and select tools

Open Plugins, find AWS or Supabase, and select **Connect**. Complete the provider-specific steps below. When discovery finishes, review the offered tools: the page checks all tools initially, but registers none until you select **Enable selected tools**. Deselect tools you want to withhold. **Change tool permissions** lets you replace the selection later, including disabling every tool while retaining sign-in.

### AWS prerequisites and sign-in

Install the latest [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) on the computer running the Harness Host. The integration rejects versions older than 2.32.0 and also requires the [`signin create-oauth2-token-with-iam` command](https://docs.aws.amazon.com/cli/latest/reference/signin/create-oauth2-token-with-iam.html). An older v2 build can therefore still need an update. Select the AWS MCP region, CLI profile, and sign-in method. The default profile is `dsh-cloud`; using a dedicated profile keeps this login separate from other CLI work.

| Method | Behavior |
|---|---|
| `login` | Runs `aws login --remote` for the named profile. Open the displayed AWS URL, then paste the browser's private authorization response into the dedicated input. Replacing a saved AWS login requires an explicit yes/no answer. |
| `sso` | Runs `aws sso login --use-device-code --no-browser` against a profile already configured for IAM Identity Center. Enter the public verification code in the browser. |
| `existing` | Reuses the named profile's current credentials without opening a sign-in page. |

Browser `login` needs the permissions required by [AWS CLI browser sign-in](https://docs.aws.amazon.com/signin/latest/userguide/command-line-sign-in.html). All methods need `signin:CreateOAuth2Token` for MCP token creation and the AWS MCP and AWS API permissions for the requested operations. Tool selection does not grant them. If sign-in or token creation fails, update the CLI and ask the AWS administrator to check that identity and profile. AWS keeps the profile's underlying credentials in its own files; Harness stores the MCP grant and tool selection.

### Supabase sign-in

Supabase connects to the fixed hosted endpoint `https://mcp.supabase.com/mcp`. The [hosted MCP flow](https://supabase.com/docs/guides/ai-tools/mcp) uses dynamic client registration, PKCE with S256, and state validation. This client requests `client_secret_basic`; the authorization server returns the client registration and secret dynamically. You do not configure a shared application secret or paste a personal access token. Stored registration secrets, access tokens, and refresh tokens remain on the Host.

### Remote Web and SSH hosts

The browser may run on another computer. AWS `login` uses the private browser response described above; SSO uses its public device code. Supabase normally returns to a one-time `127.0.0.1` callback on the Host. If your browser cannot reach that callback, copy the complete failed callback URL from its address bar into **Browser callback URL (optional)**. The Host validates its origin, path, and state, accepts it once, and preserves the issuer for the OAuth exchange. Never put an authorization response or callback URL into agent chat or command arguments.

The terminal uses hidden input for private responses; [`--secret-stdin`](../cloud-connectors-cli/README.md#use-this-package) enables explicit non-terminal input. Cancel sign-in to stop that attempt without disconnecting another caller's saved connection. If cancellation leaves a saved login without a live connection, the card offers **Try again**; cloud tools remain unavailable until connection succeeds, and an unconfirmed selection still requires approval. These flows do not expose a public callback relay.

### Credentials and disconnect

Profiles and browser tabs using the same Host and Harness home share grants and consent. **Disconnect this device**, or `dsh cloud disconnect <provider>`, deletes that home's saved grant and selection. Later calls in another profile recheck the stored grant and fail after disconnection, account replacement, or permission removal. An operation already sent to the provider cannot be undone. Disconnect does not run `aws logout`, erase the AWS CLI profile/cache, or revoke a provider token; manage those separately with the provider.

Supabase refresh holds the shared credential-store lock across token exchange so Hosts cannot independently consume the same refresh token. AWS obtains MCP tokens through its named CLI profile. An invalid or revoked login withdraws tools and requires sign-in again; transient failures do not discard consent.

### Custom composition

This package mounts as a plugin; the [bundle](../cloud-connectors-bundle/README.md) owns profile installation. A custom composition must provide `credentials`, `authorization`, and `tools` before mounting it:

```yaml
- id: cloud-connectors
  name: '@deepseek-ai/dsh-experimental-cloud-connectors'
```

| Field | Default | Meaning |
|---|---|---|
| `awsProfile` | `dsh-cloud` | Named AWS CLI profile when the caller does not choose one. |
| `awsMethod` | `login` | AWS sign-in method when the caller does not choose one. |
| `awsExecutable` | `aws` | Trusted AWS CLI executable on the Host. |
| `restoreOnStart` | `true` | Rediscover saved connections at startup; the dedicated CLI profile disables this. |

The [configuration catalog](../../../docs/config-catalog.md) owns the complete field and timeout reference. Headless disables credentials and authorization by default; a custom agent profile must explicitly enable those services as well as this plugin.

<a id="security-boundary"></a>
## Security boundary

These controls select whole MCP tools; provider authorization still limits what each tool can do.

- Generic AWS API tools can perform IAM operations permitted by the selected identity. The checkboxes do not restrict individual AWS API actions.
- Supabase `execute_sql` can read and write data and change schemas. Disabling `apply_migration` does not prohibit those schema changes. Management SQL may have privileges beyond application RLS; this connection uses the account-wide hosted endpoint.
- Harness approval policy remains separate from tool selection. Enabling a tool does not promise an additional provider-side confirmation for each operation.
- The local credential store does not isolate credentials from another process running as the same OS user. Do not enable Developer tools `captureFetch` while authorizing: it records unredacted OAuth requests and tokens. The debugger permits local code execution.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [Host service](src/index.ts) owns authorization attempts, credential reconciliation, MCP discovery, and reversible tool registrations. The [Web client](src/client/CloudConnectionCard.tsx) and [terminal application](../cloud-connectors-cli/README.md) consume the same operations. Public state carries status, offered tool descriptions, permitted names, safe failure categories, and attempt/prompt identities; it excludes stored tokens and client secrets. Private responses return only to their matching live prompt.

The [AWS CLI adapter](src/aws-cli.ts) runs fixed argument lists without a shell and obtains MCP-scoped bearer tokens. The [Supabase OAuth provider](src/oauth-provider.ts) uses SDK discovery, dynamic registration, and refresh. The [endpoint catalog](src/catalog.ts) fixes the two provider URLs and supported AWS regions; callers cannot substitute another endpoint. The [MCP subsystem reference](../../../docs/subsystems/mcp.md#ctxcloudconnections--cloudconnections) owns the generated service-method reference.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Cloud connectors bundle](../cloud-connectors-bundle/README.md): Web and Desktop activation.
- [Cloud terminal commands](../cloud-connectors-cli/README.md): login, status, tool selection, and disconnect.
- [Local credentials](../../credentials/credentials-local/README.md): storage ownership and same-user access.
- [AWS CLI login](https://docs.aws.amazon.com/cli/latest/reference/login/index.html) and [Supabase MCP](https://supabase.com/docs/guides/ai-tools/mcp): provider requirements.

-----

<a id="model-experience"></a>
## Model Experience

### Approved cloud tools

#### What the model sees

An unconfirmed connection registers no cloud tools. After confirmation, selected tools use the `mcp__<provider>__<tool>` namespace with provider-supplied descriptions and schemas. The package adds no system prompt and sends no authorization responses, stored tokens, or registration secrets to the model.

#### Token effect

Enabled tool schemas and returned results contribute tokens through the existing MCP adapter. The package promises no fixed token overhead.

#### KV Cache effect

Changing the permitted tool set can change the tool-schema prefix of later requests. The package does not rewrite prior messages.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Provider and platform acceptance has these limits:

- Live AWS and Supabase login, registration, refresh, and cloud operations remain unverified. The person connecting a real account owns that manual acceptance; automated coverage uses external provider stubs and a keyless recorded Session.
- Desktop packaging supports macOS and Windows. A native Linux Desktop installer and live browser sign-in across operating systems are not verified by the mocked flows.
- Newly offered tools require reconnecting to discover and review the updated list. Startup restoration can wait for MCP negotiation or its timeout, but never enables an unconfirmed selection.
- Invalid preview credentials without the required sign-in identity or registered callback are not restored; reconnect to create a validated grant.
- The MCP client does not advertise form or URL elicitation. Provider-side destructive-SQL confirmation or Edge Function secret dialogs cannot be assumed.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
