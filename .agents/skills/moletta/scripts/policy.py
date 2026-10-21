"""Pure structural readiness rules; semantic adequacy belongs to the agent review."""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urlparse

from model import Finding, Observation, Run, binding_matches, encode, intent_findings, resolves_observation


@dataclass(frozen=True)
class ObservationIndex:
    applicable: dict[str, Observation]
    passing: dict[str, Observation]


def observation_index(run: Run, unusable=frozenset()) -> ObservationIndex:
    applicable = {item.started.id: item for item in run.observations
                  if item.started.id not in unusable and binding_matches(item.started.binding, run)}
    return ObservationIndex(applicable, {ident: item for ident, item in applicable.items()
                                        if item.assessment is not None and item.assessment.result == "pass"})


class Inspection:
    def __init__(self, findings=()):
        self.findings = list(findings)

    def add(self, code, path, message, severity="error"):
        self.findings.append(Finding(code, path, message, severity))

    def text(self, value: str, path: str):
        if not value.strip():
            self.add("MISSING_DETAIL", path, "Provide a nonempty description.")

    def unique(self, values, path):
        if len(values) != len(set(values)) or any(not value.strip() for value in values):
            self.add("INVALID_ID", path, "Use unique nonempty IDs.")

    def links(self, values, known, path, required=False):
        self.unique(values, path)
        if not set(values).issubset(known):
            self.add("BROKEN_LINK", path, "Referenced IDs must exist.")
        if required and not values:
            self.add("UNTRACED_WORK", path, "Link this work to the desired outcome or capability.")


