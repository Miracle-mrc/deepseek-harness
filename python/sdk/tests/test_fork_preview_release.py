"""Exercise source authorization and exact fork preview artifact verification."""

from __future__ import annotations

import importlib.util
import json
import zipfile
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location("fork_preview_release", ROOT / "scripts/fork-preview-release.py")
assert SPEC is not None and SPEC.loader is not None
preview = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(preview)
VERSION = "1.2.3-alpha.2"
TAG = f"fork-v{VERSION}-miracle.1"
COMMIT = "a" * 40


def successful_run(**overrides: object) -> dict:
    return {
        "head_sha": COMMIT, "event": "push", "head_branch": "master",
        "head_repository": {"full_name": preview.REPOSITORY}, "run_number": 10,
        "run_attempt": 1, "status": "completed", "conclusion": "success", **overrides,
    }


@pytest.fixture
def api_pages(monkeypatch: pytest.MonkeyPatch) -> dict:
    pages = {
        "runs": [{"workflow_runs": [successful_run()]}], "checks": [{"check_runs": []}], "releases": [[]],
        "pulls": [[{
            "number": 99, "merged_at": "2026-10-30T00:00:00Z", "merge_commit_sha": COMMIT,
            "base": {"ref": "master", "repo": {"full_name": preview.REPOSITORY}},
            "head": {"sha": COMMIT, "repo": {"full_name": preview.REPOSITORY}},
        }]],
        "pruns": {workflow: [{"workflow_runs": [successful_run(
            event="pull_request", path=f".github/workflows/{workflow}",
            repository={"full_name": preview.REPOSITORY}, pull_requests=[],
        )]}] for workflow in ("ci.yml", "ci-windows.yml", "ci-python.yml")},
    }

    def fake_api(path: str) -> list:
        if "actions/workflows/ci-master.yml/runs?" in path:
            return pages["runs"]
        if "/check-runs?" in path:
            return pages["checks"]
        if "/releases?" in path:
            return pages["releases"]
        if "/pulls?" in path:
            return pages["pulls"]
        for workflow, runs in pages["pruns"].items():
            if f"/actions/workflows/{workflow}/runs?" in path:
                return runs
        raise AssertionError(f"unexpected API request: {path}")

    monkeypatch.setattr(preview, "api", fake_api)
    return pages


@pytest.fixture
def source(tmp_path: Path, api_pages: dict) -> tuple[Path, str]:
    preview.command(["git", "init", "-b", "master"], tmp_path)
    preview.command(["git", "config", "user.name", "Fork preview fixture"], tmp_path)
    preview.command(["git", "config", "user.email", "fixture@example.invalid"], tmp_path)
    (tmp_path / "package.json").write_text(json.dumps({"version": VERSION}) + "\n")
    preview.command(["git", "add", "package.json"], tmp_path)
    preview.command(["git", "commit", "-m", "Fixture product"], tmp_path)
    commit = preview.command(["git", "rev-parse", "HEAD"], tmp_path)
    preview.command(["git", "tag", TAG], tmp_path)
    preview.command(["git", "remote", "add", "origin", str(tmp_path)], tmp_path)
    preview.command(["git", "update-ref", "refs/remotes/origin/master", commit], tmp_path)
    api_pages["runs"] = [{"workflow_runs": [successful_run(head_sha=commit)]}]
    api_pages["pulls"][0][0]["merge_commit_sha"] = commit
    api_pages["pulls"][0][0]["head"]["sha"] = commit
    for runs in api_pages["pruns"].values():
        runs[0]["workflow_runs"][0]["head_sha"] = commit
    return tmp_path, commit


def test_source_preserves_canonical_product_and_wheel_versions(source: tuple[Path, str]) -> None:
    root, commit = source
    metadata = preview.resolve_source(root, preview.REPOSITORY, "refs/heads/master", TAG, "123")
    assert metadata == {"commit": commit, "tag-object": commit, "product-version": VERSION, "wheel-version": "1.2.3a2"}
    assert json.loads((root / "package.json").read_text())["version"] == VERSION
    assert preview.build_metadata(root, commit, TAG)["commit"] == commit
    with pytest.raises(ValueError, match="checkout does not match"):
        preview.build_metadata(root, COMMIT, TAG)


@pytest.mark.parametrize(("repository", "workflow_ref"), [
    ("deepseek-ai/deepseek-harness", "refs/heads/master"),
    ("another-owner/deepseek-harness", "refs/heads/master"),
    (preview.REPOSITORY, "refs/heads/feature"),
    (preview.REPOSITORY, f"refs/tags/{TAG}"),
])
def test_source_rejects_other_repositories_and_workflow_refs(source: tuple[Path, str], repository: str, workflow_ref: str) -> None:
    with pytest.raises(ValueError, match="dispatched from master"):
        preview.resolve_source(source[0], repository, workflow_ref, TAG, "123")


