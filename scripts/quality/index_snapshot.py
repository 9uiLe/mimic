#!/usr/bin/env python3
"""Run the common checker using only a Git index or committed tree snapshot."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


class SnapshotError(Exception):
    """A required Git object or snapshot could not be inspected."""


def git(repository: Path, *arguments: str, input_bytes: bytes | None = None) -> bytes:
    result = subprocess.run(
        ["git", "-C", str(repository), *arguments],
        input=input_bytes,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode:
        explanation = result.stderr.decode("utf-8", errors="replace").strip()
        raise SnapshotError(f"git {' '.join(arguments)}: {explanation}")
    return result.stdout


def resolved_commit(repository: Path, reference: str) -> str:
    return git(repository, "rev-parse", "--verify", f"{reference}^{{commit}}").decode().strip()


def comparison_base(repository: Path, requested: str | None) -> str:
    if requested == "EMPTY":
        return "EMPTY"
    if requested:
        return resolved_commit(repository, requested)
    head = subprocess.run(
        ["git", "-C", str(repository), "rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if head.returncode == 0:
        return head.stdout.decode().strip()
    # Distinguish an unborn branch from an unreadable or invalid repository.
    git(repository, "rev-parse", "--git-dir")
    symbolic = subprocess.run(
        ["git", "-C", str(repository), "symbolic-ref", "-q", "HEAD"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if symbolic.returncode == 0:
        reference = symbolic.stdout.decode().strip()
        existing = subprocess.run(
            ["git", "-C", str(repository), "show-ref", "--verify", "--quiet", reference],
            check=False,
        )
        if existing.returncode == 1:
            return "EMPTY"
    raise SnapshotError("HEAD is unavailable; supply a confirmed --base or repair the repository")


def tree_entries(repository: Path, commit: str | None) -> list[tuple[str, str, str]]:
    if commit:
        rows = git(repository, "ls-tree", "-r", "-z", commit).split(b"\0")
    else:
        if git(repository, "ls-files", "--unmerged", "-z"):
            raise SnapshotError("the Git index contains unresolved conflicts")
        rows = git(repository, "ls-files", "--stage", "-z").split(b"\0")
    entries = []
    for row in rows:
        if not row:
            continue
        metadata, path_bytes = row.split(b"\t", 1)
        fields = metadata.decode("ascii").split()
        mode, object_id = (fields[0], fields[2]) if commit else (fields[0], fields[1])
        if not commit and fields[2] != "0":
            raise SnapshotError("the Git index contains a nonzero conflict stage")
        entries.append((mode, object_id, os.fsdecode(path_bytes)))
    return entries


def change_manifest(repository: Path, base: str, commit: str | None) -> dict:
    base_tree = base
    if base == "EMPTY":
        base_tree = git(repository, "hash-object", "-t", "tree", "--stdin", input_bytes=b"").decode().strip()
    arguments = ["diff", "--name-status", "-z", "--find-renames", "--find-copies", "--find-copies-harder"]
    arguments.extend([base_tree, commit] if commit else ["--cached", base_tree])
    fields = git(repository, *arguments).split(b"\0")
    paths, renames, statuses = [], {}, []
    position = 0
    while position < len(fields) and fields[position]:
        status = fields[position].decode("ascii")
        position += 1
        old_path = os.fsdecode(fields[position])
        position += 1
        row = {"status": status[0], "path": old_path}
        if status[0] in ("R", "C"):
            new_path = os.fsdecode(fields[position])
            position += 1
            row = {"status": status[0], "path": new_path, "old_path": old_path}
            if status[0] == "R":
                renames[new_path] = old_path
        paths.append(row["path"])
        statuses.append(row)
    return {"paths": paths, "renames": renames, "statuses": statuses}


def write_snapshot(repository: Path, snapshot: Path, entries: list[tuple[str, str, str]]) -> None:
    links = []
    for mode, object_id, relative_path in entries:
        path = snapshot / relative_path
        if Path(relative_path).is_absolute() or ".." in Path(relative_path).parts:
            raise SnapshotError(f"unsafe Git path: {relative_path!r}")
        if mode == "160000":
            raise SnapshotError(f"submodule content cannot be read from this snapshot: {relative_path!r}")
        content = git(repository, "cat-file", "blob", object_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        if mode == "120000":
            links.append((path, os.fsdecode(content)))
        elif mode in ("100644", "100755"):
            path.write_bytes(content)
            path.chmod(0o755 if mode == "100755" else 0o644)
        else:
            raise SnapshotError(f"unsupported Git mode {mode}: {relative_path!r}")
    for path, target in links:
        if Path(target).is_absolute():
            raise SnapshotError(f"snapshot symlink points outside the tree: {path.relative_to(snapshot)!s}")
        path.symlink_to(target)
    for path, _target in links:
        try:
            path.resolve(strict=True).relative_to(snapshot.resolve())
        except (OSError, ValueError, RuntimeError) as error:
            raise SnapshotError(f"unsafe snapshot symlink: {path.relative_to(snapshot)!s}") from error


def run_snapshot(arguments: argparse.Namespace) -> int:
    repository = Path(arguments.repository).resolve()
    # Relative alternate-index paths are relative to the caller, not the temporary tree.
    if os.environ.get("GIT_INDEX_FILE"):
        os.environ["GIT_INDEX_FILE"] = str(Path(os.environ["GIT_INDEX_FILE"]).resolve())
    base = comparison_base(repository, arguments.base)
    commit = resolved_commit(repository, arguments.commit) if arguments.commit else None
    entries = tree_entries(repository, commit)
    if not entries:
        raise SnapshotError("the candidate tree is unexpectedly empty")
    changes = change_manifest(repository, base, commit)
    with tempfile.TemporaryDirectory(prefix="mimic-quality-snapshot-") as temporary:
        temporary_root = Path(temporary)
        snapshot = temporary_root / "tree"
        snapshot.mkdir()
        write_snapshot(repository, snapshot, entries)
        if commit is None and tree_entries(repository, None) != entries:
            raise SnapshotError("the Git index changed while its snapshot was being read; retry the inspection")
        checker = snapshot / "scripts/quality/check_repository.py"
        if not checker.is_file():
            raise SnapshotError("required staged checker is missing: scripts/quality/check_repository.py")
        manifest_path = temporary_root / "changes.json"
        manifest_path.write_text(json.dumps(changes, ensure_ascii=True), encoding="utf-8")
        checker_environment = os.environ.copy()
        checker_environment["QUALITY_DEPENDENCY_ROOT"] = str(repository)
        checker_environment["PYTHONDONTWRITEBYTECODE"] = "1"
        command = [
            sys.executable, str(checker), "--root", str(snapshot), "--repository", str(repository),
            "--base", base, "--mode", "commit" if commit else "staged", "--changes", str(manifest_path),
        ]
        return subprocess.run(command, env=checker_environment, check=False).returncode


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", default=".")
    parser.add_argument("--mode", choices=("staged", "commit"))
    parser.add_argument("--commit")
    parser.add_argument("--base")
    arguments = parser.parse_args()
    if arguments.mode == "commit" and not arguments.commit:
        parser.error("--mode commit requires --commit")
    if arguments.mode == "staged" and arguments.commit:
        parser.error("--mode staged cannot be combined with --commit")
    try:
        return run_snapshot(arguments)
    except KeyboardInterrupt:
        print("quality snapshot: interrupted; worktree and index were not changed", file=sys.stderr)
        return 130
    except (SnapshotError, OSError, ValueError) as error:
        print(f"quality snapshot: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
