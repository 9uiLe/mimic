"""Exercise the real installed hook and Git index boundary in disposable repositories.

The small checker fixture deliberately isolates snapshot behavior from repository rules.
The common rules have their own tests; this fixture never claims to prove their policy.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import unittest


PROJECT = Path(__file__).resolve().parents[1]
INSTALLER = PROJECT / "scripts/quality/install_hook.py"
SNAPSHOT = PROJECT / "scripts/quality/index_snapshot.py"
GIT = shutil.which("git")
CHECKER_FIXTURE = '''import argparse
import json
from pathlib import Path
import sys
import time

parser = argparse.ArgumentParser()
for name in ("root", "repository", "base", "mode", "changes"):
    parser.add_argument("--" + name, required=True)
arguments = parser.parse_args()
root = Path(arguments.root)
policy = json.loads((root / ".quality/fixture-policy.json").read_text())
if policy.get("pause"):
    print("fixture checker is waiting", flush=True)
    time.sleep(60)
violations = []
for path in sorted(root.rglob("*.demo")):
    lines = path.read_text().splitlines()
    if len(lines) > policy["lines"]:
        violations.append(str(path.relative_to(root)) + ": total lines " + str(len(lines)))
    for number, line in enumerate(lines, 1):
        if len(line) > policy["columns"]:
            violations.append(str(path.relative_to(root)) + ":" + str(number) + ": line length " + str(len(line)))
if violations:
    print("\\n".join(violations), file=sys.stderr)
    raise SystemExit(1)
print("fixture snapshot checked")
print("fixture statuses:" + "".join(row["status"] for row in json.loads(Path(arguments.changes).read_text())["statuses"]))
'''


def isolated_git_environment() -> dict[str, str]:
    environment = os.environ.copy()
    environment["PYTHONDONTWRITEBYTECODE"] = "1"
    names = subprocess.run(
        [GIT, "rev-parse", "--local-env-vars"], stdout=subprocess.PIPE, check=True
    ).stdout.decode().splitlines()
    for name in names:
        environment.pop(name, None)
    for name in tuple(environment):
        if name.startswith(("GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_")):
            environment.pop(name)
    return environment


class RepositoryFixture:
    def __init__(self, root: Path):
        self.root = root
        self.environment = isolated_git_environment()
        self.git("init", "-q")
        self.git("config", "user.name", "Quality Hook Test")
        self.git("config", "user.email", "quality-hook-test@example.invalid")
        self.git("config", "core.hooksPath", ".git/hooks")
        self.write("scripts/quality/index_snapshot.py", SNAPSHOT.read_text())
        self.write("scripts/quality/check_repository.py", CHECKER_FIXTURE)
        self.write(".githooks/pre-commit", (PROJECT / ".githooks/pre-commit").read_text())
        self.write(".quality/fixture-policy.json", json.dumps({"lines": 800, "columns": 200}))
        self.write("sample.demo", "valid\n")
        self.git("add", "--all")
        installed = self.run(sys.executable, str(INSTALLER), "--repository", str(root))
        if installed.returncode:
            raise AssertionError(installed.stdout)

    def run(self, *arguments: str, environment: dict | None = None) -> subprocess.CompletedProcess:
        return subprocess.run(
            list(arguments), cwd=self.root, env=environment or self.environment,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, check=False,
        )

    def git(self, *arguments: str, environment: dict | None = None) -> subprocess.CompletedProcess:
        result = self.run(GIT, *arguments, environment=environment)
        if result.returncode:
            raise AssertionError(f"git {arguments!r}: {result.stdout}")
        return result

    def write(self, path: str, content: str):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)

    def stage(self, *paths: str):
        self.git("add", "--", *paths)

    def commit(self, environment: dict | None = None):
        return self.run(GIT, "commit", "--quiet", "-m", "fixture commit", environment=environment)

    def state(self, environment: dict | None = None):
        environment = environment or self.environment
        listing = self.git("ls-files", "--stage", "-z", environment=environment).stdout
        index_file = self.git("rev-parse", "--git-path", "index", environment=environment).stdout.strip()
        index_path = Path(index_file)
        if not index_path.is_absolute():
            index_path = self.root / index_path
        index_digest = hashlib.sha256(index_path.read_bytes()).hexdigest()
        worktree = {}
        for path in self.root.rglob("*"):
            if ".git" in path.relative_to(self.root).parts or not path.is_file():
                continue
            worktree[str(path.relative_to(self.root))] = path.read_bytes()
        return listing, index_digest, worktree


class QualityHookTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="mimic-hook-test-")
        self.addCleanup(self.temporary.cleanup)
        self.repository = RepositoryFixture(Path(self.temporary.name))

    def assert_commit(self, expected_success: bool, *, environment: dict | None = None):
        before = self.repository.state(environment)
        result = self.repository.commit(environment)
        self.assertEqual(result.returncode == 0, expected_success, result.stdout)
        after = self.repository.state(environment)
        # Successful Git commits may refresh index stat data. The hook itself is also
        # invoked directly below to establish byte-for-byte index preservation.
        self.assertEqual(before[0], after[0], result.stdout)
        self.assertEqual(before[2], after[2], result.stdout)
        return result

    def direct_hook(self, environment: dict | None = None):
        hook = self.repository.root / ".git/hooks/pre-commit"
        return self.repository.run(sys.executable, str(hook), environment=environment)

    def test_initial_commit_accepts_staged_good_content(self):
        self.assert_commit(True)

    def test_staged_violation_rejected_despite_unstaged_fix(self):
        self.repository.write("sample.demo", "x" * 201 + "\n")
        self.repository.stage("sample.demo")
        self.repository.write("sample.demo", "fixed only in worktree\n")
        result = self.assert_commit(False)
        self.assertIn("line length 201", result.stdout)

    def test_unstaged_violation_does_not_reject_good_index(self):
        self.repository.write("sample.demo", "x" * 201 + "\n")
        self.assert_commit(True)

    def test_partial_stage_uses_total_file_length(self):
        self.repository.write("sample.demo", "x\n" * 801)
        self.repository.stage("sample.demo")
        self.repository.write("sample.demo", "x\n" * 800)
        result = self.assert_commit(False)
        self.assertIn("total lines 801", result.stdout)

    def test_unstaged_settings_hook_and_checker_cannot_weaken_staged_check(self):
        self.repository.write("sample.demo", "x" * 201 + "\n")
        self.repository.stage("sample.demo")
        self.repository.write(".quality/fixture-policy.json", json.dumps({"lines": 9999, "columns": 9999}))
        self.repository.write("scripts/quality/check_repository.py", "raise SystemExit(0)\n")
        self.repository.write("scripts/quality/index_snapshot.py", "raise SystemExit(0)\n")
        self.repository.write(".githooks/pre-commit", "raise SystemExit(0)\n")
        self.assertIn("line length 201", self.assert_commit(False).stdout)

    def test_deletion_rename_copy_and_unusual_paths(self):
        self.assert_commit(True)
        self.repository.git("mv", "sample.demo", "日本語 space\nrenamed.demo")
        self.repository.write("copy.demo", "valid\n")
        self.repository.stage("copy.demo")
        self.assert_commit(True)
        base = self.repository.git("rev-parse", "HEAD^").stdout.strip()
        result = self.repository.run(
            sys.executable, str(SNAPSHOT), "--repository", str(self.repository.root), "--base", base
        )
        self.assertEqual(result.returncode, 0, result.stdout)
        manifest_statuses = result.stdout.split("fixture statuses:")[1].splitlines()[0]
        self.assertIn("R", manifest_statuses)
        self.assertIn("C", manifest_statuses)
        self.repository.git("rm", "copy.demo")
        self.assert_commit(True)

    def test_alternate_index_is_used(self):
        alternate = Path(self.temporary.name) / ".git/alternate-index"
        shutil.copyfile(self.repository.root / ".git/index", alternate)
        environment = self.repository.environment | {"GIT_INDEX_FILE": str(alternate)}
        self.repository.write("sample.demo", "x" * 201 + "\n")
        self.repository.git("add", "sample.demo", environment=environment)
        self.assert_commit(False, environment=environment)
        self.repository.write("sample.demo", "valid\n")
        self.assert_commit(True)

    def test_configuration_change_is_checked_against_full_staged_tree(self):
        self.repository.write("sample.demo", "x" * 150 + "\n")
        self.repository.stage("sample.demo")
        self.assert_commit(True)
        self.repository.write(".quality/fixture-policy.json", json.dumps({"lines": 800, "columns": 100}))
        self.repository.stage(".quality/fixture-policy.json")
        self.assertIn("line length 150", self.assert_commit(False).stdout)

    def test_missing_required_script_and_checker_error_reject_commit(self):
        self.repository.git("rm", "--force", "scripts/quality/check_repository.py")
        self.assertIn("required staged checker is missing", self.assert_commit(False).stdout)
        self.repository.write("scripts/quality/check_repository.py", "raise RuntimeError('fixture read error')\n")
        self.repository.stage("scripts/quality/check_repository.py")
        self.assertIn("fixture read error", self.assert_commit(False).stdout)

    def test_missing_staged_bootstrap_inputs_fail_without_worktree_fallback(self):
        for required in (".githooks/pre-commit", "scripts/quality/index_snapshot.py"):
            self.repository.git("rm", "--cached", "--force", "--", required)
            self.assertIn("required staged file is unavailable", self.assert_commit(False).stdout)
            self.repository.stage(required)

    def test_type_change_and_unsafe_symlink(self):
        self.assert_commit(True)
        self.repository.write("target.demo", "valid\n")
        sample = self.repository.root / "sample.demo"
        sample.unlink()
        sample.symlink_to("target.demo")
        self.repository.stage("sample.demo", "target.demo")
        self.assert_commit(True)
        sample.unlink()
        sample.symlink_to("/etc/passwd")
        self.repository.stage("sample.demo")
        self.assertIn("symlink points outside", self.assert_commit(False).stdout)

    def test_dependency_absence_rejects_commit(self):
        tool_directory = self.repository.root / ".git/tools"
        tool_directory.mkdir()
        (tool_directory / "git").symlink_to(GIT)
        environment = self.repository.environment | {"PATH": str(tool_directory)}
        result = self.assert_commit(False, environment=environment)
        self.assertIn("python3", result.stdout)

    def test_conflicts_are_not_success(self):
        object_id = self.repository.git("hash-object", "-w", "sample.demo").stdout.strip()
        index_rows = f"100644 {object_id} 1\tsample.demo\n100644 {object_id} 2\tsample.demo\n"
        subprocess.run(
            [GIT, "update-index", "--index-info"], input=index_rows, text=True,
            cwd=self.repository.root, env=self.repository.environment, check=True,
        )
        result = self.direct_hook()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unresolved conflicts", result.stdout)

    def test_success_and_failure_preserve_index_bytes_and_worktree(self):
        for content, success in (("valid\n", True), ("x" * 201 + "\n", False)):
            self.repository.write("sample.demo", content)
            self.repository.stage("sample.demo")
            before = self.repository.state()
            result = self.direct_hook()
            self.assertEqual(result.returncode == 0, success, result.stdout)
            self.assertEqual(before, self.repository.state())

    def test_interruption_preserves_index_bytes_and_worktree(self):
        self.repository.write(".quality/fixture-policy.json", json.dumps({"lines": 800, "columns": 200, "pause": True}))
        self.repository.stage(".quality/fixture-policy.json")
        before = self.repository.state()
        hook = self.repository.root / ".git/hooks/pre-commit"
        process = subprocess.Popen(
            [sys.executable, str(hook)], cwd=self.repository.root, env=self.repository.environment,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, start_new_session=True,
        )
        try:
            self.assertEqual(process.stdout.readline().strip(), "fixture checker is waiting")
            os.killpg(process.pid, signal.SIGINT)
            process.communicate(timeout=10)
            self.assertNotEqual(process.returncode, 0)
            self.assertEqual(before, self.repository.state())
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.communicate()

    def test_hook_bypass_commit_still_fails_commit_snapshot_check(self):
        self.assert_commit(True)
        base = self.repository.git("rev-parse", "HEAD").stdout.strip()
        self.repository.write("sample.demo", "x" * 201 + "\n")
        self.repository.stage("sample.demo")
        self.repository.git("-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "bypassed hook")
        result = self.repository.run(
            sys.executable, str(SNAPSHOT), "--repository", str(self.repository.root),
            "--mode", "commit", "--commit", "HEAD", "--base", base,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("line length 201", result.stdout)

    def test_installer_respects_local_hooks_path_and_preserves_unrelated_hook(self):
        self.repository.git("config", "core.hooksPath", ".local-hooks")
        installed = self.repository.run(sys.executable, str(INSTALLER), "--repository", str(self.repository.root))
        self.assertEqual(installed.returncode, 0, installed.stdout)
        hook = self.repository.root / ".local-hooks/pre-commit"
        self.assertTrue(hook.is_file())
        hook.write_text("#!/bin/sh\nexit 0\n")
        refused = self.repository.run(sys.executable, str(INSTALLER), "--repository", str(self.repository.root))
        self.assertNotEqual(refused.returncode, 0)
        self.assertEqual(hook.read_text(), "#!/bin/sh\nexit 0\n")

    def test_installer_does_not_write_to_a_shared_external_hooks_path(self):
        with tempfile.TemporaryDirectory(prefix="mimic-shared-hooks-") as shared:
            self.repository.git("config", "core.hooksPath", shared)
            result = self.repository.run(sys.executable, str(INSTALLER), "--repository", str(self.repository.root))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("outside this repository", result.stdout)
            self.assertFalse((Path(shared) / "pre-commit").exists())

    def test_common_repository_checker_through_installed_hook_and_commit_snapshot(self):
        for quality_script in (PROJECT / "scripts/quality").glob("*.py"):
            self.repository.write("scripts/quality/" + quality_script.name, quality_script.read_text())
        policy = json.loads((PROJECT / ".quality/policy.json").read_text())
        policy["anchor_commit"] = "EMPTY"
        policy["non_code_paths"].append({
            "pattern": "sample.demo", "reason": "Plain text payload consumed only by the isolated snapshot fixture",
        })
        self.repository.write(".quality/policy.json", json.dumps(policy, indent=2) + "\n")
        empty_initial = {"length_caps": {}, "long_lines": [], "naming": []}
        baseline = {
            "schema_version": 1, "anchor_commit": "EMPTY", "initial": empty_initial,
            "allowances": empty_initial | {"origins": {}},
        }
        self.repository.write(".quality/baseline.json", json.dumps(baseline, indent=2) + "\n")
        self.repository.write("fixture-spec.md", "Test fixture: Python source limits are 800 lines and 200 codepoints.\n")
        contracts = {"contracts": [{
            "id": "fixture-snapshot", "paths": ["*"], "purpose": "Exercise actual rules on staged snapshots",
            "basis_status": "confirmed", "basis": ["fixture-spec.md"],
            "validation": ["quality_hook_test.py installed-hook integration"],
            "unresolved": ["This fixture does not assert production behavior or semantic naming quality"],
        }]}
        self.repository.write(".quality/change-contracts.json", json.dumps(contracts, indent=2) + "\n")
        self.repository.write("sample.py", "selection_count = 1\n")
        self.repository.git("add", "--all")
        self.assertIn("objective checks completed", self.assert_commit(True).stdout)
        self.repository.write("sample.py", "#" * 201 + "\n")
        self.repository.stage("sample.py")
        self.repository.write("sample.py", "selection_count = 1\n")
        self.assertIn("201", self.assert_commit(False).stdout)
        self.repository.write("sample.py", "selection_count = 2\n")
        self.repository.stage("sample.py")
        self.repository.write("sample.py", "#" * 201 + "\n")
        self.assert_commit(True)
        base = self.repository.git("rev-parse", "HEAD").stdout.strip()
        self.repository.stage("sample.py")
        self.repository.git("-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "invalid candidate")
        committed = self.repository.run(
            sys.executable, str(SNAPSHOT), "--repository", str(self.repository.root),
            "--commit", "HEAD", "--base", base,
        )
        self.assertNotEqual(committed.returncode, 0)
        self.assertIn("201", committed.stdout)
        self.repository.write(".quality/fixture-policy.json", '{"trigger": "full scan"}\n')
        self.repository.stage(".quality/fixture-policy.json")
        self.assertIn("201", self.assert_commit(False).stdout)
        self.repository.git("-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "confirmed control fixture")
        self.repository.git("mv", ".quality/fixture-policy.json", "fixture-policy.json")
        self.assertIn("sample.py:1: line has 201 codepoints", self.assert_commit(False).stdout)

    def test_improved_legacy_file_requires_persistent_ratchet_before_commit(self):
        self.repository.git("rm", "--force", "sample.demo")
        self.repository.write("legacy_rules.py", "pass\n" * 850)
        self.repository.stage("legacy_rules.py")
        self.repository.git("-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "confirmed legacy seed")
        anchor = self.repository.git("rev-parse", "HEAD").stdout.strip()
        for quality_script in (PROJECT / "scripts/quality").glob("*.py"):
            self.repository.write("scripts/quality/" + quality_script.name, quality_script.read_text())
        policy = json.loads((PROJECT / ".quality/policy.json").read_text())
        policy["anchor_commit"] = anchor
        self.repository.write(".quality/policy.json", json.dumps(policy, indent=2) + "\n")
        self.repository.write("fixture-spec.md", "Fixture: preserve legacy 850 lines, persist 840, then reject 845.\n")
        contracts = {"contracts": [{
            "id": "fixture-persistent-ratchet", "paths": ["*"],
            "purpose": "Persist reductions of confirmed legacy exceptions before accepting the commit",
            "basis_status": "confirmed", "basis": ["fixture-spec.md"],
            "validation": ["Installed hook: 850 kept, 840 ratcheted, 845 rejected"],
            "unresolved": ["Fixture establishes length policy only, not domain behavior"],
        }]}
        self.repository.write(".quality/change-contracts.json", json.dumps(contracts, indent=2) + "\n")
        inventory_program = """import json
