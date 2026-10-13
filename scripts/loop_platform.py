"""Platform-specific locking and process launch/termination primitives."""
from __future__ import annotations

import contextlib
import errno
import os
from pathlib import Path
import shutil
import signal
import stat
import subprocess
import sys
import time

WINDOWS = os.name == 'nt'
if WINDOWS:
    import msvcrt
else:
    import fcntl


def reject_links(path):
    for entry in (Path(path), *Path(path).parents):
        try:
            info = entry.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise ValueError('State path must not contain symlinks or reparse points')


@contextlib.contextmanager
def file_lock(path, blocking=True):
    reject_links(path)
    fd = os.open(path, os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    with os.fdopen(fd, 'r+b', buffering=0) as stream:
        if WINDOWS:
            # msvcrt locks a byte range, including on an initially empty file.
            while True:
                stream.seek(0)
                try:
                    msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                    break
                except OSError as error:
                    if error.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                        raise
                    if not blocking:
                        raise BlockingIOError('Lock is held by another process') from error
                    time.sleep(.05)
        else:
            fcntl.flock(fd, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        try:
            yield stream
        finally:
            if WINDOWS:
                stream.seek(0)
                msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(fd, fcntl.LOCK_UN)


def executable_prefix(executable):
    resolved = shutil.which(str(executable)) or str(executable)
    path = Path(resolved)
    if path.suffix.lower() == '.py':
        return [sys.executable, str(path.resolve())]
    if WINDOWS and path.suffix.lower() in {'.cmd', '.bat', '.ps1'}:
        # npm's shim needs cmd.exe; use its actual JS entrypoint instead so
        # quotes in -c arguments and paths never pass through shell parsing.
        entry = path.parent / 'node_modules' / '@openai' / 'codex' / 'bin' / 'codex.js'
        node = shutil.which('node')
        if path.stem.lower() == 'codex' and entry.is_file() and node:
            return [node, str(entry.resolve())]
        raise ValueError('Use --codex with codex.exe, or install the standard npm Codex package and Node.js')
    return [resolved]


def process_options():
    return {'creationflags': subprocess.CREATE_NEW_PROCESS_GROUP} if WINDOWS else {'start_new_session': True}


def terminate(process):
    if process.poll() is not None:
        return
    if WINDOWS:
        # Kill the owned PID and its descendants, never by executable name.
        tool = Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'System32' / 'taskkill.exe'
        result = subprocess.run([str(tool), '/PID', str(process.pid), '/T', '/F'],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
        if result.returncode and process.poll() is None:
            raise RuntimeError('Could not terminate the owned Windows worker process tree')
        process.wait(timeout=5)
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=3)
    except ProcessLookupError:
        pass


def stop_signals():
    return [getattr(signal, name) for name in ('SIGTERM', 'SIGHUP', 'SIGBREAK') if hasattr(signal, name)]
