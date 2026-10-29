---
description: "Optional AWS and Supabase MCP OAuth Host/client integration with explicit tool-level consent."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-cloud-connectors

English | [中文](README.zh.md)

## Summary

Provides two independently configured connections in the Plugins page: **AWS** and **Supabase**. Installing or enabling the package does **not** sign in to either service. Each connection begins in **Not connected** until the user presses **Connect** on the current device, completes browser sign-in, then confirms which offered MCP tools the agent may use.

## Table of Contents

- [Use this package](#use-this-package)
- [Security boundary](#security-boundary)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

The Desktop first-run profile includes the [cloud connectors bundle](../cloud-connectors-bundle/README.md). Open **Plugins → AWS** or **Plugins → Supabase**, select **Connect**, and complete provider sign-in in your browser. After the connection returns a list of MCP tools, all offered tools are **checked by default** on the confirmation page. Uncheck any tool you want to withhold, then press **Enable selected tools**. The agent only receives selected tools **after** this explicit confirmation.

Credentials, OAuth codes, refresh tokens and client registration details remain on the local Host, stored by the existing Harness credentials service. They are not included in the bundle, source code, UI payload, or Git repository. Each device must connect separately; profiles using the same Harness home share saved grants and consent. **Disconnect this device** removes the saved local grant and this Host's model-visible tools; it does not revoke the remote provider token. Revoke that token separately at the provider when needed.

Every tool call checks the latest stored login and consent before admission. A disconnect, replacement login or removed permission in another profile prevents later calls; it cannot undo an operation already sent to the provider. Token refresh is serialized through the shared credential store so concurrent Hosts do not independently rotate the same refresh token. A revoked or invalid login withdraws this Host's tools and asks you to reconnect; transient request failures do not revoke consent.

The provider list is fixed: AWS managed MCP server at `https://aws-mcp.<region>.api.aws/mcp` (select a supported region) or the official Supabase MCP server `https://mcp.supabase.com/mcp`. The Host validates both. Connections use MCP's OAuth 2.1 / browser flow with a one-time local loopback callback and state validation.

<a id="security-boundary"></a>
## Security boundary

- Checking all tools does not grant AWS IAM or Supabase account permissions. The provider's authorization still limits operations. Supabase management SQL may have privileged database access; application RLS is not a substitute for restricting that access.
- Checkboxes allow or deny whole tools. Generic AWS API tools can perform IAM operations within the signed-in identity's permissions. Supabase `execute_sql` can read, write and change schemas; disabling `apply_migration` alone does not prohibit schema changes.
- Enabling a tool makes it available to the agent. For write-capable tools, the agent may still need confirmation according to your Harness tool-approval policy. Review the available descriptions carefully.
- A failed authorization or unapproved client registration must fail closed. No API keys or credential blobs are committed to Git.
- Developer tools leave Host fetch capture off by default. Enabling `captureFetch` records unredacted OAuth tokens and requests; do not enable it while using cloud credentials. The debugger still permits local code execution, so disable Developer tools on shared or untrusted machines.
- AWS documents localhost redirects but also limits dynamic client registration to approved agents. A localhost callback does not guarantee that a new client registration will be accepted; contact AWS support if registration is refused. Browser OAuth requires `signin:AuthorizeOAuth2Access` and `signin:CreateOAuth2Token` on the user's IAM identity; it does not add AWS permissions. This fork's live registration has not been verified.
- AWS and Supabase OAuth callbacks use `127.0.0.1` and a temporary random port. Browser on a different machine than the Host cannot complete a loopback callback without a supported redirect bridge. This initial implementation targets local Desktop use.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [bundle patch](../cloud-connectors-bundle/cordis.patch.yml) mounts the Host service. Its browser contribution adds separate provider cards. The Host owns OAuth callbacks, credential storage and the selected-tool registry; the browser receives only status, the sign-in URL and tool descriptions. The [endpoint catalog](src/catalog.ts) supplies the same supported AWS regions to Host validation and the localized selector.

The public Remote values are defined in [connection types](src/types.ts). `CloudConnectionView` contains the provider id, connection status, offered tool names/descriptions, selected tool names and an optional sanitized error. `CloudSignIn` contains the browser authorization URL. Neither value contains stored access tokens, refresh tokens or client-registration credentials. The [MCP subsystem reference](../../../docs/subsystems/mcp.md) owns the generated `ctx.cloudConnections` method catalog.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Credentials service](../../credentials/credentials/README.md): local credential ownership.
- [AWS OAuth access](https://docs.aws.amazon.com/signin/latest/userguide/aws-mcp-server.html): sign-in prerequisites and provider authorization.
- [Supabase MCP](https://supabase.com/docs/guides/ai-tools/mcp): offered capabilities and security guidance.

-----

<a id="model-experience"></a>
## Model Experience

### Approved cloud tools

#### What the model sees

Before confirmation, no cloud tools are registered. After confirmation, selected tools use the existing `mcp__<provider>__<tool>` namespace with provider-supplied descriptions and schemas. No additional system prompt is registered.

#### Token effect

Enabled tool schemas and returned results contribute tokens through the existing MCP tool adapter; no fixed token overhead is promised.

#### KV Cache effect

Changing the approved tool set can change the tool-schema prefix of subsequent model requests. The package does not rewrite prior messages.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Live AWS/Supabase registration, login and refresh require an actual account and remain manual acceptance checks for the person connecting that account. Automated tests use mocked provider responses, not real credentials.
- This contribution targets the Web Plugins page used by Desktop. The TypeScript and loopback HTTP implementation is platform-independent, but the existing Desktop packaging pipeline supports macOS and Windows only. A native Linux installer and three-platform browser sign-in acceptance remain unverified.
- Tool discovery is read at connect time; newly added provider tools require reconnecting to review the updated consent list.
- Credential records from an earlier preview without a sign-in identity and registered redirect URI are not restored; reconnect that account to create a validated grant.
- Startup rediscovers the offered tools for saved logins, including pending consent, without registering unconfirmed tools. Restoration waits for MCP negotiation or its SDK timeout; an expired login requires reconnecting.
- The MCP client does not advertise form or URL elicitation. Do not rely on provider-side destructive-SQL popups or Edge Function secret-entry dialogs; the local tool-approval policy remains separate.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
