"""Fixed-origin file limits and narrow declaration naming checks.

Inputs are complete Git snapshots supplied by the caller. This module never writes
the index, reads unstaged source files, or changes the baseline automatically.
"""

from __future__ import annotations

import ast
from collections import Counter
import copy
import fnmatch
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess


class PolicyError(RuntimeError):
    """A missing input or failed inspection, never a successful empty result."""


TYPESCRIPT_EXTENSIONS = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"}


def load_policy(root: Path) -> dict:
    try:
        return json.loads((Path(root) / ".quality/policy.json").read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise PolicyError(f"Cannot read quality policy: {error}") from error


def source_lines(content: bytes, source_path: str) -> list[str]:
    try:
        text = content.decode("utf-8", errors="strict")
    except UnicodeError as error:
        raise PolicyError(f"Cannot decode {source_path} as UTF-8: {error}") from error
    # Git source lines use LF, optionally preceded by CR. Other Unicode separators
    # are characters, not extra source lines; a final LF does not create a line.
    if not text:
        return []
    lines = text.split("\n")
    if lines[-1] == "":
        lines.pop()
    return [line[:-1] if line.endswith("\r") else line for line in lines]


def target_paths(files: dict[str, bytes], policy: dict) -> list[str]:
    extensions = set(policy["code_extensions"])
    exclusions = policy["excluded_paths"]
    non_code_paths = policy.get("non_code_paths", [])
    for exclusion in exclusions + non_code_paths:
        if not exclusion.get("pattern") or not exclusion.get("reason", "").strip():
            raise PolicyError("Every excluded path needs a pattern and a reason")
    targets = []
    for source_path in sorted(files):
        if any(fnmatch.fnmatchcase(source_path, entry["pattern"]) for entry in exclusions + non_code_paths):
            continue
        if (PurePosixPath(source_path).suffix.lower() in extensions
                or any(fnmatch.fnmatchcase(source_path, pattern) for pattern in policy.get("included_paths", []))):
            targets.append(source_path)
        else:
            raise PolicyError(
                f"Unclassified repository path {source_path!r}; add its language to code_extensions/included_paths "
                "or document a narrowly scoped non-code classification with a reason"
            )
    if not targets:
        raise PolicyError("No handwritten source files found; inspection target unexpectedly empty")
    return targets


def declaration_inventory(files: dict[str, bytes], policy: dict) -> list[dict]:
    locations = []
    typescript_sources = {}
    for source_path in target_paths(files, policy):
        suffix = PurePosixPath(source_path).suffix.lower()
        source_text = "\n".join(source_lines(files[source_path], source_path))
        if suffix in TYPESCRIPT_EXTENSIONS:
            typescript_sources[source_path] = source_text
        elif suffix == ".py":
            try:
                syntax_tree = ast.parse(source_text, filename=source_path)
            except SyntaxError as error:
                raise PolicyError(f"Cannot parse Python {source_path}: {error}") from error
            parent_nodes = {child: parent for parent in ast.walk(syntax_tree) for child in ast.iter_child_nodes(parent)}
            for declaration in ast.walk(syntax_tree):
                if isinstance(declaration, ast.Name) and isinstance(declaration.ctx, ast.Store):
                    name, kind = declaration.id, "variable"
                elif isinstance(declaration, ast.arg):
                    name, kind = declaration.arg, "parameter"
                elif isinstance(declaration, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                    name, kind = declaration.name, "declaration"
                elif isinstance(declaration, ast.alias) and declaration.asname:
                    name, kind = declaration.asname, "import-alias"
                elif isinstance(declaration, ast.alias) and declaration.name != "*":
                    import_statement = parent_nodes.get(declaration)
                    name = declaration.name.split(".")[0] if isinstance(import_statement, ast.Import) else declaration.name
                    kind = "import-binding"
                elif isinstance(declaration, ast.ExceptHandler) and declaration.name:
                    name, kind = declaration.name, "exception-binding"
                elif isinstance(declaration, (ast.MatchAs, ast.MatchStar)) and declaration.name:
                    name, kind = declaration.name, "pattern-binding"
                elif isinstance(declaration, ast.MatchMapping) and declaration.rest:
                    name, kind = declaration.rest, "pattern-binding"
                else:
                    continue
                context = declaration
                scope_names = []
                ancestor = parent_nodes.get(declaration)
                while ancestor is not None:
                    if isinstance(ancestor, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                        scope_names.append(ancestor.name)
                    if not isinstance(context, ast.stmt):
                        context = ancestor
                    ancestor = parent_nodes.get(ancestor)
                locations.append({
                    "path": source_path, "line": declaration.lineno, "name": name, "kind": kind,
                    "declaration_text": ast.dump(context, include_attributes=False),
                    "scope": "/".join(reversed(scope_names)),
                })
    if typescript_sources:
        locations.extend(_typescript_declarations(typescript_sources, policy))
    return locations


def _typescript_declarations(sources: dict[str, str], policy: dict) -> list[dict]:
    bun_command = shutil.which("bun")
    if not bun_command:
        raise PolicyError("Bun is required for TypeScript declaration inspection; no dependencies are installed by this check")
    helper_path = Path(__file__).with_name("identifier_inventory.ts")
    dependency_root = Path(os.environ.get("QUALITY_DEPENDENCY_ROOT", Path(__file__).resolve().parents[2]))
    payload = {"sources": sources, "dependencyRoot": str(dependency_root), "typescriptVersion": policy["typescript_version"]}
    try:
        inspection = subprocess.run(
            [bun_command, str(helper_path)], input=json.dumps(payload), text=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
        )
    except OSError as error:
        raise PolicyError(f"Cannot execute TypeScript declaration inspection: {error}") from error
    if inspection.returncode != 0:
        raise PolicyError(f"TypeScript declaration inspection failed: {inspection.stderr.strip()}")
    try:
        locations = json.loads(inspection.stdout)
    except json.JSONDecodeError as error:
        raise PolicyError(f"Invalid TypeScript declaration inventory: {error}") from error
    if not isinstance(locations, list):
        raise PolicyError("TypeScript declaration inventory is not a list")
    return locations


def _forbidden_name(name: str, policy: dict) -> bool:
    return any(re.fullmatch(pattern, name) for pattern in policy["banned_identifier_patterns"])


def _identifier_exception(location: dict, policy: dict) -> bool:
    for exception in policy["identifier_exceptions"]:
        if not exception.get("reason", "").strip():
            raise PolicyError("Every identifier exception needs a compatibility reason")
        if exception["path"] == location["path"] and exception["name"] == location["name"]:
            return True
    return False


def _naming_violations(files: dict[str, bytes], policy: dict) -> list[dict]:
    violations = [
        location for location in declaration_inventory(files, policy)
        if _forbidden_name(location["name"], policy) and not _identifier_exception(location, policy)
    ]
    for source_path in target_paths(files, policy):
        if PurePosixPath(source_path).stem not in policy["banned_file_stems"]:
            continue
        matching = [exception for exception in policy["file_name_exceptions"] if exception["path"] == source_path]
        if matching:
            if not all(exception.get("reason", "").strip() for exception in matching):
                raise PolicyError("Every fixed filename exception needs a tool compatibility reason")
            continue
        violations.append({"path": source_path, "line": 1, "name": PurePosixPath(source_path).stem, "kind": "filename"})
    return sorted(violations, key=lambda location: (location["path"], location["line"], location["name"], location["kind"]))


def _naming_key(location: dict) -> tuple:
    return (location["name"], location["kind"], location.get("declaration_text", ""), location.get("scope", ""))


def inventory_baseline(files: dict[str, bytes], policy: dict) -> dict:
    file_limit = policy["limits"]["file_lines"]
    line_limit = policy["limits"]["line_codepoints"]
    length_caps = {}
    long_lines = []
    for source_path in target_paths(files, policy) if files else []:
        lines = source_lines(files[source_path], source_path)
        if len(lines) > file_limit:
            length_caps[source_path] = len(lines)
        for line_number, line_text in enumerate(lines, 1):
            if len(line_text) > line_limit:
                long_lines.append({"path": source_path, "line": line_number, "codepoints": len(line_text), "text": line_text})
    initial = {"length_caps": length_caps, "long_lines": long_lines, "naming": _naming_violations(files, policy) if files else []}
    allowances = copy.deepcopy(initial)
    allowances["length_caps"] = {
        source_path: {"origin": source_path, "cap": count} for source_path, count in length_caps.items()
    }
    allowances["origins"] = {
        entry["path"]: entry["path"] for entry in initial["naming"]
    }
    return {"schema_version": 1, "anchor_commit": policy["anchor_commit"], "initial": initial, "allowances": allowances}


def _validate_baseline(baseline: dict, initial: dict, policy: dict) -> None:
    if baseline.get("schema_version") != 1 or baseline.get("anchor_commit") != policy["anchor_commit"]:
        raise PolicyError("Baseline schema or fixed initial commit does not match the policy")
    if baseline.get("initial") != initial["initial"]:
        raise PolicyError("Baseline initial inventory differs from the fixed initial commit")
    original_caps = initial["initial"]["length_caps"]
    naming_origins = {entry["path"] for entry in initial["initial"]["naming"]}
    active_origins = list(baseline["allowances"].get("origins", {}).values())
    if len(active_origins) != len(set(active_origins)) or not set(active_origins) <= naming_origins:
        raise PolicyError("Baseline invents or duplicates naming origin identities")
    cap_origins = [entry["origin"] for entry in baseline["allowances"]["length_caps"].values()]
    if len(cap_origins) != len(set(cap_origins)):
        raise PolicyError("Baseline duplicates a file cap origin")
    for source_path, allowance in baseline["allowances"]["length_caps"].items():
        origin = allowance["origin"]
        if origin not in original_caps or not (policy["limits"]["file_lines"] < allowance["cap"] <= original_caps[origin]):
            raise PolicyError(f"Unfounded or relaxed file cap: {source_path}")
    for category in ("long_lines", "naming"):
        original_entries = Counter(json.dumps(entry, sort_keys=True) for entry in initial["initial"][category])
        active_entries = Counter(json.dumps(entry, sort_keys=True) for entry in baseline["allowances"][category])
        if active_entries - original_entries:
            raise PolicyError(f"Baseline adds or changes {category} exceptions beyond the fixed initial inventory")


def validate_baseline(
    baseline: dict, initial_files: dict[str, bytes], policy: dict, comparison_baseline: dict | None = None,
) -> None:
    initial = inventory_baseline(initial_files, policy)
    _validate_baseline(baseline, initial, policy)
    if comparison_baseline is None:
        return
    _validate_baseline(comparison_baseline, initial, policy)
    for category in ("long_lines", "naming"):
        active = Counter(json.dumps(entry, sort_keys=True) for entry in baseline["allowances"][category])
        trusted = Counter(json.dumps(entry, sort_keys=True) for entry in comparison_baseline["allowances"][category])
        if active - trusted:
            raise PolicyError(f"Baseline relaxes previously tightened {category} exceptions")
    trusted_origins = set(comparison_baseline["allowances"].get("origins", {}).values())
    if not set(baseline["allowances"].get("origins", {}).values()) <= trusted_origins:
        raise PolicyError("Baseline restores a previously removed naming origin")
    trusted_caps_by_origin = {
        allowance["origin"]: allowance["cap"] for allowance in comparison_baseline["allowances"]["length_caps"].values()
    }
    origins = []
    for source_path, allowance in baseline["allowances"]["length_caps"].items():
        origins.append(allowance["origin"])
        if allowance["cap"] > trusted_caps_by_origin.get(allowance["origin"], policy["limits"]["file_lines"]):
            raise PolicyError(f"Baseline relaxes a previously tightened file cap: {source_path}")
    if len(origins) != len(set(origins)):
        raise PolicyError("Baseline duplicates a file cap origin")


def _long_line_counts(files: dict[str, bytes], policy: dict) -> Counter:
    return Counter(
        line_text for source_path in target_paths(files, policy)
        for line_text in source_lines(files[source_path], source_path)
        if len(line_text) > policy["limits"]["line_codepoints"]
    )


def evaluate_files(
    candidate_files: dict[str, bytes], initial_files: dict[str, bytes], comparison_files: dict[str, bytes],
    baseline: dict, comparison_baseline: dict | None, policy: dict,
    changed_paths: set[str] | None = None, renames: dict[str, str] | None = None,
) -> list[str]:
    """Inspect selected candidate files using full-snapshot counts and fixed origins."""
    renames = renames or {}
    validate_baseline(baseline, initial_files, policy, comparison_baseline)
    candidate_targets = target_paths(candidate_files, policy)
    comparison_targets = set(target_paths(comparison_files, policy)) if comparison_files else set()
    checked_paths = set(candidate_targets) if changed_paths is None else set(candidate_targets) & set(changed_paths)
    diagnostics = []
    file_limit = policy["limits"]["file_lines"]
    active_caps = baseline["allowances"]["length_caps"]
    comparison_caps = (comparison_baseline or baseline)["allowances"]["length_caps"]
    for source_path in sorted(checked_paths):
        line_count = len(source_lines(candidate_files[source_path], source_path))
        old_path = renames.get(source_path, source_path)
        allowance = active_caps.get(source_path) or active_caps.get(old_path)
        trusted_allowance = comparison_caps.get(old_path)
        cap = file_limit
        if allowance and trusted_allowance and old_path in comparison_targets:
            cap = max(file_limit, min(
                allowance["cap"], trusted_allowance["cap"],
                len(source_lines(comparison_files[old_path], old_path)),
            ))
        if line_count > cap:
            diagnostics.append(f"{source_path}: file has {line_count} lines; allowed {cap}")

    permitted_lines = Counter(entry["text"] for entry in baseline["allowances"]["long_lines"])
    trusted_lines = Counter(entry["text"] for entry in (comparison_baseline or baseline)["allowances"]["long_lines"])
    comparison_line_counts = _long_line_counts(comparison_files, policy) if comparison_files else Counter()
    permitted_lines &= trusted_lines & comparison_line_counts
    # Allocate existing allowances to unchanged paths first. This reports the new
    # copy rather than blaming the original line when a duplicate is introduced.
    candidate_line_counts = Counter()
    ordered_paths = sorted(candidate_targets, key=lambda source_path: (source_path in checked_paths, source_path))
    for source_path in ordered_paths:
        for line_number, line_text in enumerate(source_lines(candidate_files[source_path], source_path), 1):
            if len(line_text) <= policy["limits"]["line_codepoints"]:
                continue
            candidate_line_counts[line_text] += 1
            if source_path in checked_paths and candidate_line_counts[line_text] > permitted_lines[line_text]:
                diagnostics.append(
                    f"{source_path}:{line_number}: line has {len(line_text)} codepoints; "
                    f"allowed {policy['limits']['line_codepoints']} (no legacy allowance)"
                )

    previous_naming = _naming_violations(comparison_files, policy) if comparison_files else []
    active_naming = baseline["allowances"]["naming"]
    trusted_naming = (comparison_baseline or baseline)["allowances"]["naming"]
    candidate_naming = _naming_violations({source_path: candidate_files[source_path] for source_path in checked_paths}, policy) if checked_paths else []
    for source_path in sorted(checked_paths):
        old_path = renames.get(source_path, source_path)
        naming_origin = baseline["allowances"].get("origins", {}).get(source_path)
        if naming_origin is None:
            naming_origin = baseline["allowances"].get("origins", {}).get(old_path, old_path)
        trusted_origin = (comparison_baseline or baseline)["allowances"].get("origins", {}).get(old_path, old_path)
        def naming_counts(locations: list[dict], location_path: str) -> Counter:
            return Counter(_naming_key(entry) for entry in locations if entry["path"] == location_path)
        allowed = naming_counts(active_naming, naming_origin) & naming_counts(trusted_naming, trusted_origin)
        allowed &= naming_counts(previous_naming, old_path)
        observed = Counter()
        for location in (entry for entry in candidate_naming if entry["path"] == source_path):
            identity = _naming_key(location)
            observed[identity] += 1
            renamed_forbidden_file = location["kind"] == "filename" and source_path != naming_origin
            if renamed_forbidden_file or observed[identity] > allowed[identity]:
                diagnostics.append(
                    f"{source_path}:{location['line']}: prohibited {location['kind']} name {location['name']!r}; "
                    "use a name for the value, purpose, or domain role"
                )
    return diagnostics


def tighten_baseline(
    files: dict[str, bytes], baseline: dict, policy: dict, renames: dict[str, str] | None = None,
) -> dict:
    """Return only smaller allowances; never invent new exceptions or mutate inputs."""
    tightened = copy.deepcopy(baseline)
    renames = renames or {}
    old_to_new = {old_path: new_path for new_path, old_path in renames.items()}
    if len(old_to_new) != len(renames):
        raise PolicyError("A rename origin cannot be reused by multiple destinations")
    target_set = set(target_paths(files, policy))
    caps = {}
    for old_path, allowance in baseline["allowances"]["length_caps"].items():
        source_path = old_to_new.get(old_path, old_path)
        if source_path not in target_set:
            continue
        cap = min(allowance["cap"], len(source_lines(files[source_path], source_path)))
        if cap > policy["limits"]["file_lines"]:
            caps[source_path] = {"origin": allowance["origin"], "cap": cap}
    tightened["allowances"]["length_caps"] = caps
    tightened["allowances"]["origins"] = {
        old_to_new.get(source_path, source_path): origin
        for source_path, origin in baseline["allowances"].get("origins", {}).items()
        if old_to_new.get(source_path, source_path) in target_set
    }
    remaining_lines = _long_line_counts(files, policy)
    retained_lines = []
    for entry in baseline["allowances"]["long_lines"]:
        if remaining_lines[entry["text"]] > 0:
            retained_lines.append(entry)
            remaining_lines[entry["text"]] -= 1
    tightened["allowances"]["long_lines"] = retained_lines
    current_naming = Counter((entry["path"], _naming_key(entry)) for entry in _naming_violations(files, policy))
    retained_names = []
    origin_to_path = {origin: source_path for source_path, origin in tightened["allowances"]["origins"].items()}
    for entry in baseline["allowances"]["naming"]:
        source_path = origin_to_path.get(entry["path"], entry["path"])
        identity = (source_path, _naming_key(entry))
        if current_naming[identity] > 0:
            retained_names.append(entry)
            current_naming[identity] -= 1
    tightened["allowances"]["naming"] = retained_names
    return tightened