@pytest.mark.parametrize("tag", ["master", "refs/tags/hello", "../../master", f"fork-v{VERSION}-miracle.0", f"fork-v{VERSION}-miracle.1\n"])
def test_source_rejects_unscoped_tags(source: tuple[Path, str], tag: str) -> None:
    with pytest.raises(ValueError, match="source tag"):
        preview.resolve_source(source[0], preview.REPOSITORY, "refs/heads/master", tag, "123")


def test_source_requires_the_tag_product_version_and_master_ancestry(source: tuple[Path, str]) -> None:
    root, _commit = source
    wrong = "fork-v1.2.4-miracle.1"
    preview.command(["git", "tag", wrong], root)
    with pytest.raises(ValueError, match="source tag must be"):
        preview.resolve_source(root, preview.REPOSITORY, "refs/heads/master", wrong, "123")
    preview.command(["git", "checkout", "--orphan", "unmerged"], root)
    preview.command(["git", "commit", "-m", "Unmerged fixture"], root)
    preview.command(["git", "update-ref", f"refs/tags/{TAG}", "HEAD"], root)
    with pytest.raises(ValueError, match="reachable from the current fork master"):
        preview.resolve_source(root, preview.REPOSITORY, "refs/heads/master", TAG, "123")


def test_source_rejects_moved_candidate_refs_and_existing_releases(source: tuple[Path, str], api_pages: dict) -> None:
    root, commit = source
    with pytest.raises(ValueError, match="different commit"):
        preview.resolve_source(root, preview.REPOSITORY, "refs/heads/master", TAG, "123", COMMIT)
    with pytest.raises(ValueError, match="tag object changed"):
        preview.resolve_source(root, preview.REPOSITORY, "refs/heads/master", TAG, "123", commit, COMMIT)
    api_pages["releases"] = [[{"tag_name": TAG, "draft": True}]]
    with pytest.raises(ValueError, match="already has a release"):
        preview.resolve_source(root, preview.REPOSITORY, "refs/heads/master", TAG, "123")


def test_source_checks_use_latest_push_attempt_and_ignore_dispatch_success(api_pages: dict) -> None:
    api_pages["runs"] = [{"workflow_runs": [
        successful_run(),
        successful_run(run_attempt=2, conclusion="failure"),
        successful_run(event="workflow_dispatch", run_number=11),
    ]}]
    with pytest.raises(ValueError, match="latest CI master push"):
        preview.require_source_checks(COMMIT, "123")
    api_pages["runs"] = [{"workflow_runs": [successful_run(event="workflow_dispatch")]}]
    with pytest.raises(ValueError, match="needs a successful CI master push"):
        preview.require_source_checks(COMMIT, "123")


def test_source_checks_ignore_own_run_and_optional_pending_but_require_pr_verdicts(api_pages: dict) -> None:
    check = {"name": "all checks passed", "app": {"slug": "github-actions"}, "status": "in_progress", "conclusion": None}
    api_pages["checks"] = [{"check_runs": [
        {**check, "details_url": "https://github.com/example/repo/actions/runs/123/job/9"},
        {**check, "name": "unrelated optional check"},
    ]}]
    preview.require_source_checks(COMMIT, "123")
    api_pages["checks"][0]["check_runs"].append(check)
    with pytest.raises(ValueError, match="all checks passed.*must succeed"):
        preview.require_source_checks(COMMIT, "123")


def test_merged_pr_evidence_requires_association_and_equal_source_tree(source: tuple[Path, str], api_pages: dict) -> None:
    root, commit = source
    api_pages["pulls"][0][0]["merge_commit_sha"] = COMMIT
    with pytest.raises(ValueError, match="exactly one merged pull request"):
        preview.require_merged_pr_checks(root, commit)
    api_pages["pulls"][0][0]["merge_commit_sha"] = commit
    (root / "extra.txt").write_text("untested content\n")
    preview.command(["git", "add", "extra.txt"], root)
    preview.command(["git", "commit", "-m", "Different head tree"], root)
    api_pages["pulls"][0][0]["head"]["sha"] = preview.command(["git", "rev-parse", "HEAD"], root)
    with pytest.raises(ValueError, match="source tree differs"):
        preview.require_merged_pr_checks(root, commit)


@pytest.mark.parametrize("workflow", ["ci.yml", "ci-windows.yml", "ci-python.yml"])
def test_merged_pr_evidence_requires_each_latest_workflow_on_final_head(source: tuple[Path, str], api_pages: dict, workflow: str) -> None:
    root, commit = source
    runs = api_pages["pruns"][workflow][0]["workflow_runs"]
    runs.append({**runs[0], "run_attempt": 2, "conclusion": "failure"})
    with pytest.raises(ValueError, match=f"latest associated pull request {workflow} run must succeed"):
        preview.require_merged_pr_checks(root, commit)
    api_pages["pruns"][workflow] = [{"workflow_runs": [{**runs[0], "head_sha": COMMIT}]}]
    with pytest.raises(ValueError, match="on its final head"):
        preview.require_merged_pr_checks(root, commit)


