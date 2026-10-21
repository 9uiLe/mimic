"""Select isolated worktree-local work units without changing project ignore rules."""

from __future__ import annotations

import os
import re
import secrets
import stat
import subprocess
from datetime import datetime, timezone
from pathlib import Path

import data_policy
import store
from model import DataError


DIRECTORY = ".moletta-runs"
IGNORE_PATTERN = "/.moletta-runs/"
README = """# Moletta local work units

Each child directory is one independent Moletta work unit. Run names combine a
UTC timestamp, a task name and a random suffix. Starting a task again creates a
new directory; use the returned run path to continue an existing work unit.

A work unit contains:

- `brief.md`: the original request, copied when the work unit starts.
- `intent.json` and `seal.json`: outcomes, constraints and the sealed intent.
- `plan.json`: the current requirements, options, experiments and next action.
- `journal.json`: observation starts, completions and assessments.
- `artifacts/`: command output, native-tool transcripts and imported attachments.
- `checkpoints/`: snapshots of the record's structural readiness.
- `devices/`: ownership receipts and outstanding device cleanup obligations.
- `metrics/`: derived numeric summaries and matched-context comparisons.
- `delegation/`: approved choices, bounded assignments and reported usage.
- `.write.lock`: coordination for local writers; its presence is not an error.

These are local working records, not source files. They can contain private
requests, paths, command output and attachments. Review inputs before recording
and retain or remove completed work units according to the project's needs.
Moletta does not claim to detect every secret or authenticate observations.

Add `/.moletta-runs/` to this project's `.gitignore` to keep the work units out of
commits. Moletta reports whether that exact rule is present and does not edit
`.gitignore`. Each Git worktree keeps its own directory at its worktree root;
records are not stored in the shared Git directory. Outside Git, the selected
project directory (or the calling directory) is used.
"""


def _directory(path: Path) -> Path:
    result = path.resolve(strict=True)
    if not result.is_dir():
        raise DataError(f"Project must be an existing directory: {path}")
    return result


def _git_root(directory: Path) -> Path | None:
    environment = os.environ.copy()
    for key in ("GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_CEILING_DIRECTORIES"):
        environment.pop(key, None)
    try:
        result = subprocess.run(["git", "-C", str(directory), "rev-parse", "--show-toplevel"],
                                capture_output=True, check=False, env=environment, timeout=5)
    except FileNotFoundError:
        return None
    except subprocess.TimeoutExpired as exc:
        raise DataError("Git project discovery timed out") from exc
    if result.returncode:
        return None
    return _directory(Path(os.fsdecode(result.stdout.removesuffix(b"\n"))))


def project_root(project: Path | None = None, *, cwd: Path | None = None) -> Path:
    """Use the current worktree root, or the selected directory outside Git."""
    caller = _directory(cwd or Path.cwd())
    directory = _directory(caller / project if project is not None else caller)
    return _git_root(directory) or directory


def _regular_file(path: Path) -> str:
    """Read only a regular file, without following the final path component."""
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "r", encoding="utf-8") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise DataError(f"Expected a regular file: {path}")
        return stream.read()


def _ignore_status(project: Path) -> dict:
    path = project / ".gitignore"
    try:
        content = _regular_file(path)
    except FileNotFoundError:
        status = "missing"
    except (OSError, UnicodeError, DataError):
        status = "unreadable"
    else:
        status = "present" if IGNORE_PATTERN in content.splitlines() else "missing"
    message = (f"{IGNORE_PATTERN} is present in {path}." if status == "present" else
               f"Add {IGNORE_PATTERN} to {path}; Moletta has not changed .gitignore.")
    if status == "unreadable":
        message = f"Could not safely read {path}. Check that it contains {IGNORE_PATTERN}; Moletta has not changed it."
    return {"path": str(path), "pattern": IGNORE_PATTERN, "status": status, "message": message}


def _workspace(project: Path) -> Path:
    path = project / DIRECTORY
    try:
        path.mkdir(mode=0o700)
    except FileExistsError:
        if path.is_symlink() or not path.is_dir():
            raise DataError(f"{DIRECTORY} must be a directory, not a symlink or other file")
    readme = path / "README.md"
    try:
        descriptor = os.open(readme, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        if readme.is_symlink() or not readme.is_file():
            raise DataError(f"{DIRECTORY}/README.md must be a regular file, not a symlink")
    else:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(README)
    return path


def _slug(value: str) -> str:
    # Unicode word characters keep task names useful in the caller's language.
    value = re.sub(r"[^\w]+", "-", value.casefold(), flags=re.UNICODE)
    value = value[:60].strip("-_")
    while len(value.encode("utf-8")) > 180:
        value = value[:-1]
    return value or "task"


def initialize(brief_path: Path, goal: str, *, root: Path | None = None,
               project: Path | None = None, name: str | None = None,
               cwd: Path | None = None) -> dict:
    """Create a work unit; an explicit root bypasses the default workspace."""
    data_policy.check_text(goal, label="Task goal")
    if name is not None:
        data_policy.check_text(name, label="Task name", max_bytes=256)
    if root is not None:
        data_policy.check_text(str(root), label="Run location")
    caller = _directory(cwd or Path.cwd())
    brief_path = caller / brief_path
    if root is not None:
        if name is not None:
            raise DataError("--name applies only when RUN is omitted")
        selected = root if root.is_absolute() else caller / root
        # Preserve the leaf for exclusive creation: resolving it would follow a symlink.
        selected = selected.parent.resolve() / selected.name
        selected_project = (project_root(project, cwd=caller) if project is not None else
                            _git_root(caller) or selected.parent)
        value = store.initialize(selected, brief_path, goal)
        return {**value, "project": str(selected_project), "workspace": None,
                "gitignore": _ignore_status(selected_project)}
    selected_project = project_root(project, cwd=caller)
    workspace = _workspace(selected_project)
    slug = _slug(name if name is not None else goal)
    # mkdir inside store.initialize is exclusive; a collision never resumes a run.
    for _ in range(100):
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
        selected = workspace / f"{timestamp}-{slug}-{secrets.token_hex(4)}"
        try:
            value = store.initialize(selected, brief_path, goal)
        except FileExistsError as exc:
            if exc.filename != str(selected):
                raise
            continue
        return {**value, "project": str(selected_project), "workspace": str(workspace),
                "gitignore": _ignore_status(selected_project)}
    raise DataError("Could not allocate a distinct work unit; retry initialization")
