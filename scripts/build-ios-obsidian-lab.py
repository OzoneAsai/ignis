#!/usr/bin/env python3
"""Create a separately identified, ad-hoc-signed Obsidian WebView test app.

The user-installed md.obsidian app is never modified, uninstalled, or adopted.
Input IPA must pass the strict read-only audit. Temporary files stay under an
explicit empty staging directory and the output IPA must not already exist.
"""

import importlib.util
import json
import os
import plistlib
import secrets
import shutil
import stat
import subprocess
import sys
from hashlib import sha256
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


ROOT = Path(__file__).resolve().parent
AUDIT_SCRIPT = ROOT / "inspect-ios-decrypted-ipa.py"
AGENT_SCRIPT = ROOT / "ios-lab" / "ignis-ui-automation.js"
LAB_BUNDLE_ID = "dev.ignis.obsidian.lab"
LAB_URL_SCHEME = "ignis-obsidian-lab"

spec = importlib.util.spec_from_file_location("ios_ipa_audit", AUDIT_SCRIPT)
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


def signing_command(target: Path, entitlements: Path | None = None):
    args = [
        "/usr/bin/codesign",
        "--force", "--sign", "-", "--timestamp=none",
        "--generate-entitlement-der",
    ]
    if entitlements:
        args.extend(["--entitlements", str(entitlements)])
    args.append(str(target))
    subprocess.run(args, check=True, stdout=subprocess.PIPE,
                   stderr=subprocess.PIPE, timeout=45)


def build(input_ipa: Path, output_ipa: Path, staging: Path):
    audit.inspect(input_ipa)
    if output_ipa.exists() or staging.exists():
        raise FileExistsError("Output IPA or staging directory already exists")
    if output_ipa.parent.is_symlink() or staging.parent.is_symlink():
        raise ValueError("Refusing a symlinked output directory")
    staging.mkdir(mode=0o700, parents=False)
    try:
        with ZipFile(input_ipa) as source:
            for entry in source.infolist():
                filename = entry.filename
                if not filename.startswith("Payload/Obsidian.app/") and filename != "Payload/":
                    raise ValueError("Unexpected bundle in input IPA")
                if stat.S_ISLNK(entry.external_attr >> 16):
                    raise ValueError("Symlink in input IPA")
                target = staging / filename
                if entry.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with source.open(entry) as inp, target.open("xb") as out:
                    shutil.copyfileobj(inp, out, length=1024 * 1024)
                permissions = entry.external_attr >> 16 & 0o777
                if permissions:
                    target.chmod(permissions)
        app = staging / "Payload" / "Obsidian.app"
        metadata = app / "Info.plist"
        with metadata.open("rb") as inp:
            info = plistlib.load(inp)
        if info.get("CFBundleIdentifier") != "md.obsidian":
            raise ValueError("Original Obsidian bundle ID differs")
        info.update({
            "CFBundleIdentifier": LAB_BUNDLE_ID,
            "CFBundleName": "IGNISLab",
            "CFBundleDisplayName": "IGNIS Obsidian Lab",
            "CFBundleURLTypes": [{
                "CFBundleURLName": LAB_BUNDLE_ID,
                "CFBundleTypeRole": "Editor",
                "CFBundleURLSchemes": [LAB_URL_SCHEME],
            }],
            "UIBackgroundModes": [],
        })
        with metadata.open("wb") as out:
            plistlib.dump(info, out)

        # The test app intentionally has no original Share/Widget extension:
        # their team IDs, app groups, iCloud access and URL handlers belong
        # exclusively to the original installed Obsidian.
        for extra in ["PlugIns", "SC_Info", "_CodeSignature"]:
            shutil.rmtree(app / extra, ignore_errors=True)
        for provision in app.glob("embedded.mobileprovision"):
            provision.unlink()

        native_config = app / "capacitor.config.json"
        if native_config.exists():
            config = json.loads(native_config.read_text("utf8"))
            if config.get("appId") == "md.obsidian":
                config["appId"] = LAB_BUNDLE_ID
            native_config.write_text(json.dumps(config, ensure_ascii=False),
                                     encoding="utf8")

        document = app / "public" / "index.html"
        html = document.read_text("utf8")
        anchor = '<script type="text/javascript" defer src="app.js"></script>'
        if html.count(anchor) != 1:
            raise ValueError("Unexpected WebView script entrypoint")
        document.write_text(
            html.replace(anchor, anchor + '\n'
                '<script type="text/javascript" defer '
                'src="ignis-ui-automation.js"></script>'),
            encoding="utf8",
        )
        secret = secrets.token_urlsafe(32)
        agent = AGENT_SCRIPT.read_text("utf8")
        if agent.count("__IGNIS_LAB_TOKEN__") != 1:
            raise ValueError("Automation bridge key placeholder changed")
        agent = agent.replace("__IGNIS_LAB_TOKEN__", secret)
        (app / "public" / "ignis-ui-automation.js").write_text(
            agent, encoding="utf8"
        )

        # Only the clone receives a debugger entitlement. It never gains
        # original App Store iCloud containers, app-groups or keychain groups.
        entitlements = staging / "lab-entitlements.plist"
        with entitlements.open("wb") as out:
            plistlib.dump({"get-task-allow": True}, out)
        for framework in sorted((app / "Frameworks").glob("*.framework")):
            signing_command(framework)
        signing_command(app, entitlements)
        subprocess.run(["/usr/bin/codesign", "--verify", "--deep", "--strict",
                        "--verbose=2", str(app)], check=True,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=45)

        with ZipFile(output_ipa, "x", ZIP_DEFLATED, compresslevel=6) as target:
            for file in sorted((staging / "Payload").rglob("*")):
                if file.is_file():
                    target.write(file, file.relative_to(staging).as_posix())
        report = audit.inspect(output_ipa, LAB_BUNDLE_ID)
        receipt = output_ipa.with_suffix(".test.json")
        if receipt.exists():
            raise FileExistsError("Test credential receipt exists")
        receipt.write_text(json.dumps({
            "expectedBundleID": LAB_BUNDLE_ID,
            "urlScheme": LAB_URL_SCHEME,
            "token": secret,
            "ipaSHA256": report["sha256"],
            "automationAgentSHA256": sha256(agent.encode()).hexdigest(),
        }, indent=2) + "\n", encoding="utf8")
        receipt.chmod(0o600)
        return report
    except Exception:
        if output_ipa.exists():
            output_ipa.unlink()
        raise
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def main():
    if len(sys.argv) != 4:
        raise SystemExit(
            "usage: build-ios-obsidian-lab.py ORIGINAL_ISOLATED_IPA "
            "NEW_SIGNED_IPA NEW_EMPTY_STAGING_PATH"
        )
    original, output, staging = map(Path, sys.argv[1:])
    report = build(original, output, staging)
    print("SIGNED_LAB_BUNDLE_ID=" + LAB_BUNDLE_ID)
    print("SIGNED_LAB_IPA_BYTES=" + str(report["ipaBytes"]))
    print("SIGNED_LAB_IPA_SHA256=" + report["sha256"])
    print("TEST_AUTOMATION_KEY=PRIVATE_RECEIPT_ONLY")


if __name__ == "__main__":
    main()