def write_wheel(path: Path, kind: str, platform: str | None, version: str = "1.2.3a2") -> None:
    distribution = "deepseek_harness_sdk" if kind == "sdk" else "deepseek_harness_runtime_bin"
    tag = "any" if platform is None else preview.RELEASE["PLATFORMS"][platform][0]
    metadata = f"Name: {distribution.replace('_', '-')}\nVersion: {version}\nLicense-Expression: MIT\nLicense-File: LICENSE\n"
    if kind == "sdk":
        metadata += f"Requires-Dist: deepseek-harness-runtime-bin=={version}\n"
    else:
        metadata += "License-File: THIRD_PARTY_NOTICES.md\n"
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr(f"{distribution}-{version}.dist-info/METADATA", metadata)
        archive.writestr(f"{distribution}-{version}.dist-info/WHEEL", f"Tag: py3-none-{tag}\n")
        if platform is not None:
            executable = preview.RELEASE["PLATFORMS"][platform][1]
            for name in preview.RELEASE["runtime_filenames"](executable):
                info = zipfile.ZipInfo(f"deepseek_harness_runtime/runtime/{name}")
                info.external_attr = 0o100755 << 16
                archive.writestr(info, b"runtime fixture")
            resources = executable.removeprefix("deepseek-harness-sdk-runtime-").removesuffix(".exe")
            prefix = f"deepseek_harness_runtime/runtime/{resources}"
            archive.writestr(f"{prefix}/downloads.json", json.dumps({
                "target": platform.replace("macos-", "mac-"), "identity": "b" * 64, "office": [{}], "pnpm": {},
            }))
            for kind in ("docx", "pptx", "xlsx"):
                archive.writestr(f"{prefix}/office-skills/office-{kind}/SKILL.md", "# Office fixture\n")


@pytest.fixture
def assets(tmp_path: Path) -> Path:
    source = tmp_path / "assets"
    source.mkdir()
    for name, (kind, platform) in preview.expected_assets(VERSION).items():
        if kind == "desktop":
            (source / name).write_bytes(b"unsigned installer fixture")
        else:
            write_wheel(source / name, kind, platform)
    return source


def test_bundle_contains_exactly_three_installers_six_wheels_manifest_and_hashes(assets: Path, tmp_path: Path) -> None:
    output = tmp_path / "bundle"
    preview.bundle(assets, output, VERSION, COMMIT, TAG)
    preview.verify_bundle(output, VERSION, COMMIT, TAG)
    assert len(list(output.iterdir())) == 11
    manifest = json.loads((output / "manifest.json").read_text())
    assert manifest["tag"] == TAG
    assert manifest["productVersion"] == VERSION
    assert manifest["wheelVersion"] == "1.2.3a2"
    assert manifest["commit"] == COMMIT
    assert len(manifest["files"]) == 9
    assert len((output / "SHA256SUMS").read_text().splitlines()) == 10


@pytest.mark.parametrize("change", ["missing", "extra", "version", "empty", "symlink"])
def test_bundle_rejects_incomplete_or_wrong_candidate_assets(assets: Path, tmp_path: Path, change: str) -> None:
    file = next(assets.glob("*.exe"))
    if change == "missing":
        file.unlink()
    elif change == "extra":
        (assets / "latest.yml").write_text("updater fixture\n")
    elif change == "version":
        sdk = next(assets.glob("deepseek_harness_sdk-*.whl"))
        write_wheel(sdk, "sdk", None, "9.9.9")
    elif change == "empty":
        file.write_bytes(b"")
    else:
        original = tmp_path / "installer"
        file.rename(original)
        try:
            file.symlink_to(original)
        except OSError as error:
            pytest.skip(f"symlink creation unavailable: {error}")
    with pytest.raises((ValueError, RuntimeError, KeyError)):
        preview.bundle(assets, tmp_path / "bundle", VERSION, COMMIT, TAG)
    assert not (tmp_path / "bundle").exists()


@pytest.mark.parametrize("change", ["asset", "manifest", "checksum", "tag", "commit"])
def test_final_verification_rejects_changed_release_evidence(assets: Path, tmp_path: Path, change: str) -> None:
    output = tmp_path / "bundle"
    preview.bundle(assets, output, VERSION, COMMIT, TAG)
    tag, commit = TAG, COMMIT
    if change == "asset":
        next(output.glob("*.exe")).write_bytes(b"changed installer")
    elif change == "manifest":
        manifest = json.loads((output / "manifest.json").read_text())
        manifest["productVersion"] = "9.9.9"
        (output / "manifest.json").write_text(json.dumps(manifest))
    elif change == "checksum":
        (output / "SHA256SUMS").write_text("bad checksum\n")
    elif change == "tag":
        tag = TAG.removesuffix("1") + "2"
    else:
        commit = "b" * 40
    with pytest.raises(ValueError, match="manifest|SHA256SUMS"):
        preview.verify_bundle(output, VERSION, commit, tag)
