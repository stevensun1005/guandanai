"""No-console launcher for the existing single-instance GuanZero watchdog."""
import datetime
import json
import os
import subprocess
import sys
from pathlib import Path

def main(config_file):
    config = json.loads(Path(config_file).read_text(encoding="utf-8"))
    run = Path(config["run"])
    window = json.loads((run / "window.json").read_text(encoding="utf-8"))
    end = datetime.datetime.fromisoformat(window["plannedEnd"].replace("Z", "+00:00"))
    if datetime.datetime.now(datetime.timezone.utc) >= end:
        return 0
    env = os.environ.copy()
    env["PATH"] = config["gitBin"] + ";" + str(Path(config["node"]).parent) + ";" + env.get("PATH", "")
    command = [config["node"], config["watchdog"], str(run), config["runtime"], config["control"]]
    with (Path(config["control"]) / "training-launcher.stdout.log").open("ab") as out, (Path(config["control"]) / "training-launcher.stderr.log").open("ab") as err:
        return subprocess.run(command, cwd=config["runtime"], env=env, stdin=subprocess.DEVNULL, stdout=out, stderr=err, creationflags=subprocess.CREATE_NO_WINDOW, check=False).returncode

if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1]))