def evaluate(run: Run, stage: str, findings=(), unusable=frozenset()) -> dict:
    if stage not in ("plan", "decide", "verify"):
        raise ValueError("Unknown check stage")
    check = Inspection(findings)
    plan, intent = run.plan, run.intent
    check.findings.extend(intent_findings(intent))
    outcomes = {item.id for item in intent.outcomes}
    constraints = {item.id for item in intent.constraints}
    requirements = {item.id for item in plan.requirements}
    options = {item.id for item in plan.options}
    notes = {item.id: item for item in plan.notes}
    observations = {item.started.id: item for item in run.observations}
    experiments = {item.id: item for item in plan.experiments}
    for values, path in ((tuple(item.id for item in plan.requirements), "requirements"),
                         (tuple(item.id for item in plan.options), "options"),
                         (tuple(item.id for item in plan.experiments), "experiments"),
                         (tuple(item.id for item in plan.notes), "notes")):
        check.unique(values, path)
    if not requirements:
        check.add("NO_REQUIREMENTS", "requirements", "Reconstruct required capabilities from the raw brief.")
    if not options:
        check.add("NO_OPTIONS", "options", "Explore whole-system approaches before choosing parts.")
    traced_outcomes, traced_constraints = set(), set()
    for item in plan.requirements:
        path = f"requirements.{item.id}"
        check.text(item.criterion, path + ".criterion")
        check.links(item.outcome_ids, outcomes, path + ".outcome_ids", True)
        check.links(item.constraint_ids, constraints, path + ".constraint_ids")
        traced_outcomes.update(item.outcome_ids)
        traced_constraints.update(item.constraint_ids)
        if item.origin == "explicit" and (not item.source_quote or item.source_quote not in run.brief):
            check.add("UNSUPPORTED_REQUIREMENT", path, "Explicit requirement needs a verbatim quote from brief.md.")
        elif item.origin == "derived" and item.source_quote is not None:
            check.add("DERIVED_AS_EXPLICIT", path, "Derived hypotheses use source_quote:null.")
    if outcomes - traced_outcomes:
        check.add("OUTCOME_GAP", "requirements", f"Untraced outcomes: {sorted(outcomes - traced_outcomes)}.")
    if constraints - traced_constraints:
        check.add("CONSTRAINT_GAP", "requirements", f"Untraced constraints: {sorted(constraints - traced_constraints)}.")

    for item in plan.notes:
        path = f"notes.{item.id}"
        check.text(item.claim, path + ".claim")
        check.links(item.outcome_ids, outcomes, path + ".outcome_ids")
        check.links(item.requirement_ids, requirements, path + ".requirement_ids")
        check.links(item.option_ids, options, path + ".option_ids")
        if item.id in observations:
            check.add("INVALID_ID", path, "Note ID conflicts with a tool-owned observation ID.")
        if item.kind == "inference":
            if item.locator is not None or item.sha256 is not None:
                check.add("INFERENCE_PROVENANCE", path, "Inference uses locator:null and sha256:null.")
        elif item.locator is None:
            check.add("SOURCE_LOCATION", path, "Source needs an HTTPS URL or hashed local artifact.")
        elif item.locator.startswith("https://"):
            parsed = urlparse(item.locator)
            if not parsed.netloc or item.sha256 is not None:
                check.add("SOURCE_LOCATION", path, "HTTPS sources use a valid URL and sha256:null.")
        elif item.sha256 is None or len(item.sha256) != 64:
            check.add("SOURCE_LOCATION", path, "Local sources need an actual SHA-256 digest.")

    sources = {item.id for item in plan.notes if item.kind == "source"}
    for index, item in enumerate(plan.research):
        path = f"research[{index}]"
        for name in ("question", "finding", "applicability"):
            check.text(getattr(item, name), path + "." + name)
        check.links(item.source_ids, sources, path + ".source_ids", True)

    index = observation_index(run, unusable)
    usable, passing = index.applicable, index.passing
    for ident, item in observations.items():
        if ident not in usable:
            check.add("HISTORICAL_OBSERVATION", f"observations.{ident}",
                      "Observation does not establish the current intent, design, experiment or tested inputs.", "warning")
        if not item.started.binding.design.subject.files:
            check.add("UNTRACKED_SUBJECT_INPUTS", f"observations.{ident}",
                      "Subject revision and external configuration are assertions; no local input files were fingerprinted.", "warning")
        if item.completed is not None and item.completed.provenance == "attested_native":
            check.add("ATTESTED_PROVENANCE", f"observations.{ident}",
                      "Imported native output is an attestation; its actual tool origin is not authenticated.", "warning")
        if item.assessment is not None:
            for old_id in item.assessment.resolves:
                old = observations.get(old_id)
                if old is None or not resolves_observation(item, old):
                    check.add("INVALID_RESOLUTION", f"observations.{ident}", "Resolution must preserve the failed capability and scope in a later separate passing observation.")

    for option in plan.options:
        path = f"options.{option.id}"
        for name in ("architecture", "contribution", "tradeoffs"):
            check.text(getattr(option, name), path + "." + name)
        for name in ("identity", "revision"):
            check.text(getattr(option.subject, name), path + ".subject." + name)
        check.unique(option.subject.files, path + ".subject.files")
        covered = [row.requirement_id for row in option.coverage]
        check.links(tuple(covered), requirements, path + ".coverage")
        if set(covered) != requirements:
            check.add("CAPABILITY_GAP", path, f"Coverage must include every required capability: {sorted(requirements - set(covered))}.")
        for row in option.coverage:
            row_path = path + "." + row.requirement_id
            if not row.mechanism.strip():
                check.add("MISSING_MECHANISM", row_path, "Required capability has no concrete mechanism.")
            check.links(row.evidence_ids, set(notes) | set(observations), row_path + ".evidence_ids")
            if row.status == "unknown":
                check.add("UNKNOWN_CAPABILITY", row_path, "Uncertainty is visible; investigate if it changes the whole decision.", "warning")
            if row.status != "supported":
                continue
            proof = False
            for ident in row.evidence_ids:
                note = notes.get(ident)
                observation = passing.get(ident)
                if note is not None:
                    applicable = row.requirement_id in note.requirement_ids and option.id in note.option_ids
                    proof |= note.kind == "source" and applicable
                    if not applicable:
                        check.add("UNRELATED_EVIDENCE", row_path, "Note must apply to this requirement and option.")
                elif observation is not None:
                    experiment = observation.started.binding.experiment
                    proof |= experiment.option_id == option.id and row.requirement_id in experiment.requirement_ids
                    if experiment.option_id != option.id or row.requirement_id not in experiment.requirement_ids:
                        check.add("UNRELATED_EVIDENCE", row_path, "Observation must test this option and capability.")
                else:
                    check.add("UNUSABLE_SUPPORT", row_path, "Observation is unassessed, negative, missing, or no longer applicable.")
            if not proof:
                check.add("UNSUPPORTED_COVERAGE", row_path, "Supported capability needs an applicable source or passing observation; inference is not proof.")

    for item in plan.experiments:
        path = f"experiments.{item.id}"
        if item.option_id not in options:
            check.add("BROKEN_LINK", path, "Experiment needs an existing option.")
        check.links(item.outcome_ids, outcomes, path + ".outcome_ids", True)
        check.links(item.requirement_ids, requirements, path + ".requirement_ids", True)
        for name in ("question", "environment", "pass_criterion", "fail_criterion", "retained_conditions", "omitted_conditions", "negative_control"):
            check.text(getattr(item, name), path + "." + name)

    check.unique(tuple(item.id for item in plan.review.findings), "review.findings")
    for item in plan.review.findings:
        check.text(item.issue, f"review.{item.id}.issue")
        if item.disposition != "open" and (item.reason is None or not item.reason.strip()):
            check.add("MISSING_DETAIL", f"review.{item.id}", "Disposition needs a reason.")
    action = plan.next_action
    if action is not None:
        if action.timebox_minutes <= 0:
            check.add("UNBOUNDED_ACTION", "next_action", "Timebox must be a positive integer number of minutes.")
        for name in ("question", "rationale", "stop_condition"):
            check.text(getattr(action, name), "next_action." + name)
        if action.kind == "experiment" and action.experiment_id not in experiments:
            check.add("BROKEN_LINK", "next_action", "Experiment action needs a declared experiment ID.")
        elif action.kind != "experiment" and action.experiment_id is not None:
            check.add("ACTION_SCOPE", "next_action", "Only experiment actions carry an experiment_id.")

    selected = next((item for item in plan.options if item.id == plan.decision.option_id), None)
    if stage in ("decide", "verify"):
        if not plan.research:
            check.add("NO_EXPLORATION", "research", "Investigate a structurally different approach or cite why alternatives are infeasible.")
        if plan.review.mode == "pending" or not plan.review.raw_brief_read:
            check.add("RAW_BRIEF_REVIEW_REQUIRED", "review", "Reconstruct capabilities from the original brief independently of the designer summary.")
        for item in plan.review.findings:
            if item.severity in ("critical", "material") and item.disposition in ("open", "deferred"):
                check.add("UNRESOLVED_FINDING", f"review.{item.id}", "Resolve this material concern before adoption.")
        if plan.decision.status not in ("provisional", "selected") or selected is None:
            check.add("NO_SELECTION", "decision", "Choose a whole-system option or continue exploring.")
        for name in ("rationale", "reconsider_when"):
            check.text(getattr(plan.decision, name), "decision." + name)
        for condition in plan.decision.conditions:
            check.text(condition, "decision.conditions")
        if plan.decision.status == "provisional" and not plan.decision.conditions:
            check.add("MISSING_CONDITIONS", "decision", "Conditional adoption needs explicit facts to resolve.")
        if plan.decision.status == "selected" and plan.decision.conditions:
            check.add("UNRESOLVED_CONDITIONS", "decision", "Resolve adoption conditions before unconditional selection.")
        if selected is not None:
            for row in selected.coverage:
                if row.status == "violated":
                    check.add("MANDATORY_VIOLATION", "decision", "Chosen option violates a required capability.")
                elif row.status == "unknown" and plan.decision.status != "provisional":
                    check.add("UNCONDITIONAL_UNKNOWN", "decision", "Unknown required capability permits only conditional adoption.")
        for item in pending_observations(run, index):
            severity = "warning" if stage == "decide" and plan.decision.status == "provisional" else "error"
            check.add(item["code"], f"observations.{item['observation_id']}", item["message"], severity)
    if stage == "verify":
        check.text(plan.target_environment, "target_environment")
        if plan.decision.status != "selected":
            check.add("NOT_SELECTED", "decision", "Resolve conditional adoption before verifying completion.")
        relevant = [item.started.binding.experiment for item in passing.values()
                    if item.started.binding.experiment.option_id == plan.decision.option_id
                    and item.started.binding.experiment.environment == plan.target_environment]
        covered = {rid for item in relevant for rid in item.requirement_ids}
        required_by_outcome = {oid: {item.id for item in plan.requirements if oid in item.outcome_ids}
                               for oid in outcomes}
        whole = {oid for item in relevant if item.scope == "end_to_end" for oid in item.outcome_ids
                 if required_by_outcome[oid].issubset(item.requirement_ids)}
        if requirements - covered:
            check.add("UNVERIFIED_CAPABILITY", "observations", f"Missing target-environment passing measurements for {sorted(requirements - covered)}.")
        if outcomes - whole:
            check.add("NO_WHOLE_OUTCOME_EVIDENCE", "observations", "Each outcome needs one passing target-environment end_to_end observation covering all capabilities linked to that outcome.")
    return {"stage": stage, "structural_readiness": not any(item.severity == "error" for item in check.findings),
            "semantic_review_required": True, "findings": [encode(item) for item in check.findings]}


def pending_observations(run: Run, index: ObservationIndex, selected_only=True) -> list[dict]:
    resolved = {old for item in index.passing.values() for old in item.assessment.resolves}
    pending = []
    current_options = {item.id for item in run.plan.options}
    for item in run.observations:
        experiment = item.started.binding.experiment
        if experiment.option_id not in current_options:
            continue
        if selected_only and (experiment.option_id != run.plan.decision.option_id or experiment.environment != run.plan.target_environment):
            continue
        if item.assessment is not None and item.assessment.result != "pass" and item.started.id not in resolved:
            pending.append({"observation_id": item.started.id, "code": "NEGATIVE_EVIDENCE", "message": "Resolve the failed or inconclusive capability with an explicitly linked later separate passing observation."})
        elif item.assessment is None:
            pending.append({"observation_id": item.started.id, "code": "UNASSESSED_OBSERVATION", "message": "Complete and assess the actual observation against its planned criteria."})
    return pending
