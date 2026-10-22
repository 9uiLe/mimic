"""Expose criteria changes and require provenance, without claiming semantic approval."""

from __future__ import annotations

import fnmatch
import hashlib
import json


CONTROL_PATTERNS = (
    ".quality/*", "scripts/quality/*", ".githooks/*", ".github/workflows/*", "package.json", "tsconfig.json",
    "flake.nix", "flake.lock", "bun.lock",
)


def is_control(source_path: str) -> bool:
    return any(fnmatch.fnmatchcase(source_path, pattern) for pattern in CONTROL_PATTERNS)


def is_test(source_path: str) -> bool:
    return source_path.startswith("tests/") or ".test." in source_path or source_path.endswith("_test.py")


def criteria_changes(candidate: dict, comparison: dict, paths: list[str]) -> list[dict]:
    records = []
    for source_path in sorted(set(paths)):
        if not (is_control(source_path) or is_test(source_path)):
            continue
        before = comparison.get(source_path)
        after = candidate.get(source_path)
        if before == after:
            continue
        records.append({
            "path": source_path,
            "before_sha256": hashlib.sha256(before).hexdigest() if before is not None else None,
            "after_sha256": hashlib.sha256(after).hexdigest() if after is not None else None,
            "judgment": "human-review-required",
        })
    return records


def policy_regressions(policy: dict, comparison_policy: dict | None) -> list[str]:
    if comparison_policy is None:
        return []
    findings = []
    if policy["anchor_commit"] != comparison_policy["anchor_commit"]:
        findings.append("The fixed original commit cannot be changed as a routine policy update")
    for key, limit in comparison_policy["limits"].items():
        if policy["limits"].get(key, limit + 1) > limit:
            findings.append(f"Policy relaxation requires separate review: limit {key}")
    if not set(policy["code_extensions"]) >= set(comparison_policy["code_extensions"]):
        findings.append("Policy relaxation: inspected code extensions were removed")
    if not set(policy["included_paths"]) >= set(comparison_policy["included_paths"]):
        findings.append("Policy relaxation: explicit code paths were removed")
    for category in ("excluded_paths", "non_code_paths", "identifier_exceptions", "file_name_exceptions"):
        trusted = {json.dumps(entry, sort_keys=True) for entry in comparison_policy.get(category, [])}
        if any(json.dumps(entry, sort_keys=True) not in trusted for entry in policy.get(category, [])):
            findings.append(f"Policy relaxation: added or changed {category}")
    for category in ("banned_file_stems", "banned_identifier_patterns"):
        if not set(policy[category]) >= set(comparison_policy[category]):
            findings.append(f"Policy relaxation: removed {category}")
    return findings


def validate_contracts(files: dict[str, bytes], changed_sources: set[str]) -> list[str]:
    if not changed_sources:
        return []
    try:
        registry = json.loads(files[".quality/change-contracts.json"])
    except (KeyError, ValueError, UnicodeError) as error:
        return [f"Missing or unreadable change provenance registry: {error}"]
    findings = []
    contracts = registry.get("contracts", [])
    for contract in contracts:
        for field in ("id", "purpose", "basis_status", "basis", "validation", "unresolved"):
            if field not in contract or not contract[field]:
                findings.append(f"Change contract lacks {field}: {contract.get('id', '?')}")
        if contract.get("basis_status") not in ("confirmed", "assumption", "current-record"):
            findings.append(f"Unknown basis status: {contract.get('id', '?')}")
        for basis_path in contract.get("basis", []):
            if basis_path.split("#")[0] not in files:
                findings.append(f"Change contract source missing: {basis_path}")
    for source_path in sorted(changed_sources):
        if not any(
            fnmatch.fnmatchcase(source_path, pattern)
            for contract in contracts for pattern in contract.get("paths", [])
        ):
            findings.append(f"No specification/validation mapping for changed source: {source_path}")
    return findings
