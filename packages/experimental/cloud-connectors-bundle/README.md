---
description: "Desktop-shipped AWS and Supabase cloud connection bundle; no account signs in by default."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-cloud-connectors-bundle

English | [中文](README.zh.md)

## Summary

This optional profile patch includes the [AWS and Supabase cloud connections](../cloud-connectors/README.md) in a Desktop installation. Both connections remain **Not connected** until the user completes browser OAuth and confirms their chosen MCP tool permissions. All tools are checked by default **only on the review page**; no tools are enabled before human confirmation.

## Use this package

On a fresh Desktop profile the bundle is enabled automatically. Open Plugins and select AWS or Supabase to connect. A previously customized profile is preserved; users can add the bundle explicitly through the Plugin Manager.

## Security boundary

No OAuth token, AWS IAM policy, Supabase project permission, or provider login is distributed in this package. Each device must authenticate independently; see the [Host integration README](../cloud-connectors/README.md) for limits, revocation and the AWS client-registration prerequisite.

## Model Experience

No tools are contributed until explicit approval of a post-login tool list.
