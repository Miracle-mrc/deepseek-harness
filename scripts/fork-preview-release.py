#!/usr/bin/env python3
"""Validate fork preview sources and assemble a checked, credential-free bundle."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import runpy
import shutil
import subprocess
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = "Miracle-mrc/deepseek-harness"
RELEASE = runpy.run_path(str(ROOT / "scripts" / "build-python-release.py"))
DESKTOP_TARGETS = {"win-x64": "exe", "mac-arm64": "dmg", "mac-x64": "dmg"}
REQUIRED_CHECKS = {"all checks passed", "windows checks passed", "python checks passed"}


def command(arguments: list[str], root: Path = ROOT) -> str:
    """Return a checked subprocess's stdout; failures stop dependent operations."""
    return subprocess.run(arguments, cwd=root, check=True, text=True, capture_output=True).stdout.strip()


def api(path: str) -> list[dict[str, Any]]:
    """Read all GitHub API pages with the caller's existing read token."""
    pages = json.loads(command(["gh", "api", "--paginate", "--slurp", path]))
    if not isinstance(pages, list):
        raise ValueError("GitHub API did not return paginated JSON")
    return pages


def validate_tag(tag: str, product_version: str) -> None:
    """Require a separate, positive-numbered fork candidate at the product version."""
    if re.fullmatch(rf"fork-v{re.escape(product_version)}-miracle\.[1-9][0-9]*", tag) is None:
        raise ValueError(f"source tag must be fork-v{product_version}-miracle.<positive integer>")


def require_source_checks(commit: str, run_id: str) -> None:
    """Require the latest master push validation and any present required PR verdicts.

    Optional checks and this dispatch's jobs do not supply source evidence.
    A failed rerun supersedes an older successful attempt.
    """
    runs = [
        run
        for page in api(f"repos/{REPOSITORY}/actions/workflows/ci-master.yml/runs?head_sha={commit}&event=push&branch=master&per_page=100")
        for run in page["workflow_runs"]
        if run["head_sha"] == commit
        and run["event"] == "push"
        and run["head_branch"] == "master"
        and run["head_repository"]["full_name"] == REPOSITORY
    ]
    if not runs:
        raise ValueError("source commit needs a successful CI master push run in the fork")
    latest = max(runs, key=lambda run: (run["run_number"], run["run_attempt"]))
    if latest["status"] != "completed" or latest["conclusion"] != "success":
        raise ValueError("latest CI master push run for the source commit must succeed")
    checks = [
        check
        for page in api(f"repos/{REPOSITORY}/commits/{commit}/check-runs?filter=latest&per_page=100")
        for check in page["check_runs"]
        if check["name"] in REQUIRED_CHECKS
        and check["app"]["slug"] == "github-actions"
        and f"/actions/runs/{run_id}/" not in (check.get("details_url") or "")
    ]
    for check in checks:
        if check["status"] != "completed" or check["conclusion"] != "success":
            raise ValueError(f"source check {check['name']!r} must succeed")


def require_merged_pr_checks(root: Path, commit: str) -> None:
    """Link master source to the exact tested content of its merged pull request."""
    pulls = [
        pull
        for page in api(f"repos/{REPOSITORY}/commits/{commit}/pulls?per_page=100")
        for pull in page
        if pull["merged_at"] is not None
        and pull["merge_commit_sha"] == commit
        and pull["base"]["ref"] == "master"
        and pull["base"]["repo"]["full_name"] == REPOSITORY
    ]
    if len(pulls) != 1:
        raise ValueError("source commit must identify exactly one merged pull request into fork master")
    pull = pulls[0]
    head = pull["head"]["sha"]
    if re.fullmatch(r"[0-9a-f]{40}", head) is None:
        raise ValueError("associated pull request has an invalid head commit")
    try:
        command(["git", "cat-file", "-e", f"{head}^{{commit}}"], root)
    except subprocess.CalledProcessError:
        command(["git", "fetch", "--no-tags", "origin", head], root)
    source_tree = command(["git", "rev-parse", f"{commit}^{{tree}}"], root)
    head_tree = command(["git", "rev-parse", f"{head}^{{tree}}"], root)
    if source_tree != head_tree:
        raise ValueError("source tree differs from the tested pull request head; synchronize the PR with master before merging")
    for workflow in ("ci.yml", "ci-windows.yml", "ci-python.yml"):
        runs = [
            run
            for page in api(f"repos/{REPOSITORY}/actions/workflows/{workflow}/runs?head_sha={head}&event=pull_request&per_page=100")
            for run in page["workflow_runs"]
            if run["head_sha"] == head
            and run["event"] == "pull_request"
            and run["path"] == f".github/workflows/{workflow}"
            and run["repository"]["full_name"] == REPOSITORY
            and run["head_repository"]["full_name"] == pull["head"]["repo"]["full_name"]
        ]
        if not runs:
            raise ValueError(f"associated pull request needs a successful {workflow} run on its final head")
        latest = max(runs, key=lambda run: (run["run_number"], run["run_attempt"]))
        if latest["status"] != "completed" or latest["conclusion"] != "success":
            raise ValueError(f"latest associated pull request {workflow} run must succeed")


