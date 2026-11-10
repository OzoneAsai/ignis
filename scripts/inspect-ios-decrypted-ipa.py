#!/usr/bin/env python3
"""Read-only inspection of an iOS app IPA before isolated TrollStore testing.

No app files are extracted, signed, modified, or installed. This deliberately
validates the main executable instead of trusting an IPA's filename.
"""

import hashlib
import json
import plistlib
import struct
import sys
import stat
from pathlib import Path, PurePosixPath
from zipfile import ZipFile

MAIN_64 = b"\xcf\xfa\xed\xfe"
ENCRYPTION_INFO = {0x21, 0x2C}
MAX_BINARY = 256 * 1024 * 1024


def encryption_commands(macho: bytes) -> list[dict]:
    if len(macho) < 32 or macho[:4] != MAIN_64:
        raise ValueError("Expected thin little-endian 64-bit Mach-O executable")
    ncmds, sizeofcmds = struct.unpack_from("<II", macho, 16)
    if ncmds > 4096 or sizeofcmds > 65536 or len(macho) < 32 + sizeofcmds:
        raise ValueError("Malformed or truncated Mach-O load commands")
    result = []
    position = 32
    end = position + sizeofcmds
    for _ in range(ncmds):
        if position + 8 > end:
            raise ValueError("Malformed Mach-O command header")
        command, size = struct.unpack_from("<II", macho, position)
        if size < 8 or position + size > end:
            raise ValueError("Malformed Mach-O command size")
        if command in ENCRYPTION_INFO:
            if size < 20:
                raise ValueError("Truncated encryption command")
            cryptoff, cryptsize, cryptid = struct.unpack_from(
                "<III", macho, position + 8
            )
            result.append({
                "cryptoff": cryptoff,
                "cryptsize": cryptsize,
                "cryptid": cryptid,
            })
        position += size
    if position != end:
        raise ValueError("Unexpected trailing Mach-O load-command data")
    return result


def inspect(ipa: Path, expected_bundle_id="md.obsidian") -> dict:
    if not ipa.is_file() or ipa.is_symlink():
        raise ValueError("IPA must be an existing regular file")
    digest = hashlib.sha256()
    with ipa.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    with ZipFile(ipa) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError("Duplicate IPA entries")
        if any(PurePosixPath(p).is_absolute() or ".." in PurePosixPath(p).parts
               for p in names):
            raise ValueError("Unsafe IPA archive path")
        if any(stat.S_ISLNK(item.external_attr >> 16)
               for item in archive.infolist()):
            raise ValueError("Symbolic links are not accepted in a test IPA")
        info_paths = [
            p for p in names
            if p.startswith("Payload/") and p.endswith(".app/Info.plist")
            and p.count("/") == 2
        ]
        if len(info_paths) != 1:
            raise ValueError("Expected exactly one root application")
        metadata = plistlib.loads(archive.read(info_paths[0]))
        identifier = metadata.get("CFBundleIdentifier")
        executable = metadata.get("CFBundleExecutable")
        if identifier != expected_bundle_id or executable != "Obsidian":
            raise ValueError("IPA does not contain the expected Obsidian app")
        main_path = info_paths[0][:-len("Info.plist")] + executable
        info = archive.getinfo(main_path)
        if info.file_size > MAX_BINARY:
            raise ValueError("Unexpectedly large main executable")
        with archive.open(info) as binary:
            header = binary.read(min(info.file_size, 65568))
        commands = encryption_commands(header)
        if not commands or any(command["cryptid"] != 0 for command in commands):
            raise ValueError("Main executable is not demonstrably decrypted")
        return {
            "bundleId": identifier,
            "version": metadata.get("CFBundleShortVersionString"),
            "build": metadata.get("CFBundleVersion"),
            "sha256": digest.hexdigest(),
            "ipaBytes": ipa.stat().st_size,
            "mainExecutableBytes": info.file_size,
            "encryption": commands,
            "entries": len(names),
        }


if __name__ == "__main__":
    if len(sys.argv) not in (2, 3):
        raise SystemExit("usage: inspect-ios-decrypted-ipa.py PATH_TO_IPA [EXPECTED_BUNDLE_ID]")
    try:
        print(json.dumps(inspect(Path(sys.argv[1]), sys.argv[2] if len(sys.argv) == 3
                              else "md.obsidian"), ensure_ascii=False, indent=2))
    except (OSError, ValueError, KeyError) as error:
        raise SystemExit("IPA verification failed: " + str(error))
