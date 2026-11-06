"""Bounded Windows sleep request tied to this trainer; does not change the power plan."""

import argparse
import ctypes
from ctypes import wintypes
from datetime import datetime
import json
from pathlib import Path
import os
import time


def main(run, pid):
    run = Path(run)
    deadline = datetime.fromisoformat(
        json.loads((run / "protocol.json").read_text())["deadlineUTC"].replace("Z", "+00:00")
    ).timestamp()
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.WaitForSingleObject.restype = wintypes.DWORD
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.SetThreadExecutionState.argtypes = [wintypes.DWORD]
    kernel.SetThreadExecutionState.restype = wintypes.DWORD
    handle = kernel.OpenProcess(0x00100000, False, pid)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        if not kernel.SetThreadExecutionState(0x80000001):
            raise ctypes.WinError(ctypes.get_last_error())
        (run / "awake.json").write_text(
            json.dumps(
                {
                    "pid": os.getpid(),
                    "trainerPID": pid,
                    "request": "ES_SYSTEM_REQUIRED; display can sleep",
                    "latestExpiryUTC": datetime.fromtimestamp(deadline + 3600)
                    .astimezone()
                    .isoformat(),
                    "changesPowerPlan": False,
                }
            )
        )
        # The extra bounded hour covers evaluation/publication, never extra gradient training.
        while time.time() < deadline + 3600:
            status = kernel.WaitForSingleObject(
                handle, min(30000, max(1, int((deadline + 3600 - time.time()) * 1000)))
            )
            if status == 0:
                break
            if status != 258:
                raise ctypes.WinError(ctypes.get_last_error())
    finally:
        kernel.SetThreadExecutionState(0x80000000)
        kernel.CloseHandle(handle)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", required=True)
    parser.add_argument("--pid", type=int, required=True)
    args = parser.parse_args()
    main(args.run, args.pid)
