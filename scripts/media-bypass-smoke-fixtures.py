"""Small, self-contained PDF and OOXML fixtures for the isolated device smoke.

The output directory is selected and exclusively created by the caller. No
existing Vault, downloads directory, or real user document is consulted.
"""

from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import sys


def pdf_document(text: str) -> bytes:
    body = f"BT /F1 20 Tf 72 740 Td ({text}) Tj ET\n".encode("ascii")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        f"<< /Length {len(body)} >>\nstream\n".encode() + body + b"endstream",
    ]
    result = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for number, data in enumerate(objects, 1):
        offsets.append(len(result))
        result.extend(f"{number} 0 obj\n".encode() + data + b"\nendobj\n")
    xref = len(result)
    result.extend(f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode())
    for offset in offsets[1:]:
        result.extend(f"{offset:010d} 00000 n \n".encode())
    result.extend(
        f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    )
    return bytes(result)


CONTENT_HEADER = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
RELS_HEADER = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'


def make_package(destination, main_part, main_type, main_xml, extra=None):
    extra = extra or {}
    content = (
        CONTENT_HEADER
        + f'<Override PartName="/{main_part}" ContentType="{main_type}"/>'
        + "".join(
            f'<Override PartName="/{part}" ContentType="{kind}"/>'
            for part, (_, kind) in extra.items()
        )
        + "</Types>"
    )
    rels = (
        RELS_HEADER
        + f'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="{main_part}"/>'
        + "</Relationships>"
    )
    with ZipFile(destination, "w", ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", content)
        archive.writestr("_rels/.rels", rels)
        archive.writestr(main_part, main_xml)
        for part, (value, _) in extra.items():
            archive.writestr(part, value)


def main(dest: Path):
    if not dest.is_dir() or dest.is_symlink() or any(dest.iterdir()):
        raise ValueError("Only a new, empty fixture directory is accepted")
    (dest / "Acceptance.pdf").write_bytes(pdf_document("IGNIS PDF BYPASS ACCEPTANCE"))

    make_package(
        dest / "Acceptance.docx",
        "word/document.xml",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>IGNIS DOCX acceptance</w:t></w:r></w:p><w:sectPr/></w:body></w:document>',
    )
    workbook_rels = RELS_HEADER + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
    make_package(
        dest / "Acceptance.xlsx",
        "xl/workbook.xml",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Acceptance" sheetId="1" r:id="rId1"/></sheets></workbook>',
        {
            "xl/_rels/workbook.xml.rels": (
                workbook_rels,
                "application/vnd.openxmlformats-package.relationships+xml",
            ),
            "xl/worksheets/sheet1.xml": (
                '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>IGNIS XLSX acceptance</t></is></c></row></sheetData></worksheet>',
                "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml",
            ),
        },
    )
    presentation_rels = RELS_HEADER + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>'
    make_package(
        dest / "Acceptance.pptx",
        "ppt/presentation.xml",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
        '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000" type="screen4x3"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>',
        {
            "ppt/_rels/presentation.xml.rels": (
                presentation_rels,
                "application/vnd.openxmlformats-package.relationships+xml",
            ),
            "ppt/slides/slide1.xml": (
                '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>',
                "application/vnd.openxmlformats-officedocument.presentationml.slide+xml",
            ),
        },
    )
    print("FIXTURE_TYPES=pdf,docx,xlsx,pptx")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: python3 media-bypass-smoke-fixtures.py EMPTY_DIRECTORY")
    main(Path(sys.argv[1]))
