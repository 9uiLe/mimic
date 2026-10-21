"""Installed-only, owner-scoped mobile device leases shared across worktrees.

Allocation creates an unbooted device. The receipt supplies literal launch argv;
executing it and checking the app remain the host's bounded observation work.
"""

from __future__ import annotations

import fcntl
import json
import math
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path


class DeviceError(ValueError):
    """A missing capability, ownership conflict, or incomplete cleanup."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def state_directory(state_dir: Path | None = None) -> Path:
    if state_dir is not None:
        return Path(state_dir).expanduser().absolute()
    configured = os.environ.get("MOLETTA_DEVICE_STATE")
    if configured:
        return Path(configured).expanduser().absolute()
    if sys.platform == "darwin":
        return Path.home() / "Library/Application Support/moletta/devices"
    return Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state")) / "moletta/devices"


def _read(path: Path) -> dict:
    if path.is_symlink():
        raise DeviceError(f"Device record must not be a symlink: {path}")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise DeviceError(f"Expected a device record object: {path}")
    return value


def _write(path: Path, value: dict) -> None:
    if path.is_symlink():
        raise DeviceError(f"Device record must not be a symlink: {path}")
    temporary = path.with_name(f".{path.name}-{uuid.uuid4().hex}.tmp")
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            os.fchmod(stream.fileno(), 0o600)
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def _directory(path: Path) -> None:
    for ancestor in (path, *path.parents):
        if ancestor.is_symlink():
            raise DeviceError(f"Device storage must not contain symlinks: {ancestor}")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.chmod(0o700)


@contextmanager
def _locked(state: Path):
    _directory(state)
    _directory(state / "leases")
    _directory(state / "resources")
    lock = state / ".lock"
    if lock.is_symlink():
        raise DeviceError("Device allocator lock must not be a symlink")
    descriptor = os.open(lock, os.O_RDWR | os.O_CREAT, 0o600)
    with os.fdopen(descriptor, "a+b") as stream:
        os.fchmod(stream.fileno(), 0o600)
        try:
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise DeviceError("Host device allocator is busy; retry after the other operation finishes") from exc
        try:
            yield
        finally:
            fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def _command(argv: list[str], env: dict | None = None, *, input: str | None = None,
             check: bool = True) -> subprocess.CompletedProcess:
    try:
        result = subprocess.run(argv, env={**os.environ, **(env or {})}, input=input,
                                capture_output=True, text=True, timeout=30, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        reason = "timeout" if isinstance(exc, subprocess.TimeoutExpired) else exc.strerror
        raise DeviceError(f"Device command could not finish: {Path(argv[0]).name}: {reason}") from exc
    if check and result.returncode:
        operation = " ".join([Path(argv[0]).name, *argv[1:3]])
        raise DeviceError(f"Device command failed ({result.returncode}): {operation}; inspect the host tool privately")
    return result


def _sdk(sdk: Path | None) -> Path:
    configured = sdk or os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
    if configured:
        return Path(configured).expanduser().resolve()
    default = Path.home() / ("Library/Android/sdk" if sys.platform == "darwin" else "Android/Sdk")
    return default.resolve()


def _android_tools(sdk: Path) -> dict:
    candidates = [sdk / "cmdline-tools/latest/bin/avdmanager"]
    candidates += sorted((sdk / "cmdline-tools").glob("*/bin/avdmanager"), reverse=True)
    candidates += [sdk / "tools/bin/avdmanager"]
    tools = {}
    for name, paths in (("avdmanager", candidates), ("emulator", [sdk / "emulator/emulator"]),
                        ("adb", [sdk / "platform-tools/adb"])):
        found = next((str(path) for path in paths if path.is_file() and os.access(path, os.X_OK)), None)
        tools[name] = found or shutil.which(name)
    return tools


def inspect(platform: str, *, sdk: Path | None = None) -> dict:
    """Read installed profiles. Never installs packages or creates device state."""
    if platform == "ios":
        executable = shutil.which("xcrun")
        result = {"platform": platform, "runtimes": [], "device_types": [], "diagnostics": [],
                  "tools": {"xcrun": executable}}
        if not executable:
            result["diagnostics"].append("Xcode xcrun is unavailable; iOS requires a macOS Xcode host")
            return result
        try:
            value = json.loads(_command([executable, "simctl", "list", "--json"]).stdout)
            result["runtimes"] = [item for item in value["runtimes"] if item.get("isAvailable") is True]
            result["device_types"] = value["devicetypes"]
        except (DeviceError, KeyError, TypeError, ValueError, AttributeError) as exc:
            result["diagnostics"].append(f"Cannot inspect CoreSimulator: {exc}")
        return result
    if platform != "android":
        raise DeviceError("Device platform must be ios or android")
    sdk = _sdk(sdk)
    tools = _android_tools(sdk)
    images = []
    for properties in sorted((sdk / "system-images").glob("*/*/*/source.properties")):
        if (properties.parent / "system.img").is_file():
            images.append({"identifier": ";".join(properties.parent.relative_to(sdk).parts),
                           "path": str(properties.parent)})
    diagnostics = [f"Required Android tool unavailable: {name}" for name, path in tools.items() if not path]
    types = ""
    if tools["avdmanager"]:
        try:
            types = _command([tools["avdmanager"], "list", "device", "-c"],
                             {"ANDROID_HOME": str(sdk)}).stdout
        except DeviceError as exc:
            diagnostics.append(str(exc))
    return {"platform": platform, "sdk": str(sdk), "runtimes": images,
            "device_types_raw": types, "tools": tools, "diagnostics": diagnostics}


def _validate(lease: dict) -> None:
    ident = lease.get("lease_id")
    if (lease.get("schema_version") != 1 or not isinstance(ident, str)
            or re.fullmatch(r"[0-9a-f]{32}", ident) is None
            or lease.get("name") != f"moletta-{ident}"
            or lease.get("platform") not in ("ios", "android")
            or lease.get("state") not in ("creating", "allocated", "cleanup_pending", "released")
            or not isinstance(lease.get("owner_token"), str)
            or re.fullmatch(r"[0-9a-f]{32}", lease["owner_token"]) is None
            or any(not isinstance(lease.get(key), str) or not Path(lease[key]).is_absolute()
                   for key in ("run", "state_dir"))
            or not isinstance(lease.get("launch_env"), dict)
            or any(not isinstance(key, str) or not isinstance(value, str)
                   for key, value in lease["launch_env"].items())
            or not isinstance(lease.get("tools"), dict)):
        raise DeviceError("Invalid device ownership record")
    try:
        if any(datetime.fromisoformat(lease[key]).tzinfo is None for key in ("created_at", "updated_at")):
            raise ValueError("timezone required")
    except (KeyError, TypeError, ValueError) as exc:
        raise DeviceError("Invalid device lease timestamp") from exc
    required = ("xcrun",) if lease["platform"] == "ios" else ("avdmanager", "emulator", "adb")
    if any(not isinstance(lease["tools"].get(key), str) or not lease["tools"][key] for key in required):
        raise DeviceError("Invalid device tool identity")
    if lease["platform"] == "ios" and lease.get("device_id") is not None:
        try:
            uuid.UUID(lease["device_id"])
        except (ValueError, TypeError, AttributeError) as exc:
            raise DeviceError("Invalid owned simulator identifier") from exc
    if lease["platform"] == "android":
        port = lease.get("port")
        if type(port) is not int or port not in range(5554, 5585, 2):
            raise DeviceError("Invalid owned emulator port")
        if lease.get("destination") != f"emulator-{port}":
            raise DeviceError("Emulator serial differs from its reserved port")


def _receipt(lease: dict) -> Path:
    return Path(lease["run"]) / "devices" / f"{lease['lease_id']}.json"


def _save(state: Path, lease: dict, *, receipt: bool = True) -> None:
    lease["updated_at"] = _now()
    _validate(lease)
    _write(state / "leases" / f"{lease['lease_id']}.json", lease)
    if receipt:
        _directory(_receipt(lease).parent)
        _write(_receipt(lease), lease)


def _leases(state: Path) -> list[dict]:
    values = []
    for path in sorted((state / "leases").glob("*.json")):
        lease = _read(path)
        _validate(lease)
        if path.stem != lease["lease_id"]:
            raise DeviceError("Device registry filename differs from lease identity")
        if lease["state_dir"] != str(state):
            raise DeviceError("Device registry belongs to another state directory")
        values.append(lease)
    return values


def pending(run: Path) -> list[dict]:
    """Read run-local cleanup obligations without touching the host registry."""
    directory = Path(run).resolve() / "devices"
    if directory.is_symlink():
        raise DeviceError("Run device receipts must not be a symlink")
    values = []
    for path in sorted(directory.glob("*.json")):
        lease = _read(path)
        _validate(lease)
        if lease["run"] != str(Path(run).resolve()) or path.stem != lease["lease_id"]:
            raise DeviceError("Run device receipt ownership differs")
        if lease["state"] != "released":
            values.append(lease)
    return values


def status(run: Path | None = None, *, state_dir: Path | None = None) -> dict:
    if run is not None:
        return {"run": str(Path(run).resolve()), "pending": pending(run)}
    state = state_directory(state_dir)
    if not state.exists():
        return {"state_dir": str(state), "leases": []}
    with _locked(state):
        return {"state_dir": str(state), "leases": _leases(state)}


def _ports_free(port: int) -> bool:
    sockets = []
    try:
        for number in (port, port + 1):
            stream = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sockets.append(stream)
            stream.bind(("127.0.0.1", number))
        return True
    except OSError:
        return False
    finally:
        for stream in sockets:
            stream.close()


def _resource(state: Path, lease: dict) -> Path:
    path = state / "resources" / lease["lease_id"]
    if path.is_symlink() or (state / "resources").is_symlink():
        raise DeviceError("Device resource directory must not be a symlink")
    if path.exists() and _read(path / "owner.json") != {"owner_token": lease["owner_token"]}:
        raise DeviceError("Device resource ownership marker differs")
    return path


def allocate(run: Path, platform: str, *, runtime: str, device_type: str,
             state_dir: Path | None = None, sdk: Path | None = None) -> dict:
    """Create one device from an explicit installed profile, never download an OS."""
    run = Path(run).resolve()
    if not run.is_dir():
        raise DeviceError("Initialize the run before allocating a device")
    if not isinstance(runtime, str) or not runtime or not isinstance(device_type, str) or not device_type:
        raise DeviceError("Choose explicit installed runtime and device type identifiers")
    state = state_directory(state_dir)
    inventory = inspect(platform, sdk=sdk)
    if inventory["diagnostics"]:
        raise DeviceError("; ".join(inventory["diagnostics"]))
    if runtime not in {item["identifier"] for item in inventory["runtimes"]}:
        raise DeviceError("Requested runtime/system image is not installed and available; no download attempted")
    if platform == "ios" and device_type not in {item["identifier"] for item in inventory["device_types"]}:
        raise DeviceError("Requested simulator device type is unavailable")
    with _locked(state):
        ident = uuid.uuid4().hex
        lease = {"schema_version": 1, "lease_id": ident, "name": f"moletta-{ident}",
                 "owner_token": uuid.uuid4().hex, "run": str(run), "state_dir": str(state),
                 "platform": platform, "runtime": runtime, "device_type": device_type,
                 "state": "creating", "created_at": _now(), "tools": inventory["tools"],
                 "launch_env": {}}
        if platform == "ios":
            if os.environ.get("DEVELOPER_DIR"):
                lease["launch_env"]["DEVELOPER_DIR"] = os.environ["DEVELOPER_DIR"]
        else:
            reserved = {item["port"] for item in _leases(state)
                        if item["platform"] == "android" and item["state"] != "released"}
            port = next((number for number in range(5554, 5585, 2)
                         if number not in reserved and _ports_free(number)), None)
            if port is None:
                raise DeviceError("No free emulator console/adb port pair; release an owned lease first")
            lease.update(port=port, destination=f"emulator-{port}")
        resource = state / "resources" / ident
        _directory(resource)
        _write(resource / "owner.json", {"owner_token": lease["owner_token"]})
        try:
            _save(state, lease)
            if platform == "ios":
                result = _command([lease["tools"]["xcrun"], "simctl", "create", lease["name"],
                                   device_type, runtime], lease["launch_env"])
                try:
                    ident_value = str(uuid.UUID(result.stdout.strip()))
                except (ValueError, AttributeError) as exc:
                    raise DeviceError("Simulator create returned no valid device identifier") from exc
                lease["device_id"] = ident_value.upper()
                lease["destination"] = lease["device_id"]
                lease["launch_argv"] = [lease["tools"]["xcrun"], "simctl", "boot", lease["device_id"]]
            else:
                avd_home, data = resource / "avd", resource / "data.avd"
                _directory(avd_home)
                lease["launch_env"] = {"ANDROID_HOME": inventory["sdk"],
                                       "ANDROID_AVD_HOME": str(avd_home),
                                       "ANDROID_USER_HOME": str(resource / "android"),
                                       "ANDROID_EMULATOR_HOME": str(resource / "android")}
                _directory(resource / "android")
                _save(state, lease)
                _command([lease["tools"]["avdmanager"], "create", "avd", "--name", lease["name"],
                          "--package", runtime, "--device", device_type, "--path", str(data)],
                         lease["launch_env"], input="no\n")
                lease["launch_argv"] = [lease["tools"]["emulator"], "-avd", lease["name"],
                                        "-port", str(lease["port"]), "-no-snapshot", "-no-boot-anim"]
            lease["state"] = "allocated"
            _save(state, lease)
            return lease
        except (OSError, ValueError) as exc:
            lease["state"] = "cleanup_pending"
            lease["error"] = str(exc)
            # A timed-out create can have created a device. Keep the prewritten
            # identity, discover only that identity, and retain failed cleanup.
            try:
                _cleanup(state, lease)
                lease["state"] = "released"
            except (OSError, ValueError) as cleanup_error:
                lease["cleanup_error"] = str(cleanup_error)
            _save(state, lease, receipt=_receipt(lease).parent.is_dir())
            raise DeviceError(f"Allocation failed; lease {ident} is {lease['state']}: {exc}") from exc


def _ios_devices(lease: dict) -> list[dict]:
    result = _command([lease["tools"]["xcrun"], "simctl", "list", "devices", "--json"],
                      lease["launch_env"])
    try:
        value = json.loads(result.stdout)
        devices = [device for group in value["devices"].values() for device in group]
        if any(not isinstance(device, dict) for device in devices):
            raise ValueError("device entry is not an object")
        return devices
    except (KeyError, TypeError, ValueError, AttributeError) as exc:
        raise DeviceError(f"Cannot read owned simulator identity: {exc}") from exc


def _android_running(name: str) -> bool:
    result = _command(["ps", "-axww", "-o", "command="])
    return any(name in line.split() for line in result.stdout.splitlines())


def _cleanup(state: Path, lease: dict) -> None:
    resource = _resource(state, lease)
    if lease["platform"] == "ios":
        devices = _ios_devices(lease)
        ident = lease.get("device_id")
        matches = [item for item in devices if item.get("udid") == ident] if ident else [
            item for item in devices if item.get("name") == lease["name"]]
        if len(matches) > 1 or any(item.get("name") != lease["name"] for item in matches):
            raise DeviceError("Simulator identity differs; no device was shut down or deleted")
        if not matches and any(item.get("name") == lease["name"] for item in devices):
            raise DeviceError("Simulator name exists under another identifier; inspect before cleanup")
        if matches:
            device = matches[0]
            lease["device_id"] = device["udid"]
            _validate(lease)
            prefix = [lease["tools"]["xcrun"], "simctl"]
            if device.get("state") != "Shutdown":
                _command([*prefix, "shutdown", lease["device_id"]], lease["launch_env"])
            _command([*prefix, "delete", lease["device_id"]], lease["launch_env"])
    else:
        # A recycled serial/port is insufficient ownership evidence. Ask the
        # targeted emulator for its AVD name before issuing its scoped kill.
        if not _ports_free(lease["port"]):
            prefix = [lease["tools"]["adb"], "-s", lease["destination"], "emu"]
            result = _command([*prefix, "avd", "name"], lease["launch_env"])
            if result.stdout.splitlines()[:1] != [lease["name"]]:
                raise DeviceError("Emulator serial belongs to a different AVD; no kill or deletion attempted")
            _command([*prefix, "kill"], lease["launch_env"])
            deadline = time.monotonic() + 10
            while (not _ports_free(lease["port"]) or _android_running(lease["name"])):
                if time.monotonic() >= deadline:
                    raise DeviceError("Owned emulator has not exited; retry release after it stops")
                time.sleep(0.1)
        if _android_running(lease["name"]):
            raise DeviceError("Owned emulator is starting or uses another port; stop it before release")
    if resource.exists():
        shutil.rmtree(resource)


def _release(state: Path, lease: dict, *, receipt: bool = True) -> dict:
    if lease["state"] == "released":
        _save(state, lease, receipt=receipt)
        return lease
    lease["state"] = "cleanup_pending"
    _save(state, lease, receipt=receipt)
    try:
        _cleanup(state, lease)
    except (OSError, ValueError) as exc:
        lease["cleanup_error"] = str(exc)
        _save(state, lease, receipt=receipt)
        raise DeviceError(f"Lease {lease['lease_id']} remains cleanup_pending: {exc}") from exc
    lease["state"] = "released"
    lease.pop("cleanup_error", None)
    _save(state, lease, receipt=receipt)
    return lease


def release(run: Path, lease_id: str, *, state_dir: Path | None = None) -> dict:
    run = Path(run).resolve()
    if not isinstance(lease_id, str) or re.fullmatch(r"[0-9a-f]{32}", lease_id) is None:
        raise DeviceError("Expected the exact lease identifier from the run receipt")
    if (run / "devices").is_symlink():
        raise DeviceError("Run device receipts must not be a symlink")
    local = _read(run / "devices" / f"{lease_id}.json")
    _validate(local)
    state = state_directory(state_dir) if state_dir is not None else Path(local["state_dir"])
    with _locked(state):
        lease = _read(state / "leases" / f"{lease_id}.json")
        _validate(lease)
        if (lease["run"] != str(run) or local["run"] != str(run)
                or lease["owner_token"] != local["owner_token"] or lease["state_dir"] != str(state)):
            raise DeviceError("Run does not own this device lease")
        return _release(state, lease)


def gc(*, state_dir: Path | None = None, older_than_hours: float = 24, apply: bool = False) -> dict:
    """Recover failed or missing-owner leases; intact active runs never age out."""
    if not math.isfinite(older_than_hours) or older_than_hours < 0:
        raise DeviceError("GC minimum age must be finite and nonnegative")
    state = state_directory(state_dir)
    if not state.exists():
        return {"state_dir": str(state), "apply": apply, "candidates": []}
    with _locked(state):
        candidates = []
        for lease in _leases(state):
            age = (datetime.now(timezone.utc) - datetime.fromisoformat(lease["updated_at"])).total_seconds()
            if lease["state"] == "released" or age < older_than_hours * 3600:
                continue
            receipt = _receipt(lease)
            reason = "incomplete_cleanup" if lease["state"] in ("creating", "cleanup_pending") else (
                "missing_run_receipt" if not receipt.exists() else None)
            if reason is None:
                continue
            item = {"lease_id": lease["lease_id"], "run": lease["run"], "reason": reason,
                    "state": lease["state"]}
            if apply:
                try:
                    item["state"] = _release(state, lease, receipt=receipt.exists())["state"]
                except (OSError, ValueError) as exc:
                    item["error"] = str(exc)
                    item["state"] = "cleanup_pending"
            candidates.append(item)
        return {"state_dir": str(state), "apply": apply, "candidates": candidates}
