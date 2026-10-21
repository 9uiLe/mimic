"""Record user-scoped delegation choices and reserve a finite token budget.

The host performs actual spawning, data isolation and termination. Approval
references are attestations, not authentication of a human or of model output.
"""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import uuid

from model import DataError
import data_policy
import store


ROLES = ("execution", "judgment")


def _object(value, keys: set[str], name: str) -> dict:
    if not isinstance(value, dict) or set(value) != keys:
        raise DataError(f"{name}: use exactly the documented fields")
    return value


def _text(value, name: str) -> str:
    if (not isinstance(value, str) or not value.strip() or len(value) > 256
            or any(ord(char) < 32 for char in value)):
        raise DataError(f"{name}: expected short nonempty text without control characters")
    data_policy.check_text(value, label="Delegation field")
    return value


def _integer(value, name: str, *, zero: bool = False) -> int:
    if type(value) is not int or value < (0 if zero else 1):
        raise DataError(f"{name}: expected {'nonnegative' if zero else 'positive'} integer")
    return value


def _time(value: str) -> datetime:
    try:
        result = datetime.fromisoformat(_text(value, "timestamp").replace("Z", "+00:00"))
        if result.tzinfo is None:
            raise ValueError()
        return result.astimezone(timezone.utc)
    except ValueError as exc:
        raise DataError("Timestamp needs an explicit timezone") from exc


def _digest(value: dict) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, allow_nan=False,
                                    separators=(",", ":")).encode()).hexdigest()


def _directory(root: Path) -> Path:
    if not (root / "journal.json").is_file():
        raise DataError("Initialize a run before recording delegation")
    directory = root / "delegation"
    if directory.is_symlink():
        raise DataError("Delegation storage must not be a symlink")
    directory.mkdir(mode=0o700, exist_ok=True)
    return directory


def _policy(value: dict) -> dict:
    _object(value, {"schema_version", "host", "mode", "approval_reference", "expires_at",
                    "max_parallel", "max_total_tokens", "choices"}, "delegation policy")
    if type(value["schema_version"]) is not int or value["schema_version"] != 1 or value["host"] not in ("codex", "claude"):
        raise DataError("Unsupported policy version or host")
    if value["mode"] not in ("adaptive", "fixed", "disabled"):
        raise DataError("Policy mode is adaptive, fixed or disabled")
    _text(value["approval_reference"], "reference to actual user approval")
    _time(value["expires_at"])
    _integer(value["max_parallel"], "max_parallel")
    _integer(value["max_total_tokens"], "max_total_tokens")
    if not isinstance(value["choices"], list):
        raise DataError("choices must be a list")
    choices = []
    for choice in value["choices"]:
        _object(choice, {"role", "model", "effort"}, "choice")
        if choice["role"] not in ROLES:
            raise DataError("Unsupported delegation role")
        _text(choice["model"], "model")
        _text(choice["effort"], "host effort identifier")
        key = tuple(choice[k] for k in ("role", "model", "effort"))
        if key in choices:
            raise DataError("Duplicate permitted choice")
        choices.append(key)
    if value["mode"] != "disabled" and not choices:
        raise DataError("Enabled delegation needs permitted choices")
    if value["mode"] == "disabled" and choices:
        raise DataError("Disabled delegation has no choices")
    if value["mode"] == "fixed" and len({x[0] for x in choices}) != len(choices):
        raise DataError("Fixed mode permits one model/effort per role")
    return value


def _read(path: Path) -> dict:
    if path.parent.is_symlink():
        raise DataError("Delegation storage must not be a symlink")
    return data_policy.read_json(path, label="Delegation record")


