"""
sandbox-mcp: A minimal MCP server exposing sandboxed code execution tools.

Wraps sandlock (Landlock + seccomp) for per-call process isolation.
Serves Streamable HTTP MCP at POST /mcp on port 8888 (localhost only).

Important: all tools that call Sandbox.run() are declared async and
offload the blocking native call to a thread pool via run_in_executor.
FastMCP calls sync tools directly on the event loop thread, which causes
sandlock's fork()-based supervisor to fail (sandlock_spawn returns null
when called from within a running asyncio event loop). Making tools async
and using run_in_executor matches the pattern in sandlock's own MCP server.
"""

import asyncio
import logging
import pathlib
import tempfile
from mcp.server.fastmcp import FastMCP
from sandlock import Sandbox, Policy, landlock_abi_version, LandlockUnavailableError

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("sandbox_mcp")

# ---------------------------------------------------------------------------
# Session workspace base directory (mounted as emptyDir in k8s)
# ---------------------------------------------------------------------------

SESSION_BASE = pathlib.Path("/tmp/sessions")
SESSION_BASE.mkdir(parents=True, exist_ok=True)

# Check Landlock availability at startup — log but don't crash; we'll report
# errors per-call if Landlock is unavailable.
_LANDLOCK_ABI = landlock_abi_version()
_MIN_ABI = 6  # sandlock requires ABI v6 (Linux 6.7+)
if _LANDLOCK_ABI < _MIN_ABI:
    import sys
    print(
        f"WARNING: Landlock ABI {_LANDLOCK_ABI} < required {_MIN_ABI}. "
        "Sandboxed execution will fail. Requires Linux 6.7+.",
        file=sys.stderr,
    )
else:
    print(f"sandlock ready: Landlock ABI v{_LANDLOCK_ABI}")

# ---------------------------------------------------------------------------
# MCP server
# ---------------------------------------------------------------------------

mcp = FastMCP("sandbox-mcp", host="0.0.0.0", port=8888)


def _session_workspace(session_id: str) -> pathlib.Path:
    """Return (and create) the workspace directory for a given session."""
    ws = SESSION_BASE / session_id
    ws.mkdir(parents=True, exist_ok=True)
    return ws


def _resolve_safe(ws: pathlib.Path, path: str) -> pathlib.Path | None:
    """Resolve path inside workspace; return None if traversal detected."""
    try:
        resolved = (ws / path).resolve()
        resolved.relative_to(ws.resolve())
        return resolved
    except ValueError:
        return None


def _make_policy(ws: pathlib.Path) -> Policy:
    """
    Build a deny-by-default sandlock Policy for one execution.

    Sandbox rules:
    - Read-only: /usr, /lib, /lib64, /etc (runtime libs + Python stdlib)
    - Read-write: session workspace only
    - No outbound network (net_allow_hosts=[])
    - Memory limit: 256 MiB
    - Process limit: 20
    """
    readable = ["/usr", "/lib", "/etc"]
    lib64 = pathlib.Path("/lib64")
    if lib64.exists() and not lib64.is_symlink():
        readable.append("/lib64")

    return Policy(
        fs_readable=readable,
        fs_writable=[str(ws)],
        net_allow_hosts=[],       # deny all outbound network
        max_memory="256M",
        max_processes=20,
        clean_env=True,
        env={"HOME": str(ws), "TMPDIR": str(ws), "PATH": "/usr/local/bin:/usr/bin:/bin"},
    )


def _run_sandboxed_sync(cmd: list[str], ws: pathlib.Path, timeout: int = 30) -> str:
    """Execute cmd inside a sandlock sandbox and return combined stdout+stderr.

    This is a blocking function — always call it via run_in_executor from
    async tool handlers so it runs in a thread, not on the event loop thread.
    Sandlock's fork()-based supervisor fails when called from within a running
    asyncio event loop (sandlock_spawn returns null).
    """
    import ctypes as _ct
    import threading as _th
    try:
        policy = _make_policy(ws)
        log.info(
            "spawn: cmd=%s ws=%s tid=%s pid=%s threads=%s",
            cmd, ws, _th.get_ident(), __import__('os').getpid(),
            _th.active_count(),
        )
        result = Sandbox(policy).run(cmd, timeout=float(timeout))
        log.info("done: success=%s exit=%s error=%s", result.success, result.exit_code, getattr(result, "error", None))
        output = result.stdout.decode(errors="replace")
        stderr = result.stderr.decode(errors="replace")
        if stderr:
            output = output + ("\n" if output else "") + stderr
        if not result.success:
            error_detail = getattr(result, "error", None)
            prefix = f"[exit {result.exit_code}]"
            if error_detail:
                prefix += f" {error_detail}"
            output = prefix + ("\n" + output if output else "")
        return output or "(no output)"
    except LandlockUnavailableError as exc:
        log.error("LandlockUnavailable: %s", exc)
        return f"[error] Landlock unavailable on this kernel: {exc}"
    except Exception as exc:  # noqa: BLE001
        log.exception("unexpected error in _run_sandboxed_sync: cmd=%s", cmd)
        return f"[error] {exc}"