from pathlib import Path
import sys
sys.path.insert(0, 'scripts/quality')
from file_policy import inventory_baseline
from repository_content import committed_files
root = Path.cwd()
policy = json.loads((root / '.quality/policy.json').read_text())
baseline = inventory_baseline(committed_files(root, policy['anchor_commit']), policy)
(root / '.quality/baseline.json').write_text(json.dumps(baseline, indent=2) + '\\n')
"""
        generated = self.repository.run(sys.executable, "-c", inventory_program)
        self.assertEqual(generated.returncode, 0, generated.stdout)
        baseline_path = self.repository.root / ".quality/baseline.json"
        initial_baseline = json.loads(baseline_path.read_text())
        self.assertEqual(initial_baseline["initial"]["length_caps"], {"legacy_rules.py": 850})
        self.assertEqual(initial_baseline["allowances"]["length_caps"]["legacy_rules.py"], {
            "origin": "legacy_rules.py", "cap": 850,
        })
        self.repository.git("add", "--all")
        self.assert_commit(True)
        self.repository.write("legacy_rules.py", "pass\n" * 840)
        self.repository.stage("legacy_rules.py")
        refused = self.assert_commit(False)
        self.assertIn("run bun run quality:ratchet and stage its diff", refused.stdout)
        self.assertEqual(json.loads(baseline_path.read_text()), initial_baseline)
        tightened = self.repository.run(
            sys.executable, "scripts/quality/check_repository.py", "--root", ".", "--ratchet",
        )
        self.assertEqual(tightened.returncode, 0, tightened.stdout)
        tightened_baseline = json.loads(baseline_path.read_text())
        self.assertEqual(tightened_baseline["initial"], initial_baseline["initial"])
        self.assertEqual(tightened_baseline["allowances"]["length_caps"]["legacy_rules.py"], {
            "origin": "legacy_rules.py", "cap": 840,
        })
        self.repository.stage(".quality/baseline.json")
        self.assert_commit(True)
        self.repository.write("legacy_rules.py", "pass\n" * 845)
        self.repository.stage("legacy_rules.py")
        self.assertIn("file has 845 lines; allowed 840", self.assert_commit(False).stdout)


if __name__ == "__main__":
    unittest.main()
