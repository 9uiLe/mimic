"""Behavior checks for fixed-origin limits, ratchets, moves, and narrow naming."""

from __future__ import annotations

import copy
import importlib.util
import json
from pathlib import Path
import unittest


PROJECT_ROOT = Path(__file__).resolve().parents[1]
POLICY_MODULE_PATH = PROJECT_ROOT / "scripts/quality/file_policy.py"
MODULE_SPEC = importlib.util.spec_from_file_location("quality_file_policy", POLICY_MODULE_PATH)
assert MODULE_SPEC is not None and MODULE_SPEC.loader is not None
file_policy = importlib.util.module_from_spec(MODULE_SPEC)
MODULE_SPEC.loader.exec_module(file_policy)


class FilePolicyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.policy = json.loads((PROJECT_ROOT / ".quality/policy.json").read_text())
        self.initial = {"domain_rules.py": b"pass\n"}
        self.baseline = file_policy.inventory_baseline(self.initial, self.policy)

    def inspect(self, candidate, initial=None, comparison=None, baseline=None, trusted=None, **options):
        initial = self.initial if initial is None else initial
        comparison = initial if comparison is None else comparison
        baseline = file_policy.inventory_baseline(initial, self.policy) if baseline is None else baseline
        trusted = baseline if trusted is None else trusted
        return file_policy.evaluate_files(candidate, initial, comparison, baseline, trusted, self.policy, **options)

    def test_exact_file_line_boundary(self) -> None:
        self.assertEqual(self.inspect({"domain_rules.py": b"pass\n" * 800}), [])
        failures = self.inspect({"domain_rules.py": b"pass\n" * 801})
        self.assertIn("file has 801 lines; allowed 800", "\n".join(failures))

    def test_exact_unicode_codepoint_boundary_and_line_endings(self) -> None:
        passing_line = ("#" + "温" * 199).encode()
        failing_line = ("#" + "温" * 200).encode()
        self.assertEqual(self.inspect({"domain_rules.py": passing_line + b"\r\n"}), [])
        self.assertIn("201 codepoints", "\n".join(self.inspect({"domain_rules.py": failing_line + b"\r\n"})))
        self.assertEqual(file_policy.source_lines(b"a\r\nb\n", "sample.py"), ["a", "b"])
        self.assertEqual(file_policy.source_lines(b"", "sample.py"), [])
        self.assertEqual(file_policy.source_lines("#\u2028x\n".encode(), "sample.py"), ["#\u2028x"])

    def test_legacy_file_maintain_improve_worsen_and_regrow(self) -> None:
        initial = {"domain_rules.py": b"pass\n" * 900}
        self.assertEqual(self.inspect(initial, initial=initial), [])
        improved = {"domain_rules.py": b"pass\n" * 850}
        self.assertEqual(self.inspect(improved, initial=initial), [])
        self.assertTrue(self.inspect({"domain_rules.py": b"pass\n" * 901}, initial=initial))
        failures = self.inspect({"domain_rules.py": b"pass\n" * 851}, initial=initial, comparison=improved)
        self.assertIn("allowed 850", "\n".join(failures))
        ordinary = {"domain_rules.py": b"pass\n" * 800}
        self.assertIn("allowed 800", "\n".join(self.inspect(improved, initial=initial, comparison=ordinary)))

    def test_later_committed_violation_is_not_a_new_exception(self) -> None:
        broken = {"domain_rules.py": b"pass\n" * 801}
        self.assertTrue(self.inspect(broken, comparison=broken))

    def test_file_cap_tightening_cannot_be_undone_by_baseline(self) -> None:
        initial = {"domain_rules.py": b"pass\n" * 900}
        original_baseline = file_policy.inventory_baseline(initial, self.policy)
        improved = {"domain_rules.py": b"pass\n" * 850}
        tightened = file_policy.tighten_baseline(improved, original_baseline, self.policy)
        self.assertEqual(tightened["allowances"]["length_caps"]["domain_rules.py"]["cap"], 850)
        self.assertEqual(original_baseline["allowances"]["length_caps"]["domain_rules.py"]["cap"], 900)
        with self.assertRaisesRegex(file_policy.PolicyError, "relaxes"):
            self.inspect(improved, initial=initial, comparison=improved, baseline=original_baseline, trusted=tightened)
        ordinary = {"domain_rules.py": b"pass\n" * 800}
        self.assertEqual(file_policy.tighten_baseline(ordinary, tightened, self.policy)["allowances"]["length_caps"], {})

    def test_legacy_line_may_move_but_copy_cannot_multiply_exception(self) -> None:
        long_line = b"#" + b"x" * 200 + b"\n"
        initial = {"domain_rules.py": long_line + b"pass\n"}
        self.assertEqual(self.inspect(initial, initial=initial), [])
        self.assertEqual(self.inspect({"domain_rules.py": b"pass\n" + long_line}, initial=initial), [])
        moved = {"domain_rules.py": b"pass\n", "domain_notes.py": long_line}
        self.assertEqual(self.inspect(moved, initial=initial), [])
        copied = {**initial, "domain_notes.py": long_line}
        self.assertTrue(self.inspect(copied, initial=initial))
        changed = {"domain_rules.py": long_line.rstrip() + b"z\n"}
        self.assertTrue(self.inspect(changed, initial=initial))

    def test_fixed_long_line_cannot_reappear(self) -> None:
        initial = {"domain_rules.py": b"#" + b"x" * 200 + b"\n"}
        improved = {"domain_rules.py": b"pass\n"}
        self.assertTrue(self.inspect(initial, initial=initial, comparison=improved))
        original_baseline = file_policy.inventory_baseline(initial, self.policy)
        tightened = file_policy.tighten_baseline(improved, original_baseline, self.policy)
        with self.assertRaisesRegex(file_policy.PolicyError, "relaxes"):
            self.inspect(initial, initial=initial, baseline=original_baseline, trusted=tightened)

    def test_rename_retains_cap_and_naming_copy_does_not(self) -> None:
        initial = {"domain_rules.py": b"data = 1\n" + b"pass\n" * 800}
        renamed = {"renamed_domain.py": initial["domain_rules.py"]}
        renames = {"renamed_domain.py": "domain_rules.py"}
        self.assertEqual(self.inspect(renamed, initial=initial, renames=renames), [])
        self.assertTrue(self.inspect(renamed, initial=initial))
        self.assertTrue(self.inspect({**initial, **renamed}, initial=initial))
        original_baseline = file_policy.inventory_baseline(initial, self.policy)
        tightened = file_policy.tighten_baseline(renamed, original_baseline, self.policy, renames=renames)
        self.assertEqual(file_policy.tighten_baseline(renamed, tightened, self.policy, renames=renames), tightened)
        self.assertEqual(self.inspect(renamed, initial=initial, comparison=renamed, baseline=tightened), [])
        second_rename = {"final_domain.py": renamed["renamed_domain.py"]}
        self.assertEqual(self.inspect(
            second_rename, initial=initial, comparison=renamed, baseline=tightened,
            renames={"final_domain.py": "renamed_domain.py"},
        ), [])

    def test_names_are_declarations_not_strings_or_external_properties(self) -> None:
        self.assertEqual(self.inspect({"domain_rules.py": b"domain_record = {'data': 1}\n"}), [])
        self.assertTrue(self.inspect({"domain_rules.py": b"data = 1\n"}))
        self.assertTrue(self.inspect({"domain_rules.py": b"def calculate_price(tmp2):\n    return tmp2\n"}))
        self.assertTrue(self.inspect({"utils.py": b"pass\n"}))
        self.assertEqual(self.inspect({"order_pricing.py": b"order_total = 80\n"}), [])
        initial = {"domain_rules.py": b"data = 1\n"}
        self.assertEqual(self.inspect(initial, initial=initial), [])
        self.assertTrue(self.inspect({"domain_rules.py": b"data = 1\ndef calculate_price(data):\n    return data\n"}, initial=initial))

    def test_legacy_filename_is_not_exempt_after_a_rename(self) -> None:
        initial = {"utils.py": b"pass\n"}
        self.assertEqual(self.inspect(initial, initial=initial), [])
        failures = self.inspect(
            {"nested/utils.py": b"pass\n"}, initial=initial, renames={"nested/utils.py": "utils.py"},
        )
        self.assertIn("prohibited filename name 'utils'", "\n".join(failures))
        self.assertEqual(self.inspect(
            {"order_pricing.py": b"pass\n"}, initial=initial, renames={"order_pricing.py": "utils.py"},
        ), [])
        renamed = {"nested/utils.py": b"pass\n"}
        baseline = file_policy.inventory_baseline(initial, self.policy)
        tightened = file_policy.tighten_baseline(renamed, baseline, self.policy, {"nested/utils.py": "utils.py"})
        self.assertTrue(self.inspect(renamed, initial=initial, comparison=renamed, baseline=tightened))

    def test_legacy_identifier_count_cannot_exempt_a_replacement_declaration(self) -> None:
        initial = {"domain_rules.py": b"data = legacy_orders\n"}
        moved = {"domain_rules.py": b"# moved without changing the declaration\ndata = legacy_orders\n"}
        self.assertEqual(self.inspect(moved, initial=initial), [])
        replaced = {"domain_rules.py": b"data = customer_prices\n"}
        self.assertIn("name 'data'", "\n".join(self.inspect(replaced, initial=initial)))
        new_scope = {"domain_rules.py": b"def price_order():\n    data = legacy_orders\n"}
        self.assertTrue(self.inspect(new_scope, initial=initial))
        initial_ts = {"order-pricing.ts": b"const data = legacyOrders;\n"}
        replaced_ts = {"order-pricing.ts": b"const data = customerPrices;\n"}
        self.assertIn("name 'data'", "\n".join(self.inspect(replaced_ts, initial=initial_ts)))
        baseline = file_policy.inventory_baseline(initial, self.policy)
        tightened = file_policy.tighten_baseline(replaced, baseline, self.policy)
        self.assertEqual(tightened["allowances"]["naming"], [])
        self.assertEqual(file_policy.tighten_baseline(replaced, tightened, self.policy), tightened)

    def test_python_imports_and_patterns_check_local_bindings_without_renaming_external_fields(self) -> None:
        prohibited_bindings = (
            b"from external_api import data\n",
            b"import data\n",
            b"import data.sources\n",
            b"match order_record:\n    case data:\n        pass\n",
            b"match order_record:\n    case [*data]:\n        pass\n",
            b"match order_record:\n    case {'price': order_price, **data}:\n        pass\n",
        )
        for source_text in prohibited_bindings:
            with self.subTest(source=source_text):
                self.assertIn("name 'data'", "\n".join(self.inspect({"domain_rules.py": source_text})))
        compatible_sources = (
            b"from external_api import data as order_record\n",
            b"import data as order_api\n",
            b"match order_record:\n    case {'data': order_price}:\n        pass\n",
        )
        for source_text in compatible_sources:
            with self.subTest(source=source_text):
                self.assertEqual(self.inspect({"domain_rules.py": source_text}), [])

    def test_unknown_file_types_need_an_explicit_classification(self) -> None:
        with self.assertRaisesRegex(file_policy.PolicyError, "Unclassified repository path.*price_rules.rb"):
            self.inspect({**self.initial, "price_rules.rb": b"#" + b"x" * 200 + b"\n"})
        self.assertEqual(self.inspect({**self.initial, "LICENSE": b"MIT\n", ".gitignore": b"node_modules/\n"}), [])

    def test_no_new_baseline_entries_and_unreadable_sources_fail_closed(self) -> None:
        forged = copy.deepcopy(self.baseline)
        forged["allowances"]["length_caps"]["domain_rules.py"] = {"origin": "domain_rules.py", "cap": 999}
        with self.assertRaisesRegex(file_policy.PolicyError, "Unfounded"):
            self.inspect(self.initial, baseline=forged)
        with self.assertRaisesRegex(file_policy.PolicyError, "unexpectedly empty"):
            self.inspect({"notes.md": b"not code"})
        with self.assertRaisesRegex(file_policy.PolicyError, "UTF-8"):
            self.inspect({"domain_rules.py": b"\xff"})
        with self.assertRaisesRegex(file_policy.PolicyError, "Cannot parse Python"):
            self.inspect({"domain_rules.py": b"def broken(\n"})

    def test_selected_path_check_reads_full_file_and_counts_unselected_legacy_lines(self) -> None:
        initial = {"domain_rules.py": b"#" + b"x" * 200 + b"\n", "price_rules.py": b"pass\n"}
        candidate = {**initial, "price_rules.py": initial["domain_rules.py"]}
        failures = self.inspect(candidate, initial=initial, changed_paths={"price_rules.py"})
        self.assertIn("price_rules.py:1", "\n".join(failures))
        self.assertTrue(self.inspect({**self.initial, "price_rules.py": b"pass\n" * 801}, changed_paths={"price_rules.py"}))

    def test_typescript_uses_ast_for_binding_patterns_and_ignores_properties(self) -> None:
        self.assertEqual(self.inspect({"price-rules.ts": b"const orderRecord = { data: 1 };\n"}), [])
        failures = self.inspect({"price-rules.ts": b"const { data } = { data: 1 };\n"})
        self.assertIn("prohibited variable name 'data'", "\n".join(failures))
        self.assertEqual(self.inspect({"price-rules.ts": b"const { data: orderRecord } = { data: 1 };\n"}), [])
        for declaration in (
            b"const priceCalculator = function data() { return 80; };\n",
            b"import data from 'external-api';\n",
            b"import { data } from 'external-api';\n",
            b"import * as data from 'external-api';\n",
            b"import data = require('external-api');\n",
            b"function calculatePrice<data>(price: data) { return price; }\n",
        ):
            self.assertIn("name 'data'", "\n".join(self.inspect({"price-rules.ts": declaration})))
        self.assertEqual(self.inspect({"price-rules.ts": b"import { data as orderRecord } from 'external-api';\n"}), [])
        self.assertEqual(self.inspect({"price-rules.ts": b"import orderRecord from 'external-api';\n"}), [])

    def test_generated_html_exclusion_is_limited_and_hooks_are_included(self) -> None:
        long_line = b"#" + b"x" * 200 + b"\n"
        self.assertTrue(self.inspect({**self.initial, ".githooks/pre-commit": long_line}))
        self.assertTrue(self.inspect({**self.initial, "examples/handwritten.html": long_line}))
        generated = {**self.initial, "prototypes/decision-material-selection/index.html": long_line}
        self.assertEqual(self.inspect(generated), [])

    def test_initial_commit_has_no_legacy_exemptions(self) -> None:
        self.assertEqual(self.inspect({"domain_rules.py": b"pass\n"}, initial={}, comparison={}), [])
        self.assertTrue(self.inspect({"domain_rules.py": b"pass\n" * 801}, initial={}, comparison={}))


if __name__ == "__main__":
    unittest.main()
