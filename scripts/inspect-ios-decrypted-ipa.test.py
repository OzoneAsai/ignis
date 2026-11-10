"""Small self-contained fixtures for the read-only IPA acceptance gate."""

import importlib.util
import plistlib
import struct
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile


SCRIPT = Path(__file__).with_name("inspect-ios-decrypted-ipa.py")
spec = importlib.util.spec_from_file_location("ios_ipa_audit", SCRIPT)
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


def sample_macho(cryptid=0):
    header = struct.pack("<IiiIIIII", 0xFEEDFACF, 0x100000C, 0, 2,
                         1, 24, 0, 0)
    command = struct.pack("<IIIIII", 0x2C, 24, 4096, 4096, cryptid, 0)
    return header + command


class IpaAuditTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="ignis-ipa-audit-")
        self.path = Path(self.temp.name) / "lab.ipa"

    def tearDown(self):
        self.temp.cleanup()

    def make_ipa(self, cryptid=0, mixed=False, bundle_id="md.obsidian"):
        with ZipFile(self.path, "w") as archive:
            archive.writestr(
                "Payload/Obsidian.app/Info.plist",
                plistlib.dumps({
                    "CFBundleIdentifier": bundle_id,
                    "CFBundleExecutable": "Obsidian",
                    "CFBundleShortVersionString": "1.15.0",
                }),
            )
            archive.writestr(
                "Payload/Obsidian.app/Obsidian", sample_macho(cryptid)
            )
            if mixed:
                archive.writestr(
                    "Payload/Other.app/Info.plist",
                    plistlib.dumps({"CFBundleIdentifier": "other"}),
                )

    def test_single_decrypted_app(self):
        self.make_ipa()
        report = audit.inspect(self.path)
        self.assertEqual(report["bundleId"], "md.obsidian")
        self.assertEqual(report["encryption"][0]["cryptid"], 0)

    def test_rejects_encrypted_executable(self):
        self.make_ipa(cryptid=1)
        with self.assertRaisesRegex(ValueError, "not demonstrably decrypted"):
            audit.inspect(self.path)

    def test_rejects_mixed_app_bundles(self):
        self.make_ipa(mixed=True)
        with self.assertRaisesRegex(ValueError, "exactly one root application"):
            audit.inspect(self.path)

    def test_cloned_bundle_id_requires_explicit_expectation(self):
        self.make_ipa(bundle_id="dev.ignis.obsidian.lab")
        with self.assertRaisesRegex(ValueError, "expected Obsidian"):
            audit.inspect(self.path)
        report = audit.inspect(self.path, "dev.ignis.obsidian.lab")
        self.assertEqual(report["bundleId"], "dev.ignis.obsidian.lab")


if __name__ == "__main__":
    unittest.main()
