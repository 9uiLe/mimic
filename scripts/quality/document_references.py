from __future__ import annotations

import re


_COUNT_PATHS = frozenset({
    "guideline/design-system.md", "guideline/knowledge-view.md", "guideline/development.md",
    "scripts/pages-design.ts",
})
_CATALOG_TOTAL = re.compile(r"\d+件の一覧|全\d+件の知識|収録している\d+件から、名前で探せます")
_KNOWLEDGE_LINK = re.compile(r"\[[^\]]+\]\([^\s)]*KNOWLEDGE\.md(?:#[^\s)]*)?\)")
_SEMVER = re.compile(
    r"(?P<ticks>`*)\s*(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"
    r"(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?\s*(?P=ticks)"
)
_INLINE_CODE = re.compile(r"(?<!`)(`+)(?!`).*?(?<!`)\1(?!`)")
_FENCE_OPEN = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")


def _prose_lines(text: str, markdown: bool):
    frontmatter = False
    fence = None
    for number, line in enumerate(text.splitlines(), 1):
        if markdown:
            if number == 1 and line == "---":
                frontmatter = True
                continue
            if frontmatter:
                if line in ("---", "..."):
                    frontmatter = False
                continue
            if fence is not None:
                if re.fullmatch(r" {0,3}" + re.escape(fence[0]) + "{" + str(len(fence)) + r",}\s*", line):
                    fence = None
                continue
            opening = _FENCE_OPEN.fullmatch(line)
            if opening and (opening[1][0] == "~" or "`" not in opening[2]):
                fence = opening[1]
                continue
        yield number, line


def validate_document_references(candidate: dict[str, bytes]) -> list[str]:
    diagnostics = []
    for source_path, content in sorted(candidate.items()):
        check_total = source_path in _COUNT_PATHS
        check_version = source_path.startswith("topics/") and source_path.endswith(".md")
        if not (check_total or check_version):
            continue
        try:
            text = content.decode("utf-8")
        except UnicodeDecodeError:
            diagnostics.append(f"{source_path}:1: document-reference: cannot read UTF-8; restore readable source")
            continue
        for number, line in _prose_lines(text, source_path.endswith(".md")):
            total_text = _INLINE_CODE.sub("", line) if source_path.endswith(".md") else line
            if check_total and _CATALOG_TOTAL.search(total_text):
                diagnostics.append(
                    f"{source_path}:{number}: document-reference: copied catalog total; "
                    "use 知識の一覧 or link to scripts/pages-catalog.ts instead"
                )
            cells = line.strip().strip("|").split("|")
            if check_version and len(cells) > 1 and _KNOWLEDGE_LINK.search(line) and any(
                _SEMVER.fullmatch(cell.strip()) for cell in cells
            ):
                diagnostics.append(
                    f"{source_path}:{number}: document-reference: copied knowledge version; "
                    "remove the version cell and refer readers to the linked 本文の先頭"
                )
    return diagnostics
