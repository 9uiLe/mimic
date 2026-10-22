#!/usr/bin/env python3
"""Check a candidate tree with the comparison branch's guard when available."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

from index_snapshot import SnapshotError, change_manifest, resolved_commit, tree_entries, write_snapshot


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", required=True)
    parser.add_argument("--commit", default="HEAD")
    parser.add_argument("--repository", default=".")
    arguments = parser.parse_args()
    repository = Path(arguments.repository).resolve()
    base = resolved_commit(repository, arguments.base)
    candidate_commit = resolved_commit(repository, arguments.commit)
    with tempfile.TemporaryDirectory(prefix="mimic-quality-ci-") as temporary:
        staging = Path(temporary)
        candidate_root = staging / "candidate"
        candidate_root.mkdir()
        write_snapshot(repository, candidate_root, tree_entries(repository, candidate_commit))
        trusted_root = staging / "comparison"
        trusted_root.mkdir()
        write_snapshot(repository, trusted_root, tree_entries(repository, base))
        trusted_checker = trusted_root / "scripts/quality/check_repository.py"
        if not trusted_checker.is_file():
            print("BOOTSTRAP REVIEW REQUIRED: comparison commit has no guard; initial adoption needs human review.")
            trusted_checker = candidate_root / "scripts/quality/check_repository.py"
        manifest = staging / "changes.json"
        manifest.write_text(json.dumps(change_manifest(repository, base, candidate_commit)), encoding="utf-8")
        environment = os.environ.copy()
        environment["QUALITY_DEPENDENCY_ROOT"] = str(repository)
        environment["PYTHONDONTWRITEBYTECODE"] = "1"
        command = [
            sys.executable, str(trusted_checker), "--root", str(candidate_root), "--repository", str(repository),
            "--base", base, "--mode", "commit", "--changes", str(manifest),
        ]
        return subprocess.run(command, env=environment, check=False).returncode


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("quality CI check interrupted", file=sys.stderr)
        raise SystemExit(130)
    except (OSError, ValueError, subprocess.SubprocessError, RuntimeError, SnapshotError) as error:
        print(f"quality CI check could not run: {error}", file=sys.stderr)
        raise SystemExit(2)