def configure(root: Path, approval: dict) -> dict:
    """Save an already obtained approval; never manufacture it from repo text."""
    data_policy.check_text(json.dumps(approval), label="Delegation approval")
    _policy(approval)
    if _time(approval["expires_at"]) <= datetime.now(timezone.utc):
        raise DataError("Approval is expired")
    with store.mutation(root):
        directory = _directory(root)
        store.write_json(directory / "policy.json", approval)
    return {"configured": True, "mode": approval["mode"], "policy_sha256": _digest(approval),
            "approval_is_attested": True,
            "note": "The host must verify user authorization and enforce its own tool/data permissions."}


def _state(directory: Path) -> dict:
    path = directory / "assignments.json"
    if not path.exists():
        return {"schema_version": 1, "assignments": []}
    value = _read(path)
    _object(value, {"schema_version", "assignments"}, "assignments")
    if type(value["schema_version"]) is not int or value["schema_version"] != 1 or not isinstance(value["assignments"], list):
        raise DataError("Invalid assignment history")
    for assignment in value["assignments"]:
        _object(assignment, {"id", "task_id", "role", "model", "effort", "max_tokens",
                             "max_seconds", "context_sha256", "policy_sha256", "catalog_sha256",
                             "status", "usage"}, "assignment")
        _integer(assignment["max_tokens"], "reserved tokens")
        if assignment["status"] not in ("reserved", "completed"):
            raise DataError("Invalid assignment status")
        if assignment["status"] == "completed":
            _usage(assignment["usage"])
        elif assignment["usage"] is not None:
            raise DataError("Reserved assignment cannot contain reported usage")
    return value


def _charged(assignment: dict) -> int:
    usage = assignment["usage"]
    return (assignment["max_tokens"] if usage is None or usage["total_tokens"] is None
            else usage["total_tokens"])


def status(root: Path) -> dict:
    directory = root / "delegation"
    if directory.is_symlink():
        raise DataError("Delegation storage must not be a symlink")
    if not directory.exists() or not any(directory.iterdir()):
        return {"mode": "disabled", "active": 0, "charged_or_reserved_tokens": 0,
                "note": "No recorded approval; keep the current host settings."}
    approval = _policy(_read(directory / "policy.json"))
    state = _state(directory)
    active = [item for item in state["assignments"] if item["status"] == "reserved"]
    charged = sum(_charged(item) for item in state["assignments"])
    known_costs = [item["usage"]["cost_usd"] for item in state["assignments"]
                   if item["usage"] is not None and item["usage"]["cost_usd"] is not None]
    complete_cost = all(item["usage"] is not None and item["usage"]["cost_usd"] is not None
                        for item in state["assignments"])
    return {"mode": approval["mode"], "active": len(active), "assignments": state["assignments"],
            "charged_or_reserved_tokens": charged, "max_total_tokens": approval["max_total_tokens"],
            "budget_exceeded": charged > approval["max_total_tokens"],
            "cost_usd": sum(known_costs) if complete_cost else None,
            "known_cost_subtotal_usd": sum(known_costs),
            "approval_expired": _time(approval["expires_at"]) <= datetime.now(timezone.utc),
            "limits_enforced_by_host": False}