async def _run_sandboxed(cmd: list[str], ws: pathlib.Path, timeout: int = 30) -> str:
    """Async wrapper: offloads blocking _run_sandboxed_sync to a thread pool."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(
        None, _run_sandboxed_sync, cmd, ws, timeout
    )


# ---------------------------------------------------------------------------
# Tools — all async so FastMCP dispatches them correctly and we can
# await run_in_executor for the blocking Sandbox.run() call.
# ---------------------------------------------------------------------------

@mcp.tool()
async def execute_python(code: str, session_id: str = "default") -> str:
    """Execute Python code in a sandboxed environment.

    The code runs inside a sandlock sandbox (Landlock + seccomp):
    - Read-only access to /usr, /lib, /etc
    - Read-write access to the session workspace only
    - No network access
    - Memory limit: 256 MiB

    Args:
        code: Python source code to execute.
        session_id: Workspace identifier — use the same ID across calls to share files.

    Returns:
        Combined stdout and stderr from the execution.
    """
    ws = _session_workspace(session_id)
    # Write code to a temp file in the workspace (avoids ARG_MAX limits with
    # long scripts; the root filesystem is read-only — only /tmp/sessions is
    # writable via emptyDir).
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".py", dir=ws, delete=False, prefix="_exec_"
    ) as f:
        f.write(code)
        script_path = f.name
    try:
        return await _run_sandboxed(["python3", script_path], ws)
    finally:
        try:
            pathlib.Path(script_path).unlink()
        except OSError:
            pass


@mcp.tool()
async def run_shell(command: str, session_id: str = "default") -> str:
    """Run a shell command in a sandboxed environment.

    The command runs via sh -c inside a sandlock sandbox (Landlock + seccomp):
    - Read-only access to /usr, /lib, /etc
    - Read-write access to the session workspace only
    - No network access
    - Memory limit: 256 MiB

    Args:
        command: Shell command to execute.
        session_id: Workspace identifier — use the same ID across calls to share files.

    Returns:
        Combined stdout and stderr from the execution.
    """
    ws = _session_workspace(session_id)
    return await _run_sandboxed(["sh", "-c", command], ws)


@mcp.tool()
def read_file(path: str, session_id: str = "default") -> str:
    """Read a file from the session workspace.

    Args:
        path: Relative path within the session workspace.
        session_id: Workspace identifier.

    Returns:
        File contents as a string, or an error message.
    """
    ws = _session_workspace(session_id)
    resolved = _resolve_safe(ws, path)
    if resolved is None:
        return "Error: path traversal denied"
    if not resolved.exists():
        return f"Error: file not found: {path}"
    if resolved.is_dir():
        return f"Error: {path} is a directory, not a file"
    try:
        return resolved.read_text(errors="replace")
    except OSError as exc:
        return f"Error reading file: {exc}"


@mcp.tool()
def write_file(path: str, content: str, session_id: str = "default") -> str:
    """Write a file to the session workspace.

    Args:
        path: Relative path within the session workspace.
        content: File content to write.
        session_id: Workspace identifier.

    Returns:
        Confirmation message or an error message.
    """
    ws = _session_workspace(session_id)
    resolved = _resolve_safe(ws, path)
    if resolved is None:
        return "Error: path traversal denied"
    try:
        resolved.parent.mkdir(parents=True, exist_ok=True)
        resolved.write_text(content)
        return f"Written {len(content)} bytes to {path}"
    except OSError as exc:
        return f"Error writing file: {exc}"


@mcp.tool()
def list_files(path: str = ".", session_id: str = "default") -> str:
    """List files and directories in the session workspace.

    Args:
        path: Relative path within the session workspace (default: workspace root).
        session_id: Workspace identifier.

    Returns:
        Newline-separated list of entries prefixed with 'd' (dir) or 'f' (file).
    """
    ws = _session_workspace(session_id)
    resolved = _resolve_safe(ws, path)
    if resolved is None:
        return "Error: path traversal denied"
    if not resolved.exists():
        return f"Error: directory not found: {path}"
    if not resolved.is_dir():
        return f"Error: {path} is not a directory"
    try:
        entries = sorted(resolved.iterdir(), key=lambda e: (e.is_file(), e.name))
        if not entries:
            return "(empty directory)"
        return "\n".join(
            f"{'d' if e.is_dir() else 'f'} {e.name}" for e in entries
        )
    except OSError as exc:
        return f"Error listing directory: {exc}"


# ---------------------------------------------------------------------------
# Debug middleware + spawn test endpoint
#
# Logs the raw JSON body of every incoming MCP POST (truncated to 2 KB so
# we can see exactly what LobeHub sends without drowning the logs).
# Also exposes GET /debug/spawn — curl it from inside the pod to trigger
# a sandlock spawn from within the running server process and see if it works.
# ---------------------------------------------------------------------------

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request as StarletteRequest
from starlette.responses import JSONResponse
from starlette.routing import Route


class _LogBodyMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: StarletteRequest, call_next):
        if request.method == "POST" and request.url.path == "/mcp":
            try:
                body = await request.body()
                log.info("MCP POST body (%d bytes): %s", len(body), body[:2048].decode(errors="replace"))
            except Exception:
                pass
        return await call_next(request)


def _debug_spawn_sync() -> dict:
    """Run sandlock spawn synchronously — call from run_in_executor."""
    import os, ctypes, ctypes.util, threading
    from sandlock import Sandbox, Policy
    from sandlock._sdk import _lib, _NativePolicy, _make_argv

    info = {
        "pid": os.getpid(),
        "tid": threading.get_ident(),
        "active_threads": threading.active_count(),
    }

    # Read seccomp filter count for this thread
    try:
        with open(f"/proc/self/status") as f:
            for line in f:
                if "Seccomp" in line:
                    info["seccomp"] = line.strip()
    except Exception as e:
        info["seccomp_err"] = str(e)

    ws = _session_workspace("__debug__")
    with tempfile.NamedTemporaryFile(mode="w", suffix=".py", dir=ws, delete=False, prefix="_dbg_") as f:
        f.write("print('debug spawn ok')\n")
        sp = f.name

    try:
        # Test 1: minimal policy (no net restriction)
        p_min = Policy(
            fs_readable=["/usr", "/lib", "/etc"],
            fs_writable=[str(ws)],
            clean_env=True,
            env={"HOME": str(ws), "TMPDIR": str(ws), "PATH": "/usr/local/bin:/usr/bin:/bin"},
        )
        r_min = Sandbox(p_min).run(["python3", sp], timeout=5.0)
        info["minimal_policy"] = {"ok": r_min.success, "error": getattr(r_min, "error", None)}

        # Test 2: full policy as used by tools
        p_full = _make_policy(ws)
        r_full = Sandbox(p_full).run(["python3", sp], timeout=5.0)
        info["full_policy"] = {"ok": r_full.success, "error": getattr(r_full, "error", None)}

        # Test 3: raw fork()
        libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
        pid = os.fork()
        if pid == 0:
            os._exit(0)
        os.waitpid(pid, 0)
        info["fork"] = "ok"

    except Exception as exc:
        info["exception"] = str(exc)
    finally:
        pathlib.Path(sp).unlink(missing_ok=True)

    return info


async def _debug_spawn(request: StarletteRequest):
    """Trigger sandlock spawn tests from within the server process."""
    loop = asyncio.get_event_loop()
    info = await loop.run_in_executor(None, _debug_spawn_sync)
    log.info("debug_spawn result: %s", info)
    return JSONResponse(info)


# ---------------------------------------------------------------------------
# Entry point — mount middleware and debug route onto the FastMCP ASGI app
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    from starlette.applications import Starlette

    # Get the underlying ASGI app from FastMCP and wrap it
    _fastmcp_app = mcp.streamable_http_app()
    _app = Starlette(
        routes=[
            Route("/debug/spawn", _debug_spawn, methods=["GET"]),
        ],
    )

    # Chain: debug routes first, then MCP app for everything else
    from starlette.middleware.base import BaseHTTPMiddleware as _BM

    class _Router:
        def __init__(self):
            self._debug = _app
            self._mcp = _fastmcp_app

        async def __call__(self, scope, receive, send):
            if scope["type"] == "http" and scope["path"].startswith("/debug/"):
                await self._debug(scope, receive, send)
            else:
                await self._mcp(scope, receive, send)

    _router = _Router()
    _wrapped = _LogBodyMiddleware(_router)

    uvicorn.run(_wrapped, host="0.0.0.0", port=8888)
