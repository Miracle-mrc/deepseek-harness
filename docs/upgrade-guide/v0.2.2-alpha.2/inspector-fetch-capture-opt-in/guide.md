---
kind: upgrade-guide
description: "The Developer tools bundle no longer captures Host requests automatically."
---

# Host fetch capture requires explicit opt-in

English | [中文](guide.zh.md)

## Change

The Developer tools bundle now sets `captureFetch: false`. The inspectors and Statistics view remain enabled. Profiles using the bundle no longer record Host request headers or bodies unless their own patch explicitly enables capture. Existing explicit overrides are preserved.

## Migration

1. Keep capture off when connecting AWS, Supabase, or any real account. Unredacted capture can include access tokens and refresh tokens.
2. If your profile's `cordis.patch.yml` already sets `captureFetch: true` on `experimental-inspector`, remove that override or set it to `false`. Restart the Host and confirm that new Host fetch traffic is absent from the inspector's Network panel.
3. Enable capture only for controlled debugging with disposable test credentials. The debugger still allows local code execution with capture off; disable Developer tools on shared or untrusted machines. See the [Inspector security restrictions](../../../../packages/experimental/inspector/README.md#security).
