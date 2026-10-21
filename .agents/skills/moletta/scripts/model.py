"""The run's typed JSON boundary and domain vocabulary; no filesystem access."""

from __future__ import annotations

import hashlib
import json
import types
from dataclasses import asdict, dataclass, fields, is_dataclass
from datetime import datetime
from typing import Literal, Union, get_args, get_origin, get_type_hints


class DataError(ValueError):
    """A document or operation violates the public run contract."""


def digest(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def canonical(value: object) -> bytes:
    return json.dumps(encode(value), ensure_ascii=False, sort_keys=True,
                      separators=(",", ":")).encode("utf-8")


def encode(value: object) -> object:
    return asdict(value) if is_dataclass(value) else value


def parse(kind, value: object, path: str = "document"):
    """Reject missing, unknown and wrongly typed fields before domain policy runs."""
    origin, args = get_origin(kind), get_args(kind)
    if origin in (Union, types.UnionType):
        for choice in args:
            try:
                return parse(choice, value, path)
            except DataError:
                pass
        raise DataError(f"{path}: value has no permitted type")
    if origin is Literal:
        if not any(type(value) is type(choice) and value == choice for choice in args):
            raise DataError(f"{path}: expected one of {args}")
        return value
    if origin is tuple:
        if not isinstance(value, list):
            raise DataError(f"{path}: expected an array")
        return tuple(parse(args[0], item, f"{path}[{index}]") for index, item in enumerate(value))
    if kind is type(None):
        if value is not None:
            raise DataError(f"{path}: expected null")
        return None
    if is_dataclass(kind):
        if not isinstance(value, dict):
            raise DataError(f"{path}: expected an object")
        names = {field.name for field in fields(kind)}
        if set(value) != names:
            raise DataError(f"{path}: missing fields {sorted(names - set(value))}; unknown fields {sorted(set(value) - names)}")
        hints = get_type_hints(kind)
        return kind(**{name: parse(hints[name], item, f"{path}.{name}") for name, item in value.items()})
    if type(value) is not kind:
        raise DataError(f"{path}: expected {kind.__name__}")
    return value


@dataclass(frozen=True)
class Finding:
    code: str
    path: str
    message: str
    severity: Literal["error", "warning"] = "error"


@dataclass(frozen=True)
class Outcome:
    id: str
    statement: str
    acceptance: str


@dataclass(frozen=True)
class Constraint:
    id: str
    text: str


@dataclass(frozen=True)
class Intent:
    schema_version: Literal[1]
    outcomes: tuple[Outcome, ...]
    constraints: tuple[Constraint, ...]


def intent_findings(intent: Intent) -> tuple[Finding, ...]:
    findings = []
    ids = [item.id for item in (*intent.outcomes, *intent.constraints)]
    if len(ids) != len(set(ids)) or any(not ident.strip() for ident in ids):
        findings.append(Finding("INVALID_ID", "intent", "Outcome and constraint IDs must be unique and nonempty."))
    if not intent.outcomes:
        findings.append(Finding("NO_OUTCOME", "intent.outcomes", "Define the user's desired result."))
    for item in intent.outcomes:
        if not item.statement.strip() or not item.acceptance.strip():
            findings.append(Finding("MISSING_DETAIL", f"intent.{item.id}", "Describe the original outcome and acceptance criterion."))
    for item in intent.constraints:
        if not item.text.strip():
            findings.append(Finding("MISSING_DETAIL", f"intent.{item.id}", "Describe the original constraint."))
    return tuple(findings)


@dataclass(frozen=True)
class Requirement:
    id: str
    origin: Literal["explicit", "derived"]
    source_quote: str | None
    outcome_ids: tuple[str, ...]
    constraint_ids: tuple[str, ...]
    criterion: str


@dataclass(frozen=True)
class Subject:
    identity: str
    revision: str
    files: tuple[str, ...]


@dataclass(frozen=True)
class Coverage:
    requirement_id: str
    mechanism: str
    status: Literal["supported", "unknown", "violated"]
    evidence_ids: tuple[str, ...]


@dataclass(frozen=True)
class Option:
    id: str
    architecture: str
    contribution: str
    tradeoffs: str
    subject: Subject
    coverage: tuple[Coverage, ...]


@dataclass(frozen=True)
class Note:
    id: str
    kind: Literal["source", "inference"]
    claim: str
    locator: str | None
    sha256: str | None
    outcome_ids: tuple[str, ...]
    requirement_ids: tuple[str, ...]
    option_ids: tuple[str, ...]


@dataclass(frozen=True)
class Research:
    question: str
    source_ids: tuple[str, ...]
    finding: str
    applicability: str


Scope = Literal["unit", "integration", "end_to_end"]


@dataclass(frozen=True)
class Experiment:
    id: str
    option_id: str
    outcome_ids: tuple[str, ...]
    requirement_ids: tuple[str, ...]
    question: str
    scope: Scope
    environment: str
    pass_criterion: str
    fail_criterion: str
    retained_conditions: str
    omitted_conditions: str
    negative_control: str


@dataclass(frozen=True)
class ReviewFinding:
    id: str
    severity: Literal["critical", "material", "minor"]
    issue: str
    disposition: Literal["open", "accepted", "rejected", "deferred"]
    reason: str | None


@dataclass(frozen=True)
class Review:
    mode: Literal["pending", "independent_context", "self_review"]
    raw_brief_read: bool
    findings: tuple[ReviewFinding, ...]


@dataclass(frozen=True)
class Decision:
    status: Literal["exploring", "provisional", "selected", "rejected"]
    option_id: str | None
    rationale: str
    conditions: tuple[str, ...]
    reconsider_when: str


@dataclass(frozen=True)
class Action:
    kind: Literal["explore", "experiment", "review", "decide"]
    question: str
    rationale: str
    timebox_minutes: int
    stop_condition: str
    experiment_id: str | None


@dataclass(frozen=True)
class Plan:
    schema_version: Literal[1]
    target_environment: str
    requirements: tuple[Requirement, ...]
    options: tuple[Option, ...]
    notes: tuple[Note, ...]
    research: tuple[Research, ...]
    experiments: tuple[Experiment, ...]
    review: Review
    decision: Decision
    next_action: Action | None


@dataclass(frozen=True)
class Capability:
    requirement_id: str
    mechanism: str


@dataclass(frozen=True)
class Design:
    option_id: str
    architecture: str
    contribution: str
    tradeoffs: str
    subject: Subject
    capabilities: tuple[Capability, ...]


def design(option: Option) -> Design:
    return Design(option.id, option.architecture, option.contribution, option.tradeoffs,
                  option.subject, tuple(Capability(row.requirement_id, row.mechanism) for row in option.coverage))


@dataclass(frozen=True)
class Fingerprint:
    path: str
    sha256: str


@dataclass(frozen=True)
class Binding:
    intent_sha256: str
    design: Design
    requirements: tuple[Requirement, ...]
    experiment: Experiment
    inputs: tuple[Fingerprint, ...]


@dataclass(frozen=True)
class Started:
    id: str
    started_at: str
    binding: Binding


@dataclass(frozen=True)
class Artifact:
    path: str
    sha256: str


@dataclass(frozen=True)
class Command:
    argv: tuple[str, ...]
    cwd: str
    status: Literal["completed", "timeout", "launch_error", "output_blocked"]
    exit_code: int | None


@dataclass(frozen=True)
class Completed:
    observation_id: str
    finished_at: str
    provenance: Literal["direct_command", "attested_native"]
    method: str
    artifacts: tuple[Artifact, ...]
    command: Command | None


@dataclass(frozen=True)
class Assessment:
    observation_id: str
    assessed_at: str
    result: Literal["pass", "fail", "inconclusive"]
    reason: str
    resolves: tuple[str, ...]


@dataclass(frozen=True)
class Observation:
    started: Started
    completed: Completed | None
    assessment: Assessment | None


@dataclass(frozen=True)
class Run:
    run_id: str
    brief: str
    intent: Intent
    plan: Plan
    observations: tuple[Observation, ...]


def binding_matches(binding: Binding, run: Run) -> bool:
    option = next((item for item in run.plan.options if item.id == binding.design.option_id), None)
    experiment = next((item for item in run.plan.experiments if item.id == binding.experiment.id), None)
    requirements = tuple(item for item in run.plan.requirements if item.id in binding.experiment.requirement_ids)
    return (binding.intent_sha256 == digest(canonical(run.intent)) and option is not None
            and binding.design == design(option) and binding.experiment == experiment
            and binding.requirements == requirements)


def resolves_observation(new: Observation, old: Observation) -> bool:
    """A fixed subject may differ; the failed capability and scope must still be tested."""
    if new.assessment is None or new.assessment.result != "pass" or old.assessment is None or old.assessment.result == "pass":
        return False
    if new.completed is None or old.completed is None or new.started.id == old.started.id:
        return False
    current, previous = new.started.binding.experiment, old.started.binding.experiment
    return (datetime.fromisoformat(new.started.started_at) > datetime.fromisoformat(old.completed.finished_at)
            and current.option_id == previous.option_id and current.scope == previous.scope
            and current.environment == previous.environment
            and set(previous.requirement_ids).issubset(current.requirement_ids)
            and set(previous.outcome_ids).issubset(current.outcome_ids)
            and new.started.binding.intent_sha256 == old.started.binding.intent_sha256
            and all(item in new.started.binding.requirements for item in old.started.binding.requirements))
