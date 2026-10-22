#!/usr/bin/env python3
"""Install the local inspection-only hook without replacing an unrelated hook."""

from __future__ import annotations

import argparse
from pathlib import Path
import subprocess
import sys


BOOTSTRAP = '''#!/usr/bin/env python3
# mimic-quality-index-bootstrap-v1
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    result = subprocess.run(
        ["git", "show", ":.githooks/pre-commit"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
    )
    if result.returncode:
        print("quality hook: required staged file is unavailable: .githooks/pre-commit", file=sys.stderr)
        raise SystemExit(2)
    with tempfile.TemporaryDirectory(prefix="mimic-quality-bootstrap-") as temporary:
        hook = Path(temporary) / "pre-commit.py"
        hook.write_bytes(result.stdout)
        raise SystemExit(subprocess.run([sys.executable, str(hook)], check=False).returncode)
except KeyboardInterrupt:
    print("quality hook: interrupted; worktree and index were not changed", file=sys.stderr)
    raise SystemExit(130)
except OSError as error:
    print(f"quality hook: {error}", file=sys.stderr)
    raise SystemExit(2)
'''


def install(repository: Path) -> Path:
    hooks = subprocess.run(
        ["git", "-C", str(repository), "rev-parse", "--path-format=absolute", "--git-path", "hooks/pre-commit"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
    )
    hook_path = Path(hooks.stdout.decode(errors="surrogateescape").removesuffix("\n"))
    common_directory = subprocess.run(
        ["git", "-C", str(repository), "rev-parse", "--path-format=absolute", "--git-common-dir"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True,
    )
    common_path = Path(common_directory.stdout.decode(errors="surrogateescape").removesuffix("\n"))
    permitted_roots = (repository.resolve(), common_path.resolve())
    if not any(hook_path.resolve().is_relative_to(root) for root in permitted_roots):
        raise ValueError(f"hook path is outside this repository's local directories: {hook_path}")
    if hook_path.is_symlink():
        raise ValueError(f"refusing to replace an existing symlink: {hook_path}")
    if hook_path.exists() and hook_path.read_text(encoding="utf-8") != BOOTSTRAP:
        raise ValueError(f"existing pre-commit hook must be integrated explicitly: {hook_path}")
    hook_path.parent.mkdir(parents=True, exist_ok=True)
    hook_path.write_text(BOOTSTRAP, encoding="utf-8")
    hook_path.chmod(0o755)
    return hook_path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", default=".")
    arguments = parser.parse_args()
    try:
        hook_path = install(Path(arguments.repository).resolve())
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"quality hook install: {error}", file=sys.stderr)
        return 2
    print(f"Installed inspection-only local hook: {hook_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
