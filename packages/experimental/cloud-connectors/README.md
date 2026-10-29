---
description: "Optional AWS and Supabase MCP OAuth Host/client integration with explicit tool-level consent."
kind: "package"
---

# @deepseek-ai/dsh-experimental-cloud-connectors

English | [中文](README.zh.md)

## Summary

Provides two independently configured connections in the Plugins page: **AWS** and **Supabase**. Installing or enabling the package does **not** sign in to either service. Each connection begins in **Not connected** until the user presses **Connect** on the current device, completes browser sign-in, then confirms which offered MCP tools the agent may use.

## Use this package

The Desktop first-run profile includes the [cloud connectors bundle](../cloud-connectors-bundle/README.md). Open **Plugins → AWS** or **Plugins → Supabase**, select **Connect**, and complete provider sign-in in your browser. After the connection returns a list of MCP tools, all offered tools are **checked by default** on the confirmation page. Uncheck any tool you want to withhold, then press **Enable selected tools**. The agent only receives selected tools **after** this explicit confirmation.

Credentials, OAuth codes, refresh tokens and client registration details remain on the local Host, stored by the existing Harness credentials service. They are not included in the bundle, source code, UI payload, or Git repository. You must connect separately on every device and profile. **Disconnect this device** removes the local grant and model-visible tools; it does not revoke the remote provider token. Revoke that token separately at the provider when needed.

The provider list is fixed: AWS managed MCP server at `https://aws-mcp.<region>.api.aws/mcp` (select a supported region) or the official Supabase MCP server `https://mcp.supabase.com/mcp`. The Host validates both. Connections use MCP's OAuth 2.1 / browser flow with a one-time local loopback callback and state validation.

## Security boundary

- Checking all tools is **not** an AWS IAM policy grant and does **not** override Supabase project permissions/RLS. Provider authentication and access grants are handled by their own authorization pages.
- Enabling a tool makes it available to the agent. For write-capable tools, the agent may still need confirmation according to your Harness tool-approval policy. Review the available descriptions carefully.
- A failed authorization or unapproved client registration must fail closed. No API keys or credential blobs are committed to Git.
- The AWS-managed MCP endpoint may restrict OAuth dynamic client registration to clients approved by AWS. A fork of Harness is not automatically approved; if login is rejected, contact AWS for client registration approval.
- AWS and Supabase OAuth callbacks use `127.0.0.1` and a temporary random port. Browser on a different machine than the Host cannot complete a loopback callback without a supported redirect bridge. This initial implementation targets local Desktop use.

## Model Experience

Before confirmation, **zero** AWS/Supabase tools are model-visible. After confirmation, each selected tool is exposed using the existing `mcp__<provider>__<tool>` namespace. No other prompt injection or model context is added.

## Known limitations

- Browser sign-in depends on provider support for unregistered/public OAuth clients, or prior approval. Live AWS/Supabase login requires an actual account and has not been exercised by the unit tests.
- This contribution targets the Web Plugins page used by Desktop. It does not provide separate native macOS/Windows/Linux sign-in binaries; the TypeScript and loopback HTTP implementation is platform-independent.
- Tool discovery is read at connect time; newly added provider tools require reconnecting to review the updated consent list.
