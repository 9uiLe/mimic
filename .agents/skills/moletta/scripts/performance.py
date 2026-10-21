"""Bounded local measurement import and descriptive comparison; no device control."""

from __future__ import annotations

import csv
import hashlib
import io
import json
import math
from pathlib import Path
import re
import statistics

import data_policy
from model import DataError


FORMATS = ("csv", "jsonl", "xcresult-metrics-json", "android-benchmark-json")
CONTEXT_FIELDS = ("platform", "device", "device_kind", "os_version", "environment",
                  "scenario", "build_revision", "collector")
GROUP_FIELDS = ("metric", "unit", *CONTEXT_FIELDS)
SAMPLE_FIELDS = (*GROUP_FIELDS, "sample_id", "value")
STATISTICS = ("mean", "p50", "p95", "minimum", "maximum")
MAX_BYTES = 16 * 1024 * 1024
MAX_SAMPLES = 100_000
MAX_GROUPS = 1_000
METHOD = "arithmetic mean; p50/p95 linear interpolation at p*(n-1) on sorted samples"
LIMITS = ("Descriptive measurements only; no causal, statistical-significance, correctness, "
          "or real-device UX verdict. Context labels are declared or imported, not independently verified.")


def _canonical(value: object) -> bytes:
    try:
        return json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True,
                          separators=(",", ":")).encode("utf-8")
    except (UnicodeEncodeError, ValueError, RecursionError) as error:
        raise DataError("Metadata must be finite JSON with valid Unicode and bounded nesting") from error


