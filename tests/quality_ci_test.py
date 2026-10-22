"""Prove committed candidates are checked by the comparison commit's real rules.

Fixtures use an explicitly empty original inventory and only Python source. They
test CI trust and snapshot boundaries, not the application's behavioral meaning.
"""

from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


PROJECT_ROOT = Path(__file__).resolve().parents[1]
CI_CHECKER = PROJECT_ROOT / "scripts/quality/ci_check.py"
GIT_COMMAND = shutil.which("git")
assert GIT_COMMAND is not None, "Git is required for committed-candidate CI tests"


def isolated_environment() -> dict[str, str]:
    environment = os.environ.copy()
    local_names = subprocess.run(
        [GIT_COMMAND, "rev-parse", "--local-env-vars"],
        stdout=subprocess.PIPE, check=True,
    ).stdout.decode().splitlines()
    for name in local_names:
        environment.pop(name, None)
    for name in tuple(environment):
        if name.startswith(("GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_")):
            environment.pop(name)
    environment["PYTHONDONTWRITEBYTECODE"] = "1"
    return environment


class CommittedCandidateFixture:
    def __init__(self, directory: Path):
        self.directory = directory
        self.environment = isolated_environment()
        self.git("init", "--quiet")
        self.git("config", "user.name", "Quality CI Test")
        self.git("config", "user.email", "quality-ci-test@example.invalid")
        self.git("config", "commit.gpgsign", "false")
        for source_script in sorted((PROJECT_ROOT / "scripts/quality").glob("*.py")):
            self.write("scripts/quality/" + source_script.name, source_script.read_text())
        policy = json.loads((PROJECT_ROOT / ".quality/policy.json").read_text())
        policy["anchor_commit"] = "EMPTY"
        self.write_json(".quality/policy.json", policy)
        initial = {"length_caps": {}, "long_lines": [], "naming": []}
        self.baseline = {
            "schema_version": 1,
            "anchor_commit": "EMPTY",
            "initial": initial,
            "allowances": copy.deepcopy(initial) | {"origins": {}},
        }
        self.write_json(".quality/baseline.json", self.baseline)
        self.write("fixture-spec.md", "CI fixture: source limits are 800 lines and 200 Unicode codepoints.\n")
        self.write_json(".quality/change-contracts.json", {"contracts": [{
            "id": "committed-candidate-fixture",
            "paths": ["*"],
            "purpose": "Exercise trusted real checks against fixed committed snapshots",
            "basis_status": "confirmed",
            "basis": ["fixture-spec.md"],
            "validation": ["python3 -m unittest discover -s tests -p quality_ci_test.py -v"],
            "unresolved": ["This fixture does not prove application semantics or remote workflow protection"],
        }]})
        self.write("order_rules.py", "selection_count = 1\n")
        self.base_commit = self.commit()

    def run(self, *arguments: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            list(arguments), cwd=self.directory, env=self.environment,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, check=False,
        )

    def git(self, *arguments: str) -> subprocess.CompletedProcess:
        execution = self.run(GIT_COMMAND, *arguments)
        if execution.returncode:
            raise AssertionError(f"git {arguments!r}: {execution.stdout}")
        return execution

    def write(self, relative_path: str, contents: str) -> None:
        location = self.directory / relative_path
        location.parent.mkdir(parents=True, exist_ok=True)
        location.write_text(contents, encoding="utf-8")

    def write_json(self, relative_path: str, contents: dict) -> None:
        self.write(relative_path, json.dumps(contents, indent=2) + "\n")

    def commit(self) -> str:
        self.git("add", "--all")
        self.git("-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "CI fixture commit")
        return self.git("rev-parse", "HEAD").stdout.strip()

    def verify(self, candidate_commit: str) -> subprocess.CompletedProcess:
        return self.run(
            sys.executable, str(CI_CHECKER), "--repository", str(self.directory),
            "--base", self.base_commit, "--commit", candidate_commit,
        )


class QualityCommittedCandidateTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="mimic-ci-trust-test-")
        self.addCleanup(temporary.cleanup)
        self.repository = CommittedCandidateFixture(Path(temporary.name))

    def test_good_commit_passes_despite_uncommitted_violation(self) -> None:
        self.repository.write("order_rules.py", "selection_count = 2\n")
        candidate_commit = self.repository.commit()
        self.repository.write("order_rules.py", "#" * 201 + "\n")
        execution = self.repository.verify(candidate_commit)
        self.assertEqual(execution.returncode, 0, execution.stdout)
        self.assertIn('"mode": "commit"', execution.stdout)
        self.assertIn(self.repository.base_commit, execution.stdout)
        self.assertNotIn("BOOTSTRAP REVIEW REQUIRED", execution.stdout)

    def test_bypassed_bad_commit_fails_despite_uncommitted_fix(self) -> None:
        self.repository.write("order_rules.py", "#" * 201 + "\n")
        candidate_commit = self.repository.commit()
        self.repository.write("order_rules.py", "selection_count = 2\n")
        execution = self.repository.verify(candidate_commit)
        self.assertEqual(execution.returncode, 1, execution.stdout)
        self.assertIn("order_rules.py:1: line has 201 codepoints", execution.stdout)

    def test_candidate_cannot_add_its_own_legacy_exception(self) -> None:
        bad_line = "#" * 201
        self.repository.write("order_rules.py", bad_line + "\n")
        forged_baseline = copy.deepcopy(self.repository.baseline)
        forged_baseline["allowances"]["long_lines"].append({
            "path": "order_rules.py", "line": 1, "codepoints": 201, "text": bad_line,
        })
        self.repository.write_json(".quality/baseline.json", forged_baseline)
        candidate_commit = self.repository.commit()
        execution = self.repository.verify(candidate_commit)
        self.assertNotEqual(execution.returncode, 0, execution.stdout)
        self.assertIn("Baseline adds or changes long_lines exceptions", execution.stdout)

    def test_comparison_checker_rejects_candidate_checker_weakening(self) -> None:
        self.repository.write("order_rules.py", "#" * 201 + "\n")
        self.repository.write("scripts/quality/check_repository.py", "raise SystemExit(0)\n")
        candidate_commit = self.repository.commit()
        naive_execution = self.repository.run(
            sys.executable, str(self.repository.directory / "scripts/quality/check_repository.py"),
        )
        self.assertEqual(naive_execution.returncode, 0, naive_execution.stdout)
        self.repository.write("order_rules.py", "selection_count = 2\n")
        execution = self.repository.verify(candidate_commit)
        self.assertEqual(execution.returncode, 1, execution.stdout)
        self.assertIn("order_rules.py:1: line has 201 codepoints", execution.stdout)
        self.assertIn('"path": "scripts/quality/check_repository.py"', execution.stdout)

    def test_candidate_limit_relaxation_is_not_accepted(self) -> None:
        self.repository.write("order_rules.py", "#" * 201 + "\n")
        policy_path = self.repository.directory / ".quality/policy.json"
        relaxed_policy = json.loads(policy_path.read_text())
        relaxed_policy["limits"]["line_codepoints"] = 1000
        self.repository.write_json(".quality/policy.json", relaxed_policy)
        candidate_commit = self.repository.commit()
        execution = self.repository.verify(candidate_commit)
        self.assertEqual(execution.returncode, 1, execution.stdout)
        self.assertIn("Policy relaxation requires separate review: limit line_codepoints", execution.stdout)


if __name__ == "__main__":
    unittest.main()
