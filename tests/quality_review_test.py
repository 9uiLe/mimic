"""Check review gates against the user's fixed criteria and provenance requirements.

These tests cover objective regressions and the presence of traceable evidence.
They do not claim that a nonempty explanation proves a business specification.
"""

from __future__ import annotations

import copy
import importlib.util
import json
from pathlib import Path
import unittest


PROJECT_ROOT = Path(__file__).resolve().parents[1]
REVIEW_MODULE_PATH = PROJECT_ROOT / "scripts/quality/change_review.py"
MODULE_SPEC = importlib.util.spec_from_file_location("quality_change_review", REVIEW_MODULE_PATH)
assert MODULE_SPEC is not None and MODULE_SPEC.loader is not None
change_review = importlib.util.module_from_spec(MODULE_SPEC)
MODULE_SPEC.loader.exec_module(change_review)

EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
ABC_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"


class ReviewPolicyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.trusted = json.loads((PROJECT_ROOT / ".quality/policy.json").read_text())

    def test_identical_policy_has_no_regression(self):
        self.assertEqual(change_review.policy_regressions(copy.deepcopy(self.trusted), self.trusted), [])

    def test_lower_limits_and_broader_inspection_are_allowed(self):
        candidate = copy.deepcopy(self.trusted)
        candidate["limits"]["file_lines"] = 799
        candidate["limits"]["line_codepoints"] = 199
        candidate["code_extensions"].append(".fixture-code")
        candidate["included_paths"].append("bin/domain-runner")
        candidate["excluded_paths"] = []
        candidate["banned_file_stems"].append("misc")
        candidate["banned_identifier_patterns"].append("temporary")
        self.assertEqual(change_review.policy_regressions(candidate, self.trusted), [])

    def test_each_limit_increase_requires_review(self):
        for key, existing in self.trusted["limits"].items():
            with self.subTest(limit=key):
                candidate = copy.deepcopy(self.trusted)
                candidate["limits"][key] = existing + 1
                self.assertEqual(change_review.policy_regressions(candidate, self.trusted), [
                    f"Policy relaxation requires separate review: limit {key}",
                ])

    def test_missing_limit_cannot_remove_enforcement(self):
        candidate = copy.deepcopy(self.trusted)
        del candidate["limits"]["file_lines"]
        self.assertEqual(change_review.policy_regressions(candidate, self.trusted), [
            "Policy relaxation requires separate review: limit file_lines",
        ])

    def test_removing_extensions_or_explicit_paths_requires_review(self):
        reductions = (
            ("code_extensions", "Policy relaxation: inspected code extensions were removed"),
            ("included_paths", "Policy relaxation: explicit code paths were removed"),
        )
        for category, expected in reductions:
            with self.subTest(category=category):
                candidate = copy.deepcopy(self.trusted)
                candidate[category].pop()
                self.assertEqual(change_review.policy_regressions(candidate, self.trusted), [expected])

    def test_new_exclusions_and_naming_exceptions_require_review(self):
        new_entries = {
            "excluded_paths": {"pattern": "scripts/*", "reason": "Proposed broad exclusion"},
            "non_code_paths": {"pattern": "scripts/domain_runner", "reason": "Proposed non-code classification"},
            "identifier_exceptions": {"path": "domain_rules.py", "name": "data", "reason": "Proposed API name"},
            "file_name_exceptions": {"path": "config.py", "reason": "Proposed fixed filename"},
        }
        for category, entry in new_entries.items():
            with self.subTest(category=category):
                candidate = copy.deepcopy(self.trusted)
                candidate[category].append(entry)
                self.assertEqual(change_review.policy_regressions(candidate, self.trusted), [
                    f"Policy relaxation: added or changed {category}",
                ])

    def test_changing_existing_exclusion_reason_stays_visible(self):
        candidate = copy.deepcopy(self.trusted)
        candidate["excluded_paths"][0]["reason"] = "Changed justification needs a new review"
        self.assertEqual(change_review.policy_regressions(candidate, self.trusted), [
            "Policy relaxation: added or changed excluded_paths",
        ])

    def test_changing_non_code_classification_requires_review(self):
        candidate = copy.deepcopy(self.trusted)
        candidate["non_code_paths"][0]["reason"] = "Changed classification justification"
        self.assertEqual(change_review.policy_regressions(candidate, self.trusted), [
            "Policy relaxation: added or changed non_code_paths",
        ])

    def test_fixed_origin_cannot_move(self):
        candidate = copy.deepcopy(self.trusted)
        candidate["anchor_commit"] = "0" * 40
        self.assertEqual(change_review.policy_regressions(candidate, self.trusted), [
            "The fixed original commit cannot be changed as a routine policy update",
        ])

    def test_removing_banned_names_requires_review(self):
        for category in ("banned_file_stems", "banned_identifier_patterns"):
            with self.subTest(category=category):
                candidate = copy.deepcopy(self.trusted)
                candidate[category].pop()
                self.assertEqual(change_review.policy_regressions(candidate, self.trusted), [
                    f"Policy relaxation: removed {category}",
                ])