def _hash(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _object(value: object, path: str) -> dict:
    if not isinstance(value, dict):
        raise DataError(f"{path}: expected an object")
    return value


def _fields(value: object, names: tuple[str, ...], path: str) -> dict:
    value = _object(value, path)
    if set(value) != set(names):
        raise DataError(f"{path}: missing fields {sorted(set(names) - set(value))}; "
                        f"unknown fields {sorted(set(value) - set(names))}")
    return value


def _text(value: object, path: str) -> str:
    if (not isinstance(value, str) or not value.strip() or len(value) > 2048
            or any(ord(char) < 32 or 0x7F <= ord(char) < 0xA0 or 0xD800 <= ord(char) <= 0xDFFF for char in value)):
        raise DataError(f"{path}: expected nonempty text, at most 2048 characters, without control characters")
    data_policy.check_text(value, label="Measurement field")
    return value


def _number(value: object, path: str) -> float:
    if type(value) not in (int, float):
        raise DataError(f"{path}: expected a finite numeric sample")
    try:
        result = float(value)
    except OverflowError as error:
        raise DataError(f"{path}: numeric sample is outside finite range") from error
    if not math.isfinite(result):
        raise DataError(f"{path}: expected a finite numeric sample")
    return result


def _array(value: object, path: str, *, nonempty: bool = True) -> list:
    if not isinstance(value, list) or (nonempty and not value):
        raise DataError(f"{path}: expected {'a nonempty' if nonempty else 'an'} array")
    return value


def _json(text: str, path: str) -> object:
    return data_policy.decode_json(text.encode("utf-8"), label=path, max_bytes=MAX_BYTES)


def _read(path: Path) -> bytes:
    if path.is_symlink():
        raise DataError("Selected measurement files must not be symlinks")
    if not path.is_file():
        raise DataError("Expected a local measurement file, not a bundle or directory. "
                        "Export structured metrics first; see references/performance.md.")
    return data_policy.read_file(path, label="Selected measurement file", max_bytes=MAX_BYTES)


def read_context(path: Path) -> dict:
    """Read an explicitly selected sidecar with the same size/JSON integrity checks."""
    try:
        return _object(_json(_read(Path(path)).decode("utf-8-sig"), "context"), "context")
    except UnicodeDecodeError as error:
        raise DataError("Context must use UTF-8") from error


def _canonical_rows(text: str, format: str):
    if format == "jsonl":
        for line_number, line in enumerate(text.splitlines(), 1):
            if not line.strip():
                raise DataError(f"line {line_number}: blank or missing sample")
            yield _json(line, f"line {line_number}"), f"line {line_number}"
        return
    try:
        reader = csv.reader(io.StringIO(text, newline=""), strict=True)
        header = next(reader, [])
        if len(header) != len(set(header)) or set(header) != set(SAMPLE_FIELDS):
            raise DataError(f"CSV header must contain exactly: {','.join(SAMPLE_FIELDS)}")
        for values in reader:
            path = f"CSV record ending at line {reader.line_num}"
            if len(values) != len(header):
                raise DataError(f"{path}: missing or extra cells; no sample was discarded")
            row = dict(zip(header, values))
            if not re.fullmatch(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?", row["value"]):
                raise DataError(f"{path}.value: expected a finite decimal number")
            row["value"] = float(row["value"])
            yield row, path
    except csv.Error as error:
        raise DataError("Malformed CSV; no samples were discarded") from error


def _adapter_context(context: dict | None, fields: tuple[str, ...]) -> dict:
    if context is None:
        raise DataError("This structured export requires --context; see references/performance.md")
    context = _fields(context, fields, "context")
    for key in fields:
        if key != "units":
            _text(context[key], f"context.{key}")
    return context


def _xcresult_rows(value: object, context: dict | None):
    meta = _adapter_context(context, ("platform", "device_kind", "os_version", "environment",
                                      "build_revision", "collector"))
    if meta["platform"] != "ios":
        raise DataError("xcresult-metrics-json context.platform must be ios")
    devices = set()
    for test_index, test in enumerate(_array(value, "xcresult metrics")):
        path = f"tests[{test_index}]"
        test = _object(test, path)
        _text(test.get("testIdentifier"), f"{path}.testIdentifier")
        if not test.get("testIdentifierURL"):
            raise DataError(f"{path}.testIdentifierURL is required to distinguish test targets; "
                            "export using xcresulttool get test-results metrics (Xcode 16.3 or newer)")
        ident = _text(test["testIdentifierURL"], f"{path}.testIdentifierURL")
        for run_index, run in enumerate(_array(test.get("testRuns"), f"{path}.testRuns")):
            run_path = f"{path}.testRuns[{run_index}]"
            run = _object(run, run_path)
            device = _fields(run.get("device"), ("deviceId", "deviceName"), f"{run_path}.device")
            device_id = _text(device["deviceId"], f"{run_path}.device.deviceId")
            device_name = _text(device["deviceName"], f"{run_path}.device.deviceName")
            devices.add(device_id)
            if len(devices) > 1:
                raise DataError("xcresult export contains multiple devices; export one device per file/context")
            configuration = _fields(run.get("testPlanConfiguration"),
                                    ("configurationId", "configurationName"), f"{run_path}.testPlanConfiguration")
            for key, item in configuration.items():
                _text(item, f"{run_path}.testPlanConfiguration.{key}")
            scenario = _canonical({"test": ident, "configuration": configuration}).decode("utf-8")
            for metric_index, metric in enumerate(_array(run.get("metrics"), f"{run_path}.metrics")):
                metric_path = f"{run_path}.metrics[{metric_index}]"
                metric = _object(metric, metric_path)
                _text(metric.get("displayName"), f"{metric_path}.displayName")
                name = metric.get("identifier", metric.get("displayName"))
                for sample_index, sample in enumerate(_array(metric.get("measurements"), f"{metric_path}.measurements")):
                    yield {**meta, "device": f"{device_name} [sha256:{_hash(device_id.encode())}]",
                           "scenario": scenario, "metric": name, "unit": metric.get("unitOfMeasurement"),
                           "sample_id": f"{test_index}:{run_index}:{sample_index}", "value": sample}, metric_path


def _android_rows(value: object, context: dict | None):
    meta = _adapter_context(context, ("device", "device_kind", "environment", "build_revision", "collector", "units"))
    units = _object(meta["units"], "context.units")
    value = _object(value, "Android benchmark")
    source_context = _object(value.get("context"), "Android benchmark.context")
    build = _object(source_context.get("build"), "Android benchmark.context.build")
    fingerprint = _text(build.get("fingerprint"), "Android benchmark.context.build.fingerprint")
    version = _object(build.get("version"), "Android benchmark.context.build.version")
    if type(version.get("sdk")) is not int or version["sdk"] <= 0:
        raise DataError("Android benchmark.context.build.version.sdk: expected a positive integer")
    seen_metrics = set()
    for test_index, test in enumerate(_array(value.get("benchmarks"), "Android benchmark.benchmarks")):
        path = f"benchmarks[{test_index}]"
        test = _object(test, path)
        sampled = _object(test.get("sampledMetrics", {}), f"{path}.sampledMetrics")
        if sampled:
            raise DataError(f"{path}.sampledMetrics: nested sampled metrics are unsupported; "
                            "export an explicitly defined per-iteration metric to CSV/JSONL. No frame samples were flattened.")
        name = _text(test.get("name"), f"{path}.name")
        class_name = _text(test.get("className"), f"{path}.className")
        params = _object(test.get("params"), f"{path}.params")
        for key, item in params.items():
            _text(key, f"{path}.params key")
            _text(item, f"{path}.params value")
        scenario = _canonical({"class": class_name, "test": name, "params": params}).decode("utf-8")
        conditions = {key: test.get(key) for key in ("warmupIterations", "repeatIterations", "thermalThrottleSleepSeconds")}
        environment = _canonical({"declared": meta["environment"], "source_context_sha256": _hash(_canonical(source_context)),
                                  "iteration_conditions": conditions}).decode("utf-8")
        metrics = _object(test.get("metrics"), f"{path}.metrics")
        if not metrics:
            raise DataError(f"{path}.metrics: no flat numeric metrics")
        for metric_name, metric in metrics.items():
            seen_metrics.add(metric_name)
            if metric_name not in units:
                raise DataError(f"{path}: every metric needs an explicit unit in context.units; see references/performance.md")
            metric = _object(metric, f"{path}.metrics entry")
            for sample_index, sample in enumerate(_array(metric.get("runs"), f"{path}.metrics.runs")):
                yield {key: item for key, item in {
                    **meta, "platform": "android", "os_version": f"SDK {version['sdk']}; {fingerprint}",
                    "environment": environment, "scenario": scenario, "metric": metric_name,
                    "unit": units[metric_name], "sample_id": f"{test_index}:{sample_index}", "value": sample,
                }.items() if key != "units"}, f"{path}.metrics.runs[{sample_index}]"
    if set(units) != seen_metrics:
        raise DataError("context.units must match the imported metric names exactly")


def _group(row: object, path: str) -> tuple[tuple[str, ...], str, float]:
    row = _fields(row, SAMPLE_FIELDS, path)
    for key in (*GROUP_FIELDS, "sample_id"):
        _text(row[key], f"{path}.{key}")
    if row["platform"] not in ("ios", "android"):
        raise DataError(f"{path}.platform: expected ios or android")
    allowed_kind = ("physical", "simulator") if row["platform"] == "ios" else ("physical", "emulator")
    if row["device_kind"] not in allowed_kind:
        raise DataError(f"{path}.device_kind: expected one of {allowed_kind}")
    return tuple(row[key] for key in GROUP_FIELDS), row["sample_id"], _number(row["value"], f"{path}.value")


def _statistics(samples: list[float]) -> dict:
    ordered = sorted(samples)
    def percentile(p: float) -> float:
        position = p * (len(ordered) - 1)
        low = int(position)
        fraction = position - low
        return (1 - fraction) * ordered[low] + fraction * ordered[min(low + 1, len(ordered) - 1)]
    try:
        result = {"count": len(samples), "mean": statistics.mean(samples),
                  "p50": percentile(.50), "p95": percentile(.95), "minimum": ordered[0], "maximum": ordered[-1]}
    except OverflowError as error:
        raise DataError("Summary arithmetic exceeds finite range; choose suitable measurement units") from error
    for key in STATISTICS:
        _number(result[key], f"statistics.{key}")
    return result


def summarize(path: Path, format: str, context: dict | None = None) -> dict:
    """Read only the selected bounded file; return aggregates without raw samples or paths."""
    if format not in FORMATS:
        raise DataError(f"Unsupported measurement format. Choose one of {FORMATS}; "
                        "Instruments traces, xcresult bundles, Perfetto and logcat need an explicit structured metric export.")
    if format in ("csv", "jsonl") and context is not None:
        raise DataError("CSV/JSONL already declare context per sample; --context is only for structured source adapters")
    if context is not None:
        data_policy.validate_bytes(_canonical(context), label="Measurement context", max_bytes=MAX_BYTES)
    raw = _read(Path(path))
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise DataError("Expected UTF-8 structured measurements; binary traces are unsupported") from error
    if format in ("csv", "jsonl"):
        rows = _canonical_rows(text, format)
    elif format == "xcresult-metrics-json":
        rows = _xcresult_rows(_json(text, "xcresult metrics"), context)
    else:
        rows = _android_rows(_json(text, "Android benchmark"), context)
    groups = {}
    count = 0
    for row, location in rows:
        key, sample_id, sample = _group(row, location)
        count += 1
        if count > MAX_SAMPLES:
            raise DataError(f"Input exceeds {MAX_SAMPLES} samples; export a narrower measurement selection")
        if key not in groups:
            if len(groups) >= MAX_GROUPS:
                raise DataError(f"Input exceeds {MAX_GROUPS} measurement groups")
            groups[key] = ({}, [])
        ids, samples = groups[key]
        if sample_id in ids:
            raise DataError(f"{location}: duplicate sample_id within the same metric/context; no samples were deduplicated")
        ids[sample_id] = True
        samples.append(sample)
    if not groups:
        raise DataError("Input contains no samples")
    return {"schema_version": 1, "kind": "performance_summary", "source": {
                "sha256": _hash(raw), "bytes": len(raw), "format": format,
                "context_sha256": _hash(_canonical(context)) if context is not None else None},
            "method": METHOD, "limitations": LIMITS, "sample_count": count,
            "groups": [{**dict(zip(GROUP_FIELDS, key)), "statistics": _statistics(groups[key][1])}
                       for key in sorted(groups)]}


def validate_summary(value: object) -> dict:
    """Validate saved aggregate shape and arithmetic constraints, not source authenticity."""
    value = _fields(value, ("schema_version", "kind", "source", "method", "limitations", "sample_count", "groups"), "summary")
    if type(value["schema_version"]) is not int or value["schema_version"] != 1 or value["kind"] != "performance_summary":
        raise DataError("Unsupported performance summary schema")
    if value["method"] != METHOD or value["limitations"] != LIMITS:
        raise DataError("Summary method or limitations do not match the supported contract")
    source = _fields(value["source"], ("sha256", "bytes", "format", "context_sha256"), "summary.source")
    for key in ("sha256", "context_sha256"):
        if key == "context_sha256" and source[key] is None:
            continue
        if not isinstance(source[key], str) or not re.fullmatch(r"[0-9a-f]{64}", source[key]):
            raise DataError(f"summary.source.{key}: expected SHA-256")
    if source["format"] not in FORMATS or type(source["bytes"]) is not int or not 0 < source["bytes"] <= MAX_BYTES:
        raise DataError("summary.source: unsupported format or byte count")
    groups = _array(value["groups"], "summary.groups")
    if len(groups) > MAX_GROUPS:
        raise DataError("Summary exceeds the group limit")
    keys, count = set(), 0
    for index, group in enumerate(groups):
        path = f"summary.groups[{index}]"
        group = _fields(group, (*GROUP_FIELDS, "statistics"), path)
        key, _, _ = _group({**{name: group[name] for name in GROUP_FIELDS}, "sample_id": "validation", "value": 0}, path)
        if key in keys:
            raise DataError("Summary contains duplicate groups")
        keys.add(key)
        stats = _fields(group["statistics"], ("count", *STATISTICS), f"{path}.statistics")
        if type(stats["count"]) is not int or not 1 <= stats["count"] <= MAX_SAMPLES:
            raise DataError(f"{path}.statistics.count: expected positive bounded sample count")
        count += stats["count"]
        for name in STATISTICS:
            _number(stats[name], f"{path}.statistics.{name}")
        if not (stats["minimum"] <= stats["p50"] <= stats["p95"] <= stats["maximum"]
                and stats["minimum"] <= stats["mean"] <= stats["maximum"]):
            raise DataError(f"{path}.statistics: inconsistent ranges")
    if type(value["sample_count"]) is not int or value["sample_count"] != count or count > MAX_SAMPLES:
        raise DataError("summary.sample_count does not match its groups or exceeds the sample limit")
    return value


def load_summary(path: Path) -> dict:
    try:
        return validate_summary(_json(_read(Path(path)).decode("utf-8-sig"), "summary"))
    except UnicodeDecodeError as error:
        raise DataError("Summary must use UTF-8") from error


def compare(baseline: dict, candidate: dict) -> dict:
    """Compare exactly matched measurement contexts; build revision alone may differ."""
    baseline, candidate = validate_summary(baseline), validate_summary(candidate)
    match_fields = tuple(name for name in GROUP_FIELDS if name != "build_revision")
    def index(summary: dict) -> dict:
        result = {}
        for group in summary["groups"]:
            key = tuple(group[name] for name in match_fields)
            if key in result:
                raise DataError("Comparison requires one build per metric/context in each summary")
            result[key] = group
        return result
    base, cand = index(baseline), index(candidate)
    if set(base) != set(cand):
        raise DataError("Comparison refused: metric/unit/device/platform/OS/environment/scenario/collector sets differ. "
                        "Only build_revision may differ; export matched contexts without silently dropping groups.")
    rows = []
    for key in sorted(base):
        before, after = base[key], cand[key]
        deltas = {}
        for statistic in STATISTICS:
            old, new = before["statistics"][statistic], after["statistics"][statistic]
            delta = _number(new - old, f"comparison.{statistic}.delta")
            percent = None if old == 0 else _number(delta / abs(old) * 100, f"comparison.{statistic}.percent")
            deltas[statistic] = {"absolute": delta, "percent": percent}
        rows.append({**dict(zip(match_fields, key)), "baseline_build": before["build_revision"],
                     "candidate_build": after["build_revision"], "baseline": before["statistics"],
                     "candidate": after["statistics"], "candidate_minus_baseline": deltas})
    return {"schema_version": 1, "kind": "performance_comparison", "method": METHOD,
            "limitations": LIMITS, "percent_definition": "100 * (candidate - baseline) / abs(baseline); null when baseline is zero",
            "baseline_summary_sha256": _hash(_canonical(baseline)), "candidate_summary_sha256": _hash(_canonical(candidate)),
            "baseline_source": baseline["source"], "candidate_source": candidate["source"], "groups": rows}