def resolve_source(
    root: Path,
    repository: str,
    workflow_ref: str,
    tag: str,
    run_id: str,
    expected_commit: str | None = None,
    expected_tag_object: str | None = None,
) -> dict[str, str]:
    """Resolve an existing tag reachable from master and reject moved candidates."""
    if repository != REPOSITORY or workflow_ref != "refs/heads/master":
        raise ValueError("fork releases must be dispatched from master in Miracle-mrc/deepseek-harness")
    if re.fullmatch(r"fork-v[0-9][0-9A-Za-z.-]*-miracle\.[1-9][0-9]*", tag) is None:
        raise ValueError("source tag must use the fork-v<productVersion>-miracle.<N> format")
    tag_object = command(["git", "rev-parse", "--verify", f"refs/tags/{tag}"], root)
    commit = command(["git", "rev-parse", "--verify", f"refs/tags/{tag}^{{commit}}"], root)
    remote = command(["git", "ls-remote", "--exit-code", "--refs", "origin", f"refs/tags/{tag}"], root).split()
    if remote != [tag_object, f"refs/tags/{tag}"]:
        raise ValueError("remote source tag changed; use a new candidate tag")
    if expected_commit is not None and commit != expected_commit:
        raise ValueError("source tag moved to a different commit; use a new candidate tag")
    if expected_tag_object is not None and tag_object != expected_tag_object:
        raise ValueError("source tag object changed; use a new candidate tag")
    try:
        command(["git", "merge-base", "--is-ancestor", commit, "origin/master"], root)
    except subprocess.CalledProcessError as error:
        raise ValueError("source tag commit must be reachable from the current fork master") from error
    product_version = json.loads(command(["git", "show", f"{commit}:package.json"], root))["version"]
    validate_tag(tag, product_version)
    wheel_version = RELEASE["pep440_version"](product_version)
    require_source_checks(commit, run_id)
    require_merged_pr_checks(root, commit)
    existing = [release for page in api(f"repos/{REPOSITORY}/releases?per_page=100") for release in page if release["tag_name"] == tag]
    if existing:
        raise ValueError("candidate already has a release; use a new candidate tag")
    return {"commit": commit, "tag-object": tag_object, "product-version": product_version, "wheel-version": wheel_version}


def expected_assets(product_version: str) -> dict[str, tuple[str, str | None]]:
    """Return exactly three unsigned installers and the canonical six wheels."""
    version = RELEASE["pep440_version"](product_version)
    files: dict[str, tuple[str, str | None]] = {
        f"deepseek-harness-miracle-preview-{product_version}-{target}-unsigned.{extension}": ("desktop", target)
        for target, extension in DESKTOP_TARGETS.items()
    }
    files[f"deepseek_harness_sdk-{version}-py3-none-any.whl"] = ("sdk", None)
    for platform, (wheel_tag, _executable) in RELEASE["PLATFORMS"].items():
        files[f"deepseek_harness_runtime_bin-{version}-py3-none-{wheel_tag}.whl"] = ("runtime", platform)
    return files


def collect_desktop(root: Path, target: str, output: Path) -> None:
    """Copy the target's single unsigned installer, leaving update files behind."""
    product_version = RELEASE["repository_version"](root)
    extension = DESKTOP_TARGETS[target]
    name = f"deepseek-harness-miracle-preview-{product_version}-{target}-unsigned.{extension}"
    source = root / "apps" / "desktop" / ".desktop-build" / "targets" / target / "unsigned-artifacts" / name
    if source.is_symlink() or not source.is_file() or source.stat().st_size == 0:
        raise ValueError(f"verified unsigned installer is missing or empty: {source}")
    output.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, output / name)


def verify_assets(directory: Path, product_version: str, extra: set[str]) -> list[dict[str, Any]]:
    """Validate the complete asset set and each wheel's canonical metadata."""
    expected = expected_assets(product_version)
    actual = {file.name for file in directory.iterdir()}
    if actual != set(expected) | extra:
        raise ValueError(f"preview asset set differs: missing={sorted((set(expected) | extra) - actual)}, unexpected={sorted(actual - set(expected) - extra)}")
    for name in extra:
        file = directory / name
        if file.is_symlink() or not file.is_file() or file.stat().st_size == 0:
            raise ValueError(f"preview metadata must be a nonempty regular file: {name}")
    records: list[dict[str, Any]] = []
    for name, (kind, platform) in sorted(expected.items()):
        file = directory / name
        if file.is_symlink() or not file.is_file() or file.stat().st_size == 0:
            raise ValueError(f"preview asset must be a nonempty regular file: {name}")
        if kind != "desktop":
            if file.stat().st_size >= 100_000_000:
                raise ValueError(f"preview wheel exceeds the canonical release size limit: {name}")
            version = RELEASE["pep440_version"](product_version)
            RELEASE["verify_wheel"](file, kind, version, None if platform is None else RELEASE["PLATFORMS"][platform])
        records.append({"name": name, "size": file.stat().st_size, "sha256": digest(file)})
    return records


