#!/usr/bin/env python3
"""Exercise UI actions in an installed, separately identified IGNIS Lab clone.

The tool never prints the local automation capability token. It reads only
the clone's own receipt and invokes the fixed, allowlisted marker target.
It deliberately has no access to the original Obsidian bundle or Vault.
"""

import argparse
import json
import os
import shlex
import subprocess
import time
import urllib.parse
from pathlib import Path


def run_ssh(port: int, key_file: Path, command: str) -> str:
    command_line = [
        "ssh", "-F", "/dev/null", "-p", str(port), "-i", str(key_file),
        "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=yes",
        "-o", "UserKnownHostsFile=" + str(
            Path.home() / ".ssh/known_hosts_iphone8_usb_root2222"
        ),
        "mobile@127.0.0.1", command,
    ]
    completed = subprocess.run(
        command_line, capture_output=True, text=True, timeout=12,
        check=False,
    )
    if completed.returncode:
        raise RuntimeError("Wired SSH request failed, exit "
                           + str(completed.returncode))
    return completed.stdout


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--private-receipt", type=Path, required=True)
    parser.add_argument("--remote-receipt", type=str, required=True)
    parser.add_argument("--action", choices=("tap", "inspect", "control-tap",
                                              "control-type", "connector-settings",
                                              "connector-auth-from-file"),
                        default="tap")
    parser.add_argument("--index", type=int, default=None)
    parser.add_argument("--value", type=str, default=None)
    parser.add_argument("--ssh-port", type=int, default=2222)
    parser.add_argument("--key-file", type=Path,
                        default=Path.home() / ".ssh/iphone8_fairplay_ed25519")
    args = parser.parse_args()
    if args.private_receipt.stat().st_mode & 0o077:
        raise ValueError("Private test token file must be mode 0600")
    private = json.loads(args.private_receipt.read_text("utf8"))
    if private.get("expectedBundleID") != "dev.ignis.obsidian.lab":
        raise ValueError("Unexpected app identity")
    token = private.get("token", "")
    if len(token) < 32:
        raise ValueError("Missing private automation token")
    receipt_path = args.remote_receipt
    if not receipt_path.startswith(
        "/var/mobile/Containers/Data/Application/"
    ) or not receipt_path.endswith("/Documents/ignis-ui-automation-receipt.json"):
        raise ValueError("Receipt must belong to an app Documents container")

    def read_receipt():
        return json.loads(run_ssh(
            args.ssh_port, args.key_file, "cat " + shlex.quote(receipt_path)
        ))

    before = read_receipt()
    if (before.get("protocol") != "ignis-ui-automation-v1"
            or not before.get("ok")):
        raise ValueError("Missing trusted initial automation receipt")
    if args.action.startswith("control-") and (
        args.index is None or not 0 <= args.index <= 47
    ):
        raise ValueError("An allowed control index (0–47) is required")
    if args.action == "control-type" and (
        args.value is None or not 0 < len(args.value) <= 80
    ):
        raise ValueError("Text must have 1–80 characters")
    params = urllib.parse.urlencode({
        "token": token, "action": args.action,
        **({"target": "marker"} if args.action == "tap" else {}),
        **({"index": args.index} if args.action.startswith("control-") else {}),
        **({"value": args.value} if args.action == "control-type" else {}),
    })
    url = "ignis-obsidian-lab://automation?" + params
    run_ssh(args.ssh_port, args.key_file, "uiopen " + shlex.quote(url))
    end = time.monotonic() + 12
    after = None
    while time.monotonic() < end:
        time.sleep(0.7)
        after = read_receipt()
        if after.get("index", 0) > before.get("index", 0):
            break
    if not after or after.get("index", 0) <= before.get("index", 0):
        raise RuntimeError("No UI response from clone after deep link")
    expected_target = (
        "marker" if args.action == "tap" else
        "control-" + str(args.index) if args.action.startswith("control-") else
        None
    )
    if (after.get("action") != args.action or not after.get("ok")
            or (expected_target is not None and
                after.get("target") != expected_target)
            or not after.get("overlayPresent")):
        raise RuntimeError("Unexpected UI response: "
                           + json.dumps(after, ensure_ascii=False))
    print(json.dumps({
        "status": "passed",
        "action": after["action"],
        "target": after.get("target"),
        "previousIndex": before["index"],
        "responseIndex": after["index"],
        "webViewPresent": after.get("webViewPresent"),
        "overlayPresent": after["overlayPresent"],
        "tokenPrinted": False,
        "visibleControls": after.get("controls", []) if args.action == "inspect" else [],
    }))


if __name__ == "__main__":
    main()
