"""Local run storage and the single observation lifecycle for commands and tools."""

from __future__ import annotations

import json
import fcntl
import math
import os
import selectors
import shutil
import signal
import subprocess
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import data_policy
import policy
from model import (Artifact, Assessment, Binding, Command, Completed, DataError,
                   Fingerprint, Finding, Intent, Observation, Plan, Run, Started,
                   canonical, design, digest, encode, intent_findings, parse, resolves_observation)


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def read_json(path: Path) -> dict:
    def unique_object(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise DataError(f"{path.name}: duplicate object key {key}")
            value[key] = item
        return value

    def invalid_constant(value):
        raise DataError(f"{path.name}: non-finite JSON constant {value}")

    value = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique_object,
                       parse_constant=invalid_constant)
    if not isinstance(value, dict):
        raise DataError(f"{path.name}: expected an object")
    return value


def _write_private(path: Path, raw: bytes) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(raw)


def write_json(path: Path, value: object) -> None:
    """Atomic replacement prevents a failed write from publishing half a document."""
    temporary = path.with_name(f".{path.name}-{uuid.uuid4().hex}.tmp")
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(encode(value), stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


@contextmanager
def mutation(root: Path):
    descriptor = os.open(root / ".write.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "a+b") as stream:
        try:
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise DataError("Run is locked by another active writer") from exc
        try:
            yield
        finally:
            fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def _journal_body(value: dict) -> dict:
    return {key: value[key] for key in ("schema_version", "run_id", "brief_sha256", "events")}


def _read_journal(root: Path) -> dict:
    value = read_json(root / "journal.json")
    if set(value) != {"schema_version", "run_id", "brief_sha256", "events", "sha256"}:
        raise DataError("journal.json: invalid fields")
    if type(value["schema_version"]) is not int or value["schema_version"] != 1:
        raise DataError("journal.json: expected schema_version 1")
    if (not isinstance(value["run_id"], str) or not value["run_id"]
            or not isinstance(value["brief_sha256"], str) or not isinstance(value["events"], list)):
        raise DataError("journal.json: invalid header")
    if value["sha256"] != digest(canonical(_journal_body(value))):
        raise DataError("journal.json: checksum differs; history changed or is corrupt")
    return value


def _write_journal(root: Path, value: dict) -> None:
    value["sha256"] = digest(canonical(_journal_body(value)))
    write_json(root / "journal.json", value)


def _append(root: Path, kind: str, value: object) -> None:
    journal = _read_journal(root)
    journal["events"].append({"kind": kind, "value": encode(value)})
    _write_journal(root, journal)


def _time(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value)
        if parsed.tzinfo is None:
            raise ValueError("timestamp needs timezone")
        return parsed
    except ValueError as exc:
        raise DataError(f"Invalid observation timestamp: {value}") from exc


def _observations(events: list) -> tuple[Observation, ...]:
    observations: dict[str, Observation] = {}
    previous_time = None
    for index, envelope in enumerate(events):
        if not isinstance(envelope, dict) or set(envelope) != {"kind", "value"}:
            raise DataError(f"journal.events[{index}]: invalid envelope")
        kind, raw = envelope["kind"], envelope["value"]
        if not isinstance(kind, str):
            raise DataError(f"journal.events[{index}]: event kind must be a string")
        event_type = {"started": Started, "completed": Completed, "assessed": Assessment}.get(kind)
        if event_type is None:
            raise DataError(f"journal.events[{index}]: unknown event kind")
        event = parse(event_type, raw, f"journal.events[{index}]")
        timestamp = _time(event.started_at if kind == "started" else event.finished_at if kind == "completed" else event.assessed_at)
        if previous_time is not None and timestamp < previous_time:
            raise DataError("journal: event timestamps are out of order")
        previous_time = timestamp
        if kind == "started":
            if event.id in observations:
                raise DataError("journal: duplicate observation start")
            observations[event.id] = Observation(event, None, None)
            continue
        observation = observations.get(event.observation_id)
        if observation is None:
            raise DataError("journal: observation must start before completion or assessment")
        if kind == "completed":
            if observation.completed is not None:
                raise DataError("journal: an observation can complete only once")
            if not event.artifacts or not event.method.strip():
                raise DataError("journal: completion needs raw artifacts and method")
            if event.provenance == "direct_command":
                if event.command is None or not event.command.argv or not Path(event.command.cwd).is_absolute():
                    raise DataError("journal: direct command completion needs argv and absolute cwd")
                if event.command.status != "launch_error" and event.command.exit_code is None:
                    raise DataError("journal: executed command needs an exit code")
            elif event.command is not None:
                raise DataError("journal: native attestation cannot claim direct command metadata")
            observations[event.observation_id] = Observation(observation.started, event, None)
        else:
            if observation.completed is None or observation.assessment is not None:
                raise DataError("journal: complete once before assessing once")
            if not event.reason.strip() or len(event.resolves) != len(set(event.resolves)):
                raise DataError("journal: assessment needs a reason and unique resolution IDs")
            command = observation.completed.command
            if event.result == "pass" and command is not None and command.status != "completed":
                raise DataError("journal: incomplete execution cannot pass")
            observations[event.observation_id] = Observation(observation.started, observation.completed, event)
    return tuple(observations.values())


def artifact_path(root: Path, relative: str) -> Path:
    path = Path(relative)
    if path.is_absolute() or ".." in path.parts or not path.parts or path.parts[0] != "artifacts":
        raise DataError("Artifact must be a relative path inside artifacts/")
    target = root / path
    current = root
    for part in path.parts:
        current = current / part
        if current.is_symlink():
            raise DataError("Artifact paths must not contain symlinks")
    if not target.resolve().is_relative_to(root.resolve() / "artifacts"):
        raise DataError("Artifact escapes artifacts/")
    return target


@dataclass(frozen=True)
class Loaded:
    run: Run
    findings: tuple[Finding, ...]
    unusable_observations: frozenset[str]


def load(root: Path) -> Loaded:
    journal = _read_journal(root)
    brief_raw = (root / "brief.md").read_bytes()
    brief = brief_raw.decode("utf-8")
    intent = parse(Intent, read_json(root / "intent.json"), "intent")
    plan = parse(Plan, read_json(root / "plan.json"), "plan")
    observations = _observations(journal["events"])
    findings: list[Finding] = []
    unusable = set()
    if digest(brief_raw) != journal["brief_sha256"]:
        findings.append(Finding("BRIEF_CHANGED", "brief.md", "Original brief changed. Create a new run for changed intent."))
    seal_path = root / "seal.json"
    if not seal_path.exists():
        findings.append(Finding("INTENT_UNSEALED", "intent.json", "Complete original outcomes and constraints, then seal."))
    else:
        seal = read_json(seal_path)
        if (set(seal) != {"schema_version", "run_id", "brief_sha256", "intent_sha256", "sealed_at"}
                or type(seal["schema_version"]) is not int or seal["schema_version"] != 1):
            raise DataError("seal.json: invalid seal format")
        if seal["run_id"] != journal["run_id"] or seal["brief_sha256"] != journal["brief_sha256"]:
            findings.append(Finding("SEAL_IDENTITY", "seal.json", "Seal belongs to another run or brief."))
        if seal["intent_sha256"] != digest(canonical(intent)):
            findings.append(Finding("INTENT_CHANGED", "intent.json", "Sealed goal or constraints changed. Create a new run."))
    for observation in observations:
        ident = observation.started.id
        for fingerprint in observation.started.binding.inputs:
            try:
                matches = digest(Path(fingerprint.path).read_bytes()) == fingerprint.sha256
            except OSError:
                matches = False
            if not matches:
                unusable.add(ident)
                findings.append(Finding("SUBJECT_CHANGED", f"observations.{ident}",
                                        f"Declared tested input changed or is missing: {fingerprint.path}", "warning"))
        if observation.completed is not None:
            for artifact in observation.completed.artifacts:
                try:
                    matches = digest(artifact_path(root, artifact.path).read_bytes()) == artifact.sha256
                    if not matches:
                        raise DataError("artifact digest differs")
                except (OSError, DataError) as exc:
                    unusable.add(ident)
                    findings.append(Finding("ARTIFACT_INTEGRITY", f"observations.{ident}", str(exc)))
    for note in plan.notes:
        if note.kind == "source" and note.locator is not None and not note.locator.startswith("https://"):
            try:
                if digest(artifact_path(root, note.locator).read_bytes()) != note.sha256:
                    raise DataError("source digest differs")
            except (OSError, DataError) as exc:
                findings.append(Finding("SOURCE_INTEGRITY", f"notes.{note.id}", str(exc)))
    checkpoints = root / "checkpoints"
    if checkpoints.is_symlink():
        raise DataError("checkpoints/ must not be a symlink")
    for path in checkpoints.glob("*.json"):
        snapshot = read_json(path)
        prefix = snapshot.get("journal_length")
        if type(prefix) is not int or prefix < 0 or prefix > len(journal["events"]):
            findings.append(Finding("HISTORY_CHANGED", str(path), "Checkpointed journal history was truncated."))
        elif snapshot.get("journal_sha256") != digest(canonical(journal["events"][:prefix])):
            findings.append(Finding("HISTORY_CHANGED", str(path), "Checkpointed journal history was rewritten."))
    return Loaded(Run(journal["run_id"], brief, intent, plan, observations), tuple(findings), frozenset(unusable))


def initialize(root: Path, brief_path: Path, goal: str) -> dict:
    brief = data_policy.read_file(brief_path, label="Original brief")
    data_policy.check_text(goal, label="Goal")
    if not goal.strip():
        raise DataError("Goal must be nonempty")
    root.mkdir(mode=0o700, parents=True, exist_ok=False)
    _write_private(root / "brief.md", brief)
    (root / "artifacts").mkdir(mode=0o700)
    (root / "checkpoints").mkdir(mode=0o700)
    write_json(root / "intent.json", {"schema_version": 1, "outcomes": [
        {"id": "O1", "statement": goal, "acceptance": ""}], "constraints": []})
    write_json(root / "plan.json", {"schema_version": 1, "target_environment": "",
        "requirements": [], "options": [], "notes": [], "research": [], "experiments": [],
        "review": {"mode": "pending", "raw_brief_read": False, "findings": []},
        "decision": {"status": "exploring", "option_id": None, "rationale": "", "conditions": [], "reconsider_when": ""},
        "next_action": None})
    journal = {"schema_version": 1, "run_id": uuid.uuid4().hex, "brief_sha256": digest(brief), "events": []}
    _write_journal(root, journal)
    return {"run": str(root), "next": "Read brief.md; complete original outcomes, acceptance and constraints in intent.json; seal, then develop plan.json."}


def seal(root: Path) -> dict:
    with mutation(root):
        journal = _read_journal(root)
        intent = parse(Intent, read_json(root / "intent.json"), "intent")
        if intent_findings(intent):
            raise DataError("Complete unique original outcomes, acceptance criteria and constraints before sealing")
        if digest((root / "brief.md").read_bytes()) != journal["brief_sha256"]:
            raise DataError("Original brief changed; create a new run")
        intent_digest = digest(canonical(intent))
        path = root / "seal.json"
        if path.exists():
            if read_json(path).get("intent_sha256") != intent_digest:
                raise DataError("Cannot reseal changed intent; create a new run")
            return {"sealed": True, "changed": False, "sha256": intent_digest}
        write_json(path, {"schema_version": 1, "run_id": journal["run_id"], "brief_sha256": journal["brief_sha256"],
                          "intent_sha256": intent_digest, "sealed_at": now()})
        return {"sealed": True, "changed": True, "sha256": intent_digest}


def _require_integrity(loaded: Loaded) -> None:
    errors = [finding for finding in loaded.findings if finding.severity == "error"]
    if errors:
        raise DataError("; ".join(f"{item.code}: {item.message}" for item in errors))


def begin(root: Path, experiment_id: str) -> dict:
    with mutation(root):
        loaded = load(root)
        _require_integrity(loaded)
        run = loaded.run
        readiness = policy.evaluate(run, "plan", loaded.findings, loaded.unusable_observations)
        errors = [item for item in readiness["findings"] if item["severity"] == "error"]
        if errors:
            raise DataError("Predeclare a structurally valid plan before observation: " +
                            "; ".join(f"{item['code']}: {item['message']}" for item in errors))
        experiment = next((item for item in run.plan.experiments if item.id == experiment_id), None)
        if experiment is None:
            raise DataError("Predeclare an existing experiment before observation")
        option = next((item for item in run.plan.options if item.id == experiment.option_id), None)
        if option is None:
            raise DataError("Experiment needs an existing whole-system option")
        inputs = []
        for declared in option.subject.files:
            path = Path(declared)
            path = path if path.is_absolute() else root / path
            if not path.is_file():
                raise DataError(f"Declared input is not a regular file: {declared}")
            inputs.append(Fingerprint(str(path.absolute()), digest(path.read_bytes())))
        binding = Binding(digest(canonical(run.intent)), design(option), tuple(
            item for item in run.plan.requirements if item.id in experiment.requirement_ids), experiment, tuple(inputs))
        observation = Started("obs-" + uuid.uuid4().hex, now(), binding)
        _append(root, "started", observation)
        return {"observation_id": observation.id, "status": "started", "binding_sha256": digest(canonical(binding)),
                "next": "Execute the declared operation, then record the actual tool transcript and artifacts."}


def _find(run: Run, observation_id: str) -> Observation:
    observation = next((item for item in run.observations if item.started.id == observation_id), None)
    if observation is None:
        raise DataError("Unknown observation ID")
    return observation


def _complete(root: Path, observation_id: str, method: str, provenance: str,
              files: tuple[tuple[str, bytes], ...], command: Command | None) -> dict:
    if not method.strip() or not files:
        raise DataError("Completion needs method and actual raw output")
    with mutation(root):
        loaded = load(root)
        _require_integrity(loaded)
        observation = _find(loaded.run, observation_id)
        if observation.completed is not None:
            raise DataError("Observation is already completed; begin a new observation")
        journal_before = (root / "journal.json").read_bytes()
        directory = artifact_path(root, f"artifacts/{observation_id}/{uuid.uuid4().hex}")
        directory.parent.mkdir(mode=0o700, exist_ok=True)
        directory.mkdir(mode=0o700, exist_ok=False)
        artifacts = []
        try:
            for filename, raw in files:
                path = directory / filename
                _write_private(path, raw)
                artifacts.append(Artifact(path.relative_to(root).as_posix(), digest(raw)))
            completion = Completed(observation_id, now(), provenance, method, tuple(artifacts), command)
            _append(root, "completed", completion)
        except BaseException:
            # An error can follow publication; never remove potentially committed output.
            try:
                unpublished = (root / "journal.json").read_bytes() == journal_before
            except OSError:
                unpublished = False
            if unpublished:
                shutil.rmtree(directory)
            raise
        return {"observation_id": observation_id, "status": "unassessed", "provenance": provenance,
                "artifacts": [encode(item) for item in artifacts], "verdict": "unassessed"}


def record(root: Path, observation_id: str, transcript: Path, method: str,
           attachments: tuple[Path, ...] = (), *, allow_opaque_artifacts: bool = False) -> dict:
    data_policy.check_text(method, label="Observation method")
    raw = data_policy.read_file(transcript, label="Native transcript")
    if not raw.strip():
        raise DataError("Native observation needs a nonempty actual UTF-8 transcript")
    files = [("transcript.txt", raw)]
    for index, source in enumerate(attachments):
        files.append((f"attachment-{index}{source.suffix}", data_policy.read_file(
            source, label="Selected attachment", allow_opaque=allow_opaque_artifacts)))
    return _complete(root, observation_id, method, "attested_native", tuple(files), None)


def _capture_output(process: subprocess.Popen, timeout: float) -> tuple[bytes, bytes, bool]:
    """Drain both pipes while retaining at most one byte beyond each stream cap."""
    buffers = {process.stdout: bytearray(), process.stderr: bytearray()}
    deadline = time.monotonic() + timeout
    timed_out = False

    def kill_group():
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    with selectors.DefaultSelector() as selector:
        for stream in buffers:
            selector.register(stream, selectors.EVENT_READ)
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                if timed_out:
                    break
                timed_out = True
                kill_group()
                deadline = time.monotonic() + 1
                remaining = 1
            for key, _ in selector.select(min(remaining, 60)):
                chunk = os.read(key.fd, 65536)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                buffer = buffers[key.fileobj]
                buffer.extend(chunk[:max(0, data_policy.MAX_BYTES + 1 - len(buffer))])
    for stream in buffers:
        stream.close()
    try:
        process.wait(timeout=max(0, deadline - time.monotonic()))
    except subprocess.TimeoutExpired:
        timed_out = True
        kill_group()
        process.wait()
    return bytes(buffers[process.stdout]), bytes(buffers[process.stderr]), timed_out


def capture(root: Path, experiment_id: str, argv: list[str], timeout: float,
            cwd: Path | None = None) -> dict:
    if not argv or any(not isinstance(item, str) for item in argv):
        raise DataError("Provide a literal command after --")
    if not math.isfinite(timeout) or timeout <= 0:
        raise DataError("Timeout must be finite and greater than zero")
    data_policy.check_argv(argv)
    directory = (cwd or Path.cwd()).resolve(strict=True)
    if not directory.is_dir():
        raise DataError("Command working directory must be a directory")
    observation_id = begin(root, experiment_id)["observation_id"]
    status, exit_code = "completed", None
    try:
        process = subprocess.Popen(argv, cwd=directory, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   start_new_session=True)
        try:
            stdout, stderr, timed_out = _capture_output(process, timeout)
        except BaseException:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            for stream in (process.stdout, process.stderr):
                stream.close()
            process.wait()
            raise
        if timed_out:
            status = "timeout"
        exit_code = process.returncode
    except OSError:
        status, stdout, stderr = "launch_error", b"", b"Command could not be launched or captured safely.\n"
    execution_status = status
    blocked = []
    for label, raw in (("stdout", stdout), ("stderr", stderr)):
        try:
            data_policy.validate_bytes(raw, label=label)
        except DataError as exc:
            blocked.append(str(exc))
    files = (("stdout.bin", stdout), ("stderr.bin", stderr))
    if blocked:
        status = "output_blocked"
        diagnostic = ("Command output was withheld; it is not passing evidence.\n"
                      f"Execution status: {execution_status}.\n" + "\n".join(blocked) + "\n")
        files = (("output-blocked.txt", diagnostic.encode("utf-8")),)
    command = Command(tuple(argv), str(directory), status, exit_code)
    result = _complete(root, observation_id, "Literal local command", "direct_command",
                       files, command)
    result.update(command_status=status, exit_code=exit_code)
    if blocked:
        result.update(execution_status=execution_status, output_issues=blocked)
    return result


def assess(root: Path, observation_id: str, result: str, reason: str,
           resolves: tuple[str, ...] = ()) -> dict:
    data_policy.check_text(reason, label="Assessment reason")
    with mutation(root):
        loaded = load(root)
        _require_integrity(loaded)
        observation = _find(loaded.run, observation_id)
        if observation.completed is None or observation.assessment is not None:
            raise DataError("Complete the observation once, then assess it once")
        assessment = parse(Assessment, {"observation_id": observation_id, "assessed_at": now(),
                           "result": result, "reason": reason, "resolves": list(resolves)}, "assessment")
        if not reason.strip() or len(resolves) != len(set(resolves)):
            raise DataError("Assessment needs a reason and unique resolution IDs")
        command = observation.completed.command
        if result == "pass" and command is not None and command.status != "completed":
            raise DataError("Incomplete execution or blocked output cannot establish passing behavior")
        if resolves and result != "pass":
            raise DataError("Only a passing observation can resolve earlier negative observations")
        for old_id in resolves:
            old = _find(loaded.run, old_id)
            if not resolves_observation(Observation(observation.started, observation.completed, assessment), old):
                raise DataError("Resolution needs a later separate passing observation with matching option, environment, scope and capability coverage")
        _append(root, "assessed", assessment)
        return {"observation_id": observation_id, "result": result, "resolves": list(resolves),
                "semantic_review_required": True}


def checkpoint(root: Path, report: dict) -> dict:
    with mutation(root):
        loaded = load(root)
        _require_integrity(loaded)
        journal = _read_journal(root)
        directory = root / "checkpoints"
        if directory.is_symlink():
            raise DataError("checkpoints/ must not be a symlink")
        directory.mkdir(exist_ok=True)
        path = directory / (uuid.uuid4().hex + ".json")
        write_json(path, {"schema_version": 1, "at": now(), "run_id": loaded.run.run_id,
                          "intent": encode(loaded.run.intent), "plan": encode(loaded.run.plan),
                          "journal_length": len(journal["events"]),
                          "journal_sha256": digest(canonical(journal["events"])), "check": report})
        return {"checkpoint": path.relative_to(root).as_posix(), "journal_events": len(journal["events"])}
