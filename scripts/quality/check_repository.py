#!/usr/bin/env python3
"""Apply one fixed-origin policy to full working, staged, or committed content."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

from change_review import criteria_changes, is_control, policy_regressions, validate_contracts
from file_policy import PolicyError, evaluate_files, load_policy, target_paths, tighten_baseline, validate_baseline
from index_snapshot import SnapshotError, comparison_base
from repository_content import ContentError, committed_files, snapshot_files, working_changes, working_files


def json_object(content: bytes | None, label: str) -> dict | None:
    if content is None:
        return None
    parsed = json.loads(content)
    if not isinstance(parsed, dict):
        raise PolicyError(f"Expected a JSON object: {label}")
    return parsed


def inspect_repository(arguments: argparse.Namespace) -> int:
    root = Path(arguments.root).resolve()
    repository = Path(arguments.repository or arguments.root).resolve()
    base = comparison_base(repository, arguments.base)
    candidate = working_files(root) if arguments.mode == "full" else snapshot_files(root)
    comparison = committed_files(repository, base)
    policy = load_policy(root)
    for limit in policy["limits"].values():
        if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1:
            raise PolicyError("File limits must be positive integers")
    original = committed_files(repository, policy["anchor_commit"])
    baseline = json_object(candidate.get(".quality/baseline.json"), "candidate baseline")
    if baseline is None:
        raise PolicyError("Required baseline is missing from the candidate content")
    previous_baseline = json_object(comparison.get(".quality/baseline.json"), "comparison baseline")
    previous_policy = json_object(comparison.get(".quality/policy.json"), "comparison policy")
    changes = (
        json.loads(Path(arguments.changes).read_text(encoding="utf-8"))
        if arguments.changes else working_changes(repository, base, candidate)
    )
    changed_paths = set(changes["paths"])
    renames = changes["renames"]
    changed_paths.update(renames.values())
    selected = None if arguments.mode != "staged" or any(is_control(path) for path in changed_paths) else changed_paths
    targets = set(target_paths(candidate, policy))
    diagnostics = policy_regressions(policy, previous_policy)
    validate_baseline(baseline, original, policy, previous_baseline)
    tightened = tighten_baseline(candidate, baseline, policy, renames)
    if arguments.ratchet:
        if arguments.mode != "full":
            raise PolicyError("Baseline tightening is an explicit working-tree command, never a hook action")
        if diagnostics:
            raise PolicyError("Cannot tighten using relaxed policy: " + "; ".join(diagnostics))
        (root / ".quality/baseline.json").write_text(
            json.dumps(tightened, ensure_ascii=False, indent=2) + "\n", encoding="utf-8",
        )
        baseline = tightened
        print("Updated baseline only toward fewer exceptions and smaller caps; stage and review the diff.")
    elif tightened != baseline:
        diagnostics.append("Improved or renamed legacy allowances must persist: run bun run quality:ratchet and stage its diff")
    diagnostics.extend(evaluate_files(
        candidate, original, comparison, baseline, previous_baseline, policy, selected, renames,
    ))
    changed_sources = changed_paths & targets
    diagnostics.extend(validate_contracts(candidate, changed_sources))
    review_records = criteria_changes(candidate, comparison, list(changed_paths))
    initial = baseline["initial"]
    report = {
        "mode": arguments.mode,
        "comparison_commit": base,
        "original_commit": policy["anchor_commit"],
        "target_files": len(targets),
        "checked_files": len(targets if selected is None else targets & selected),
        "legacy_file_caps": len(initial["length_caps"]),
        "legacy_long_lines": len(initial["long_lines"]),
        "legacy_naming_records": len(initial["naming"]),
        "criteria_changes": review_records,
        "violations": diagnostics,
        "semantic_verdict": "not-automatically-approved",
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if arguments.report:
        report_path = Path(arguments.report)
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if diagnostics:
        for diagnostic in diagnostics:
            print(f"FAIL: {diagnostic}", file=sys.stderr)
        return 1
    if not changed_sources and selected is not None:
        print("PASS: no changed code targets; required policy and baseline were still inspected.")
    else:
        print("PASS: objective checks completed. Criteria/test diffs still require evidence review.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=".")
    parser.add_argument("--repository")
    parser.add_argument("--base")
    parser.add_argument("--mode", choices=("full", "staged", "commit"), default="full")
    parser.add_argument("--changes")
    parser.add_argument("--ratchet", action="store_true")
    parser.add_argument("--report")
    arguments = parser.parse_args()
    try:
        return inspect_repository(arguments)
    except KeyboardInterrupt:
        print("quality check interrupted; no worktree or index edits were made by inspection", file=sys.stderr)
        return 130
    except (PolicyError, ContentError, SnapshotError, OSError, ValueError, KeyError, TypeError) as error:
        print(f"quality check could not run: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
