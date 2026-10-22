"""Read explicit Git trees or nonignored working files without changing either."""

from __future__ import annotations

import os
from pathlib import Path
import subprocess


class ContentError(RuntimeError):
    pass


def git_bytes(repository: Path, *arguments: str) -> bytes:
    execution = subprocess.run(
        ["git", "-C", str(repository), *arguments], capture_output=True, check=False,
    )
    if execution.returncode:
        raise ContentError(execution.stderr.decode("utf-8", "replace").strip())
    return execution.stdout


def committed_files(repository: Path, revision: str) -> dict[str, bytes]:
    if revision == "EMPTY":
        return {}
    files = {}
    for entry in git_bytes(repository, "ls-tree", "-rz", revision).split(b"\0"):
        if not entry:
            continue
        metadata, encoded_path = entry.split(b"\t", 1)
        mode, kind, object_id = metadata.decode("ascii").split()
        source_path = os.fsdecode(encoded_path)
        if kind != "blob" or mode not in ("100644", "100755"):
            raise ContentError(f"Unsupported committed source mode {mode}: {source_path!r}")
        files[source_path] = git_bytes(repository, "cat-file", "blob", object_id)
    return files


def working_files(repository: Path) -> dict[str, bytes]:
    paths = git_bytes(repository, "ls-files", "--cached", "--others", "--exclude-standard", "-z")
    files = {}
    for encoded_path in paths.split(b"\0"):
        if not encoded_path:
            continue
        source_path = os.fsdecode(encoded_path)
        location = repository / source_path
        if location.is_symlink():
            raise ContentError(f"Source symlink requires explicit review: {source_path!r}")
        if not location.exists():
            continue
        if not location.is_file():
            raise ContentError(f"Source is not a readable regular file: {source_path!r}")
        files[source_path] = location.read_bytes()
    return files


def snapshot_files(root: Path) -> dict[str, bytes]:
    files = {}
    for location in root.rglob("*"):
        if location.is_symlink():
            raise ContentError(f"Snapshot symlink requires explicit review: {location.relative_to(root)!s}")
        if location.is_file():
            files[location.relative_to(root).as_posix()] = location.read_bytes()
    return files


def working_changes(repository: Path, base: str, candidate: dict[str, bytes]) -> dict:
    if base == "EMPTY":
        return {"paths": list(candidate), "renames": {}, "statuses": [
            {"status": "A", "path": source_path} for source_path in candidate
        ]}
    fields = git_bytes(
        repository, "diff", "--name-status", "-z", "--find-renames", "--find-copies", "--find-copies-harder", base,
    ).split(b"\0")
    paths, renames, statuses = [], {}, []
    cursor = 0
    while cursor < len(fields) and fields[cursor]:
        change_kind = fields[cursor].decode("ascii")[0]
        old_path = os.fsdecode(fields[cursor + 1])
        cursor += 2
        change = {"status": change_kind, "path": old_path}
        if change_kind in ("R", "C"):
            source_path = os.fsdecode(fields[cursor])
            cursor += 1
            change = {"status": change_kind, "path": source_path, "old_path": old_path}
            if change_kind == "R":
                renames[source_path] = old_path
        paths.append(change["path"])
        statuses.append(change)
    tracked = {os.fsdecode(value) for value in git_bytes(repository, "ls-files", "-z").split(b"\0") if value}
    for source_path in candidate.keys() - tracked:
        paths.append(source_path)
        statuses.append({"status": "A", "path": source_path})
    return {"paths": paths, "renames": renames, "statuses": statuses}
