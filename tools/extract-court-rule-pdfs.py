"""Extract the Supreme Court rule PDFs listed in tmp/pdfs/source-links.json.

This is the first, deliberately lossless stage of the local-rule importer.  It
keeps page boundaries explicit so that the normalization stage can remove only
PDF layout artefacts (headers, footers, and visual line wrapping).
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pdfplumber


ROOT = Path(__file__).resolve().parents[1]
TMP_ROOT = ROOT / "tmp" / "pdfs"
DOWNLOAD_DIR = TMP_ROOT / "downloads"
TEXT_DIR = TMP_ROOT / "text"
SOURCE_LINKS = TMP_ROOT / "source-links.json"


def safe_stem(filename: str) -> str:
    stem = Path(filename).stem
    return re.sub(r"[^0-9A-Za-z._-]+", "-", stem).strip("-") or "court-rule"


def extract_pdf(pdf_path: Path) -> tuple[str, list[dict[str, object]]]:
    pages: list[str] = []
    diagnostics: list[dict[str, object]] = []
    with pdfplumber.open(pdf_path) as pdf:
        for page_number, page in enumerate(pdf.pages, start=1):
            text = page.extract_text(x_tolerance=1.5, y_tolerance=3, layout=False) or ""
            text = text.replace("\u00a0", " ").replace("\r\n", "\n").replace("\r", "\n")
            lines = [line.rstrip() for line in text.splitlines()]
            pages.append("\n".join(lines).strip())
            diagnostics.append({
                "page": page_number,
                "characters": len(text),
                "lines": len(lines),
                "empty": not bool(text.strip()),
            })
    joined = "\n\n@@PAGE_BREAK@@\n\n".join(pages).strip() + "\n"
    return joined, diagnostics


def main() -> None:
    TEXT_DIR.mkdir(parents=True, exist_ok=True)
    records = json.loads(SOURCE_LINKS.read_text(encoding="utf-8-sig"))
    unique: dict[str, dict[str, object]] = {}
    for record in records:
        unique.setdefault(record["url"], record)

    report: list[dict[str, object]] = []
    for index, record in enumerate(unique.values(), start=1):
        filename = str(record["fileName"])
        pdf_path = DOWNLOAD_DIR / filename
        if not pdf_path.exists():
            raise FileNotFoundError(pdf_path)
        stem = safe_stem(filename)
        output_path = TEXT_DIR / f"{stem}.txt"
        text, pages = extract_pdf(pdf_path)
        output_path.write_text(text, encoding="utf-8")
        report.append({
            **record,
            "pdfPath": pdf_path.relative_to(ROOT).as_posix(),
            "textPath": output_path.relative_to(ROOT).as_posix(),
            "pages": pages,
            "characters": len(text),
        })
        print(f"[{index:03}/{len(unique):03}] {record['title']} ({len(pages)} pages)")

    (TMP_ROOT / "extraction-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    empty_pages = sum(sum(1 for page in item["pages"] if page["empty"]) for item in report)
    print(f"Extracted {len(report)} PDFs; empty pages: {empty_pages}")


if __name__ == "__main__":
    main()
