---
kind: upgrade-guide
description: "Host fetch capture is disabled by default in the Inspector plugin, library API, and Developer tools bundle."
---

# Host fetch capture requires explicit opt-in

English | [中文](guide.zh.md)

## Change

The Inspector plugin, its library API, and the Developer tools bundle now default `captureFetch` to `false`. The inspectors and Statistics view remain available, but Host request headers and bodies are no longer recorded automatically. A config override that changes only the port also leaves capture off. Existing explicit `captureFetch: true` overrides are preserved.

## Migration

1. Keep capture off when using real account credentials. Unredacted capture can include access tokens, cookies, and request or response bodies.
2. If your profile's `cordis.patch.yml`, home patch, or overlay sets `captureFetch: true` on `experimental-inspector`, remove that field or set it to `false`. Direct plugin and library callers should also omit it or set it to `false`. Restart the Host and confirm that new Host fetch traffic is absent from the Inspector's Network panel.
3. For controlled debugging with disposable test credentials, explicitly set `captureFetch: true`; remove the opt-in when finished. The debugger still allows local code execution with capture off, so disable Developer tools on shared or untrusted machines. See the [Inspector security restrictions](../../../../packages/experimental/inspector/README.md#security).