def digest(file: Path) -> str:
    """Hash large native installers without loading them into memory."""
    with file.open("rb") as stream:
        value = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
        return value.hexdigest()


def manifest_data(product_version: str, commit: str, tag: str, files: list[dict[str, Any]]) -> dict[str, Any]:
    """Describe the exact candidate without changing product or wheel versions."""
    if re.fullmatch(r"[0-9a-f]{40}", commit) is None:
        raise ValueError("preview source commit must be a full lowercase Git commit identifier")
    if tag:
        validate_tag(tag, product_version)
    return {
        "formatVersion": 1,
        "repository": REPOSITORY,
        "tag": tag or None,
        "commit": commit,
        "productVersion": product_version,
        "wheelVersion": RELEASE["pep440_version"](product_version),
        "files": files,
    }


def build_metadata(root: Path, expected_commit: str, tag: str) -> dict[str, str]:
    """Require every build checkout to match its caller's resolved source commit."""
    commit = command(["git", "rev-parse", "HEAD"], root)
    if commit != expected_commit:
        raise ValueError("build checkout does not match the resolved source commit")
    product_version = RELEASE["repository_version"](root)
    if tag:
        validate_tag(tag, product_version)
    return {"commit": commit, "product-version": product_version, "wheel-version": RELEASE["pep440_version"](product_version)}


def checksum_text(directory: Path, names: list[str]) -> str:
    """Create the deterministic checksum list, including the manifest itself."""
    return "".join(f"{digest(directory / name)}  {name}\n" for name in sorted(names))


def bundle(source: Path, output: Path, product_version: str, commit: str, tag: str) -> None:
    """Assemble only validated assets and attach their manifest and checksums."""
    files = verify_assets(source, product_version, set())
    manifest = manifest_data(product_version, commit, tag, files)
    output.mkdir(parents=True, exist_ok=False)
    for record in files:
        shutil.copy2(source / record["name"], output / record["name"])
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    names = [record["name"] for record in files] + ["manifest.json"]
    (output / "SHA256SUMS").write_text(checksum_text(output, names))


def verify_bundle(directory: Path, product_version: str, commit: str, tag: str) -> None:
    """Reject changed, missing, duplicate, or additional release assets."""
    files = verify_assets(directory, product_version, {"manifest.json", "SHA256SUMS"})
    expected = manifest_data(product_version, commit, tag, files)
    if json.loads((directory / "manifest.json").read_text()) != expected:
        raise ValueError("preview manifest does not match the validated candidate assets")
    names = [record["name"] for record in files] + ["manifest.json"]
    if (directory / "SHA256SUMS").read_text() != checksum_text(directory, names):
        raise ValueError("preview SHA256SUMS does not match the candidate assets and manifest")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="operation", required=True)
    commands.add_parser("source")
    commands.add_parser("metadata")
    desktop = commands.add_parser("collect-desktop")
    desktop.add_argument("--target", choices=tuple(DESKTOP_TARGETS), required=True)
    desktop.add_argument("--output-dir", type=Path, default=Path("dist-fork-desktop"))
    for operation in ("bundle", "verify-bundle"):
        build = commands.add_parser(operation)
        build.add_argument("--input-dir", type=Path, required=True)
        if operation == "bundle":
            build.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    if args.operation in ("source", "metadata"):
        if args.operation == "source":
            values = resolve_source(
                ROOT, os.environ["GITHUB_REPOSITORY"], os.environ["GITHUB_REF"],
                os.environ["FORK_PREVIEW_SOURCE_TAG"], os.environ["GITHUB_RUN_ID"],
                os.environ.get("FORK_PREVIEW_EXPECTED_COMMIT"), os.environ.get("FORK_PREVIEW_EXPECTED_TAG_OBJECT"),
            )
        else:
            values = build_metadata(ROOT, os.environ["FORK_PREVIEW_EXPECTED_COMMIT"], os.environ.get("FORK_PREVIEW_SOURCE_TAG", ""))
        with Path(os.environ["GITHUB_OUTPUT"]).open("a") as output:
            for key, value in values.items():
                output.write(f"{key}={value}\n")
        print(json.dumps(values))
    elif args.operation == "collect-desktop":
        collect_desktop(ROOT, args.target, args.output_dir)
    else:
        product_version = os.environ["FORK_PREVIEW_PRODUCT_VERSION"]
        commit = os.environ["FORK_PREVIEW_COMMIT"]
        tag = os.environ.get("FORK_PREVIEW_SOURCE_TAG", "")
        if args.operation == "bundle":
            bundle(args.input_dir, args.output_dir, product_version, commit, tag)
        else:
            verify_bundle(args.input_dir, product_version, commit, tag)


if __name__ == "__main__":
    main()
