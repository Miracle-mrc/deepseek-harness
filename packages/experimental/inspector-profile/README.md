---
description: "Optional Web profile layer for raw Session logs and Chat node inspection."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-inspector-profile

English | [中文](README.zh.md)

## Summary

Enable this bundle to inspect Session data in the Sidebar, open NodeJS inspector in the bottom panel, and add the Statistics conversation tab. It enables both inspectors and the Statistics view but leaves Host fetch capture off. The bundle is optional in Web profiles and included in newly initialized Desktop profiles.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Open **Plugins**, select **More** beside **Experimental plugins**, and enable **Developer tools**; once on, it also appears on the main list. This selects `@deepseek-ai/dsh-experimental-inspector-profile` for the current Web profile.

The **Statistics** tab beside Chat and Trajectory shows per-turn and per-step context, timing, cache, and tool cost; see the [performance view package](../client-ui-stats/README.md). Open **Session log** from the Sidebar's new-tab menu or guide. [Session Inspector](../session-inspector/README.md) provides one view with selectable Raw log and Chat group presentations; Raw log is selected initially.

Press **Ctrl/Cmd+Shift+.** to open or collapse **NodeJS inspector** in the bottom panel with the packaged DevTools frontend. Enabling this bundle starts the local debugging backend without a debugging argument. Unredacted Host fetch capture requires an explicit `captureFetch: true` override.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`cordis.patch.yml`](cordis.patch.yml) enables Session Inspector, the Statistics conversation view, and the NodeJS inspector backend with `captureFetch: false`, independently of debugging flags. See the Inspector [README](../inspector/README.md) for debugging and capture behavior. Each plugin owns its behavior and lifetime.

</details>

-----

<a id="model-experience"></a>
## Model Experience

None, as this bundle mounts developer inspection plugins without contributing model context.

#### KV Cache effect

None; the bundle adds no request content.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Web only** — the inspection views require the Web application's Session services.
- **Internal diagnostics** — the component switch remains available, but there is no dedicated Web debugging button. Activation permits local code execution even when fetch capture is off; see the [security restrictions](../inspector/README.md#security).

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
