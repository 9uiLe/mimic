from __future__ import annotations

from pathlib import Path
import sys
import unittest


PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT / "scripts/quality"))
from document_references import validate_document_references


class DocumentReferenceTests(unittest.TestCase):
    def check(self, path: str, text: str) -> list[str]:
        return validate_document_references({path: text.encode("utf-8")})

    def test_copied_catalog_totals_are_rejected_at_the_source_line(self):
        examples = (
            ("guideline/design-system.md", "名前が分かる人には31件の一覧も残す。"),
            ("guideline/knowledge-view.md", "全34件の知識の一覧です。"),
            ("guideline/development.md", "全３４件の知識を読めます。"),
            ("scripts/pages-design.ts", '<p>収録している31件から、名前で探せます。</p>'),
        )
        for path, text in examples:
            with self.subTest(path=path):
                diagnostics = self.check(path, "冒頭\n\n" + text + "\n")
                self.assertEqual(len(diagnostics), 1)
                self.assertTrue(diagnostics[0].startswith(path + ":3:"), diagnostics)
                self.assertIn("copied catalog total", diagnostics[0])
                self.assertIn("知識の一覧", diagnostics[0])
                self.assertIn("pages-catalog.ts", diagnostics[0])

    def test_old_and_current_knowledge_version_cells_are_both_rejected(self):
        for version in ("1.0.0", "9.8.7", "2.0.0-rc.1+build.5", "`1.0.0`", "`` 9.8.7 ``"):
            with self.subTest(version=version):
                diagnostics = self.check("topics/nested/guide.md", (
                    "# 案内\n\n| 読む本文 | 版 |\n| --- | --- |\n"
                    f"| [概念](../../knowledge/example/KNOWLEDGE.md#定義) | {version} |\n"
                ))
                self.assertEqual(len(diagnostics), 1)
                self.assertTrue(diagnostics[0].startswith("topics/nested/guide.md:5:"), diagnostics)
                self.assertIn("copied knowledge version", diagnostics[0])
                self.assertIn("本文の先頭", diagnostics[0])
        self.assertEqual(len(self.check(
            "topics/guide.md", "[概念](../knowledge/example/KNOWLEDGE.md) | 1.0.0\n"
        )), 1)

    def test_references_subsets_and_other_versions_remain_allowed(self):
        self.assertEqual(self.check("guideline/knowledge-view.md", (
            "知識の一覧を参照します。明示した34概念と照合します。\n"
            "7つの疑問と、関連4概念へ案内します。\n"
            "`31件の一覧`と``全34件の知識``はコード例です。\n"
        )), [])
        self.assertEqual(self.check("topics/guide.md", (
            "| [概念](../knowledge/example/KNOWLEDGE.md) | 本文の先頭で確認 |\n"
            "| Bun | 1.4.2 |\n"
            "| [ツール](https://example.com/tool) | 1.0.0 |\n"
            "| [補足](../knowledge/example/examples/tool.md) | 1.0.0 |\n"
            "| [概念](../knowledge/example/KNOWLEDGE.md) | ツールは1.4.2です |\n"
            "[概念](../knowledge/example/KNOWLEDGE.md)とBun 1.4.2を参照します。\n"
        )), [])

    def test_frontmatter_and_fenced_examples_are_excluded_with_line_numbers_preserved(self):
        copied_row = "| [概念](../knowledge/example/KNOWLEDGE.md) | 1.0.0 |"
        for marker, closing in (("````markdown", "````"), ("~~~markdown", "~~~~")):
            with self.subTest(marker=marker):
                text = "\n".join((
                    "---", 'title: "全31件の知識"', copied_row, "---", marker,
                    "全31件の知識", copied_row, "```", "全31件の知識", closing,
                    "全31件の知識", copied_row, "",
                ))
                total = self.check("guideline/design-system.md", text)
                versions = self.check("topics/guide.md", text)
                self.assertEqual(len(total), 1, total)
                self.assertTrue(total[0].startswith("guideline/design-system.md:11:"), total)
                self.assertEqual(len(versions), 1, versions)
                self.assertTrue(versions[0].startswith("topics/guide.md:12:"), versions)

    def test_inline_code_does_not_hide_prose_or_typescript_totals(self):
        self.assertEqual(len(self.check(
            "guideline/design-system.md", "`31件の一覧`を使わず、全34件の知識と書いた。"
        )), 1)
        self.assertEqual(len(self.check(
            "scripts/pages-design.ts", "const example = `全31件の知識`;"
        )), 1)

    def test_no_targets_and_outside_scope_do_not_require_files(self):
        self.assertEqual(validate_document_references({}), [])
        self.assertEqual(validate_document_references({
            "knowledge/example/KNOWLEDGE.md": b"\xff",
            "topics/example.txt": b"\xff",
            "guideline/README.md": "全31件の知識".encode("utf-8"),
            "tests/fixture.ts": "31件の一覧".encode("utf-8"),
        }), [])

    def test_targeted_utf8_read_errors_fail_closed(self):
        for path in ("guideline/knowledge-view.md", "scripts/pages-design.ts", "topics/guide.md"):
            with self.subTest(path=path):
                diagnostics = validate_document_references({path: b"\xff"})
                self.assertEqual(len(diagnostics), 1)
                self.assertIn(path + ":1:", diagnostics[0])
                self.assertIn("cannot read UTF-8", diagnostics[0])

    def test_current_repository_guidance_uses_references(self):
        paths = [
            PROJECT / "guideline/design-system.md", PROJECT / "guideline/knowledge-view.md",
            PROJECT / "guideline/development.md", PROJECT / "scripts/pages-design.ts",
            *(PROJECT / "topics").rglob("*.md"),
        ]
        candidate = {path.relative_to(PROJECT).as_posix(): path.read_bytes() for path in paths if path.is_file()}
        self.assertEqual(validate_document_references(candidate), [])


if __name__ == "__main__":
    unittest.main()
