#!/usr/bin/env python3
"""Keep design intent, bounded next actions and actual observations reviewable."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
import uuid

import data_policy
import delegation
import devices
import performance
import policy
import store
import workspace
from model import DataError, encode


def report(root: Path, stage: str = "plan") -> dict:
    try:
        loaded = store.load(root)
        value = policy.evaluate(loaded.run, stage, loaded.findings, loaded.unusable_observations)
        if stage == "verify" and devices.pending(root):
            value["findings"].append({"code": "DEVICE_CLEANUP_PENDING", "path": "devices",
                "message": "Release this run's owned devices before reporting completion", "severity": "error"})
            value["structural_readiness"] = False
        return value
    except (OSError, UnicodeError, ValueError) as exc:
        return {"stage": stage, "structural_readiness": False, "semantic_review_required": True,
                "findings": [{"code": "INVALID_RUN", "path": str(root), "message": str(exc), "severity": "error"}]}


def next_action(root: Path) -> dict:
    result = report(root)
    errors = [item for item in result["findings"] if item["severity"] == "error"]
    if errors:
        return {"action": "repair_record", "focus": errors[0], "check": result}
    loaded = store.load(root)
    pending = policy.pending_observations(loaded.run, policy.observation_index(loaded.run, loaded.unusable_observations),
                                          selected_only=loaded.run.plan.decision.option_id is not None)
    if pending:
        return {"action": "resolve_observation", "focus": pending[0],
                "note": "An execution is not a verified result. Choose one bounded action to assess or resolve this observation."}
    action = loaded.run.plan.next_action
    if action is not None:
        return {"action": "execute_bounded_action", "next_action": encode(action),
                "note": "Respect the timebox and stop condition; judge information by its effect on the whole outcome."}
    leases = devices.pending(root)
    if leases:
        return {"action": "release_owned_devices", "leases": leases,
                "note": "Finish observation collection, then release only this run's leases before reporting completion."}
    verification = report(root, "verify")
    if verification["structural_readiness"]:
        return {"action": "semantic_outcome_review", "check": verification,
                "note": "Check the actual outcome and remaining limits. Structural readiness is not semantic proof."}
    return {"action": "choose_bounded_action", "required_fields": ["kind", "question", "rationale", "timebox_minutes", "stop_condition", "experiment_id"],
            "conditions": list(loaded.run.plan.decision.conditions), "check": verification,
            "note": "Choose the smallest next action that can change the whole-system decision; declare it in plan.json."}


def selected_json(path: Path) -> dict:
    value = data_policy.read_json(path, label="Selected configuration")
    if not isinstance(value, dict):
        raise DataError("Selected configuration must be a JSON object")
    return value


def save_metrics(root: Path, value: dict, kind: str) -> dict:
    """Persist derived statistics under one run, never copy the raw measurement."""
    if not (root / "journal.json").is_file():
        raise DataError("Initialize a run before aggregating measurements")
    with store.mutation(root):
        directory = root / "metrics"
        if directory.is_symlink():
            raise DataError("Measurement storage must not be a symlink")
        directory.mkdir(mode=0o700, exist_ok=True)
        path = directory / f"{kind}-{uuid.uuid4().hex}.json"
        store.write_json(path, value)
    return {"output": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "raw_input_copied": False,
            "note": "Derived statistics may still be confidential; this is not a public export or a performance verdict."}


def device_command(args) -> dict:
    run = args.run.resolve() if getattr(args, "run", None) is not None else None
    if args.device_command == "inspect":
        return devices.inspect(args.platform, sdk=args.sdk)
    if args.device_command == "allocate":
        if not (run / "journal.json").is_file():
            raise DataError("Initialize a run before allocating a device")
        return devices.allocate(run, args.platform, runtime=args.runtime, device_type=args.device_type,
                                state_dir=args.state_dir, sdk=args.sdk)
    if args.device_command == "release":
        return devices.release(run, args.lease, state_dir=args.state_dir)
    if args.device_command == "status":
        return devices.status(run, state_dir=args.state_dir)
    return devices.gc(state_dir=args.state_dir, older_than_hours=args.older_than_hours, apply=args.apply)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    init = sub.add_parser("init", help="Create a new local run from the original request")
    init.add_argument("run", nargs="?", type=Path)
    init.add_argument("--brief", required=True, type=Path)
    init.add_argument("--goal", required=True)
    init.add_argument("--project", type=Path)
    init.add_argument("--name")
    for name in ("seal", "next", "checkpoint"):
        command = sub.add_parser(name)
        command.add_argument("run", type=Path)
    check = sub.add_parser("check", help="Check structural readiness, never semantic truth")
    check.add_argument("run", type=Path)
    check.add_argument("--stage", choices=("plan", "decide", "verify"), default="plan")
    begin = sub.add_parser("begin", help="Bind a native-tool observation before execution")
    begin.add_argument("run", type=Path)
    begin.add_argument("--experiment", required=True)
    record = sub.add_parser("record", help="Import actual native-tool output as an attestation")
    record.add_argument("run", type=Path)
    record.add_argument("--observation", required=True)
    record.add_argument("--transcript", required=True, type=Path)
    record.add_argument("--method", required=True)
    record.add_argument("--artifact", action="append", default=[], type=Path)
    record.add_argument("--allow-opaque-artifacts", action="store_true",
                        help="Include explicitly approved binary artifacts; no content confidentiality guarantee")
    capture = sub.add_parser("capture", help="Capture literal argv; exit zero does not imply passing behavior")
    capture.add_argument("run", type=Path)
    capture.add_argument("--experiment", required=True)
    capture.add_argument("--timeout", type=float, default=30)
    capture.add_argument("--cwd", type=Path)
    assess = sub.add_parser("assess", help="Assess one observation against its predeclared criteria once")
    assess.add_argument("run", type=Path)
    assess.add_argument("--observation", required=True)
    assess.add_argument("--result", choices=("pass", "fail", "inconclusive"), required=True)
    assess.add_argument("--reason", required=True)
    assess.add_argument("--resolves", action="append", default=[])
    metrics = sub.add_parser("metrics", help="Aggregate selected local numeric measurements")
    metric_sub = metrics.add_subparsers(dest="metric_command", required=True)
    summarize = metric_sub.add_parser("summarize")
    summarize.add_argument("run", type=Path)
    summarize.add_argument("--input", required=True, type=Path)
    summarize.add_argument("--format", required=True, choices=performance.FORMATS)
    summarize.add_argument("--context", type=Path)
    compare = metric_sub.add_parser("compare")
    compare.add_argument("run", type=Path)
    compare.add_argument("--baseline", required=True, type=Path)
    compare.add_argument("--candidate", required=True, type=Path)
    device = sub.add_parser("device", help="Lease installed mobile runtimes without downloading system images")
    device_sub = device.add_subparsers(dest="device_command", required=True)
    inspect_device = device_sub.add_parser("inspect")
    inspect_device.add_argument("platform", choices=("ios", "android"))
    inspect_device.add_argument("--sdk", type=Path)
    allocate = device_sub.add_parser("allocate")
    allocate.add_argument("run", type=Path)
    allocate.add_argument("--platform", required=True, choices=("ios", "android"))
    allocate.add_argument("--runtime", required=True)
    allocate.add_argument("--device-type", required=True)
    allocate.add_argument("--sdk", type=Path)
    release = device_sub.add_parser("release")
    release.add_argument("run", type=Path)
    release.add_argument("--lease", required=True)
    device_status = device_sub.add_parser("status")
    device_status.add_argument("run", nargs="?", type=Path)
    gc = device_sub.add_parser("gc")
    gc.add_argument("--older-than-hours", type=float, default=24)
    gc.add_argument("--apply", action="store_true")
    for command in (allocate, release, device_status, gc):
        command.add_argument("--state-dir", type=Path)
    delegate = sub.add_parser("delegation", help="Check approved host model choices and record bounded assignments")
    delegate_sub = delegate.add_subparsers(dest="delegation_command", required=True)
    configure = delegate_sub.add_parser("configure")
    configure.add_argument("run", type=Path)
    configure.add_argument("--approval", required=True, type=Path)
    reserve = delegate_sub.add_parser("reserve")
    reserve.add_argument("run", type=Path)
    reserve.add_argument("--request", required=True, type=Path)
    reserve.add_argument("--catalog", required=True, type=Path)
    complete = delegate_sub.add_parser("complete")
    complete.add_argument("run", type=Path)
    complete.add_argument("--assignment", required=True)
    complete.add_argument("--usage", required=True, type=Path)
    delegate_status = delegate_sub.add_parser("status")
    delegate_status.add_argument("run", type=Path)
    args, rest = parser.parse_known_args(argv)
    if args.command != "capture" and rest:
        parser.error("unrecognized arguments: " + " ".join(rest))
    try:
        if args.command == "init":
            value = workspace.initialize(args.brief, args.goal, root=args.run, project=args.project, name=args.name)
        elif args.command == "device":
            value = device_command(args)
        elif args.command == "metrics":
            root = args.run.resolve()
            if args.metric_command == "summarize":
                context = performance.read_context(args.context) if args.context else None
                value = save_metrics(root, performance.summarize(args.input, args.format, context), "summary")
            else:
                value = save_metrics(root, performance.compare(performance.load_summary(args.baseline),
                                     performance.load_summary(args.candidate)), "comparison")
        elif args.command == "delegation":
            root = args.run.resolve()
            if args.delegation_command == "configure":
                value = delegation.configure(root, selected_json(args.approval))
            elif args.delegation_command == "reserve":
                value = delegation.reserve(root, selected_json(args.request), selected_json(args.catalog))
            elif args.delegation_command == "complete":
                value = delegation.complete(root, args.assignment, selected_json(args.usage))
            else:
                value = delegation.status(root)
        else:
            value = runtime_command(args, rest)
        print(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False))
        return 0 if args.command != "check" or value["structural_readiness"] else 1
    except (OSError, UnicodeError, ValueError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2


def runtime_command(args, rest) -> dict:
    root = args.run.resolve()
    if args.command == "seal":
        return store.seal(root)
    if args.command == "check":
        return report(root, args.stage)
    if args.command == "next":
        return next_action(root)
    if args.command == "checkpoint":
        return store.checkpoint(root, report(root))
    if args.command == "begin":
        return store.begin(root, args.experiment)
    if args.command == "record":
        return store.record(root, args.observation, args.transcript, args.method, tuple(args.artifact),
                            allow_opaque_artifacts=args.allow_opaque_artifacts)
    if args.command == "assess":
        return store.assess(root, args.observation, args.result, args.reason, tuple(args.resolves))
    if not rest or rest[0] != "--":
        raise DataError("Separate the captured command with --")
    return store.capture(root, args.experiment, rest[1:], args.timeout, args.cwd)


if __name__ == "__main__":
    sys.exit(main())