class ChangeContractTests(unittest.TestCase):
    def setUp(self):
        self.contract = {
            "id": "price-calculation", "paths": ["scripts/order-pricing.py"],
            "purpose": "Return the price specified by the agreed discount rule",
            "basis_status": "confirmed", "basis": ["specification.md#discount"],
            "validation": ["Fixed inputs and expected totals in order-pricing tests"],
            "unresolved": ["Tax and rounding are outside this fixture's scope"],
        }
        self.changed = {"scripts/order-pricing.py"}

    def files_with(self, contracts: list[dict]) -> dict[str, bytes]:
        return {
            ".quality/change-contracts.json": json.dumps({"contracts": contracts}).encode(),
            "specification.md": b"# Discount\nThe agreed fixture specification is recorded here.\n",
            "scripts/order-pricing.py": b"discounted_price = 80\n",
        }

    def test_valid_contract_has_resolvable_basis_and_covers_changed_source(self):
        self.assertEqual(change_review.validate_contracts(self.files_with([self.contract]), self.changed), [])

    def test_missing_basis_fails_even_when_source_is_covered(self):
        contract = copy.deepcopy(self.contract)
        del contract["basis"]
        self.assertEqual(change_review.validate_contracts(self.files_with([contract]), self.changed), [
            "Change contract lacks basis: price-calculation",
        ])

    def test_unknown_basis_source_fails(self):
        contract = copy.deepcopy(self.contract)
        contract["basis"] = ["absent-specification.md#discount"]
        self.assertEqual(change_review.validate_contracts(self.files_with([contract]), self.changed), [
            "Change contract source missing: absent-specification.md#discount",
        ])

    def test_uncovered_changed_source_fails(self):
        changed = self.changed | {"scripts/tax-calculation.py"}
        self.assertEqual(change_review.validate_contracts(self.files_with([self.contract]), changed), [
            "No specification/validation mapping for changed source: scripts/tax-calculation.py",
        ])

    def test_missing_or_unreadable_registry_is_not_success(self):
        for registry in (None, b"{not-json"):
            with self.subTest(registry=registry):
                files = {} if registry is None else {".quality/change-contracts.json": registry}
                failures = change_review.validate_contracts(files, self.changed)
                self.assertEqual(len(failures), 1)
                self.assertTrue(failures[0].startswith("Missing or unreadable change provenance registry:"))

    def test_unsupported_basis_status_cannot_claim_confirmation(self):
        contract = copy.deepcopy(self.contract)
        contract["basis_status"] = "automatically-proven"
        self.assertEqual(change_review.validate_contracts(self.files_with([contract]), self.changed), [
            "Unknown basis status: price-calculation",
        ])

    def test_current_behavior_record_and_explicit_assumption_remain_distinct_states(self):
        for status in ("current-record", "assumption"):
            with self.subTest(status=status):
                contract = copy.deepcopy(self.contract)
                contract["basis_status"] = status
                self.assertEqual(change_review.validate_contracts(self.files_with([contract]), self.changed), [])


class CriteriaChangeReportTests(unittest.TestCase):
    def test_test_and_control_changes_report_fixed_before_after_hashes(self):
        candidate = {"tests/order-pricing.test.ts": b"abc", ".quality/policy.json": b"", "scripts/order.py": b"abc"}
        comparison = {"tests/order-pricing.test.ts": b"", ".quality/policy.json": b"abc", "scripts/order.py": b""}
        self.assertEqual(change_review.criteria_changes(candidate, comparison, list(candidate)), [
            {
                "path": ".quality/policy.json", "before_sha256": ABC_SHA256, "after_sha256": EMPTY_SHA256,
                "judgment": "human-review-required",
            },
            {
                "path": "tests/order-pricing.test.ts", "before_sha256": EMPTY_SHA256, "after_sha256": ABC_SHA256,
                "judgment": "human-review-required",
            },
        ])

    def test_added_deleted_and_unchanged_criteria_are_distinguishable(self):
        candidate = {".githooks/pre-commit": b"abc", "package.json": b""}
        comparison = {".github/workflows/ci.yml": b"abc", "package.json": b""}
        paths = ["package.json", ".githooks/pre-commit", ".github/workflows/ci.yml", ".githooks/pre-commit"]
        self.assertEqual(change_review.criteria_changes(candidate, comparison, paths), [
            {
                "path": ".githooks/pre-commit", "before_sha256": None, "after_sha256": ABC_SHA256,
                "judgment": "human-review-required",
            },
            {
                "path": ".github/workflows/ci.yml", "before_sha256": ABC_SHA256, "after_sha256": None,
                "judgment": "human-review-required",
            },
        ])


if __name__ == "__main__":
    unittest.main()
