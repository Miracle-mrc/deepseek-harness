---
description: "Desktop-shipped AWS and Supabase cloud connection bundle; no account signs in by default."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-cloud-connectors-bundle

English | [中文](README.zh.md)

## Summary

This optional profile patch includes the [AWS and Supabase cloud connections](../cloud-connectors/README.md) in a Desktop installation. Both connections remain **Not connected** until the user completes browser OAuth and confirms their chosen MCP tool permissions. All tools are checked by default **only on the review page**; no tools are enabled before human confirmation.

## Table of Contents

- [Use this package](#use-this-package)
- [Security boundary](#security-boundary)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

On a fresh Desktop profile the bundle is enabled automatically. Open Plugins and select AWS or Supabase to connect. A previously customized profile is preserved; users can add the bundle explicitly through the Plugin Manager.

<a id="security-boundary"></a>
## Security boundary

No OAuth token, AWS IAM policy, Supabase project permission, or provider login is distributed in this package. Each device must authenticate independently; see the [Host integration README](../cloud-connectors/README.md) for limits, revocation and AWS sign-in prerequisites.

<a id="model-experience"></a>
## Model Experience

Indirectly, through the [cloud connections plugin](../cloud-connectors/README.md), which registers only explicitly approved tools.

#### KV Cache effect

The bundle adds no model context itself; enabling tools can change subsequent tool-schema prefixes through the owning plugin.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Installing the bundle does not authenticate an account or migrate credentials from another device.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
