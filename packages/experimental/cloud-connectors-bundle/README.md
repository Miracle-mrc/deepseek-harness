---
description: "Opt-in AWS and Supabase connections for Web and Desktop profiles, with browser sign-in and explicit MCP tool selection."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-cloud-connectors-bundle

English | [中文](README.zh.md)

## Summary

Add AWS and Supabase connection cards to a Web or Desktop Plugins page. Fresh Desktop profiles already include this bundle; Web and existing Desktop profiles can add it explicitly. Installing the bundle signs in to neither provider. The [cloud connections plugin](../cloud-connectors/README.md) enables tools only after provider sign-in and explicit tool confirmation.

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

Use this layer in a profile that already supplies credentials, authorization, tools, and the Web Plugins page.

### Enable in a profile

Enable the bundle carried by the installation in the Web profile:

```sh
dsh plugin --profile web enable @deepseek-ai/dsh-experimental-cloud-connectors-bundle
```

This command preserves existing profile layers and selects the carried bundle without a registry download. Replace `web` with the intended Web-based profile name. Profile and home patches can still override the inserted row. Restart a profile with HMR disabled to apply a changed composition.

For a published package version, use the normal profile package command:

```sh
dsh plugin --profile web add @deepseek-ai/dsh-experimental-cloud-connectors-bundle
dsh plugin --profile web remove @deepseek-ai/dsh-experimental-cloud-connectors-bundle
```

`add` and `remove` run pnpm; installation requires the requested package version to exist in the configured registry. An unpublished fork cannot install its package by name through this path. Installation adds the dependency and activates its declared bundle patch.

Fresh Desktop profiles include the bundle automatically. Existing Desktop profiles are preserved: enable it through Desktop's Plugin Manager or manage a published package through its [bundled command](../../../apps/desktop/README.md#bundled-command-runtime), since the npm CLI cannot manage the reserved Desktop profile.

### Connect an account

Open Plugins and choose AWS or Supabase. Follow the [sign-in and consent instructions](../cloud-connectors/README.md#use-this-package), including AWS CLI prerequisites and remote browser responses. All offered tools start checked on the review page; none are registered until you confirm. The [terminal commands](../cloud-connectors-cli/README.md) manage the same Harness home without starting Web or Desktop.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [patch document](cordis.patch.yml) inserts the `cloud-connectors` Host row. The [owning plugin](../cloud-connectors/README.md) supplies its browser contribution and service behavior; this package adds no credentials or authorization policy. The manifest's `dsh.bundle.patch` declaration makes it an installable profile layer.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Cloud connections](../cloud-connectors/README.md): authentication, consent, and security limits.
- [Cloud terminal commands](../cloud-connectors-cli/README.md): the dedicated connection-management profile.
- [Profiles and bundles](../../../docs/architecture.md): layer ordering and overrides.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the [cloud connections plugin](../cloud-connectors/README.md#model-experience), which owns the approved MCP tools and their schemas.

#### KV Cache effect

The bundle adds no model context itself. Changing permitted tools can change later tool-schema prefixes through the owning plugin.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Activation has these limits:

- Installing or enabling this layer does not authenticate an account, grant provider permissions, or migrate credentials from another Harness home.
- The bundle expects the profile's credential, authorization, and tool services. Headless disables interactive credential services by default; custom compositions must enable them explicitly.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