def reserve(root: Path, request: dict, catalog: dict) -> dict:
    """Check a fresh host catalog and reserve capacity before the host spawns."""
    _object(request, {"task_id", "role", "model", "effort", "max_tokens", "max_seconds",
                      "context_sha256"}, "delegation request")
    if not isinstance(request["task_id"], str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", request["task_id"]):
        raise DataError("Use an opaque task ID, not task content")
    if request["role"] not in ROLES:
        raise DataError("Unsupported role")
    _text(request["model"], "model")
    _text(request["effort"], "host effort identifier")
    _integer(request["max_tokens"], "max_tokens")
    _integer(request["max_seconds"], "max_seconds")
    if not isinstance(request["context_sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", request["context_sha256"]):
        raise DataError("context_sha256 must identify the deliberately scoped input packet")
    _object(catalog, {"schema_version", "host", "observed_at", "source", "models"}, "host catalog")
    if type(catalog["schema_version"]) is not int or catalog["schema_version"] != 1 or catalog["host"] not in ("codex", "claude"):
        raise DataError("Unsupported catalog")
    _text(catalog["source"], "catalog source")
    age = (datetime.now(timezone.utc) - _time(catalog["observed_at"])).total_seconds()
    if not 0 <= age <= 24 * 3600:
        raise DataError("Refresh host capabilities; catalog must be observed within 24 hours")
    if not isinstance(catalog["models"], list):
        raise DataError("models must be a list")
    supported = set()
    for model in catalog["models"]:
        _object(model, {"id", "efforts"}, "catalog model")
        _text(model["id"], "catalog model id")
        if not isinstance(model["efforts"], list) or not model["efforts"]:
            raise DataError("Catalog needs the model's actual supported efforts")
        for effort in model["efforts"]:
            _text(effort, "host effort identifier")
            if (model["id"], effort) in supported:
                raise DataError("Duplicate catalog model/effort")
            supported.add((model["id"], effort))
    if (request["model"], request["effort"]) not in supported:
        raise DataError("The requested model/effort is unavailable; do not silently substitute")
    with store.mutation(root):
        directory = _directory(root)
        if not (directory / "policy.json").exists():
            raise DataError("Obtain user approval before adaptive delegation")
        approval = _policy(_read(directory / "policy.json"))
        if approval["mode"] == "disabled" or _time(approval["expires_at"]) <= datetime.now(timezone.utc):
            raise DataError("Delegation is disabled or approval expired")
        if approval["host"] != catalog["host"]:
            raise DataError("A model approval does not authorize a different host/provider")
        choice = {key: request[key] for key in ("role", "model", "effort")}
        if choice not in approval["choices"]:
            raise DataError("This role/model/effort is outside the user's approved choices")
        state = _state(directory)
        if any(x["task_id"] == request["task_id"] for x in state["assignments"]):
            raise DataError("Task ID already assigned; use a new ID for another attempt")
        if sum(x["status"] == "reserved" for x in state["assignments"]) >= approval["max_parallel"]:
            raise DataError("Approved parallelism is exhausted")
        charged = sum(_charged(x) for x in state["assignments"])
        if charged + request["max_tokens"] > approval["max_total_tokens"]:
            raise DataError("Approved token budget is exhausted or already reserved")
        assignment = {"id": "job-" + uuid.uuid4().hex, **request,
                      "policy_sha256": _digest(approval), "catalog_sha256": _digest(catalog),
                      "status": "reserved", "usage": None}
        state["assignments"].append(assignment)
        store.write_json(directory / "assignments.json", state)
    return {"assignment": assignment, "spawn_performed": False,
            "note": "Use a fresh bounded context and these exact settings in the host; retain the host's permissions."}


def _usage(value: dict) -> dict:
    _object(value, {"total_tokens", "cost_usd", "source"}, "usage")
    _text(value["source"], "usage source")
    if value["total_tokens"] is not None:
        _integer(value["total_tokens"], "actual total_tokens", zero=True)
    cost = value["cost_usd"]
    if cost is not None:
        import math
        if type(cost) not in (int, float) or not math.isfinite(cost) or cost < 0:
            raise DataError("cost_usd must be finite nonnegative or null")
    return value


def complete(root: Path, assignment_id: str, usage: dict) -> dict:
    """Record reported usage once. Unknown usage stays charged at its reservation."""
    _usage(usage)
    with store.mutation(root):
        directory = _directory(root)
        state = _state(directory)
        match = next((x for x in state["assignments"] if x["id"] == assignment_id), None)
        if match is None or match["status"] != "reserved":
            raise DataError("Complete one existing reserved assignment once")
        match.update(status="completed", usage=usage)
        store.write_json(directory / "assignments.json", state)
    return {"recorded": True, "assignment_id": assignment_id,
            "usage_is_attested": True, "status": status(root)}
