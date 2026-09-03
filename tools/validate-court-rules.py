"""Validate every generated local court-rule XML and its source coverage."""

from __future__ import annotations

import difflib
import json
import re
import unicodedata
import xml.etree.ElementTree as ET
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "data" / "court-rules" / "catalog.json"
PREPARED = ROOT / "tmp" / "pdfs" / "prepared"
CIRCLED_PARAGRAPH_RE = re.compile(r"[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]")


def normalized(value: str) -> str:
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", value or ""))


def source_body(path: Path) -> str:
    lines = path.read_text(encoding="utf-8").splitlines()
    marker = lines.index("@@BODY@@")
    kept: list[str] = []
    dropping = False
    for raw in lines[marker + 1:]:
        line = raw.strip()
        if not line or line == "@@PAGE_BREAK@@":
            continue
        if dropping:
            if line.endswith(("）", ")")):
                dropping = False
            continue
        if re.match(r"^（(?:明|大|昭|平|令).*(?:最裁規|最高裁判所規則)", line):
            dropping = not line.endswith(("）", ")"))
            continue
        kept.append(line)
    return normalized("".join(kept))


def main() -> None:
    payload = json.loads(CATALOG.read_text(encoding="utf-8"))
    rules = payload["rules"]
    ids = [rule["id"] for rule in rules]
    slugs = [rule["slug"] for rule in rules]
    problems: list[str] = []
    scores: list[tuple[float, str, int, int]] = []

    if len(ids) != len(set(ids)):
        problems.append("duplicate catalog IDs")
    if len(slugs) != len(set(slugs)):
        problems.append("duplicate catalog slugs")
    for rule in rules:
        if not re.fullmatch(r"[A-Z0-9]{20}", rule["id"]):
            problems.append(f"invalid ID: {rule['title']} {rule['id']}")
        xml_path = ROOT / rule["dataPath"]
        if not xml_path.exists():
            problems.append(f"missing XML: {rule['title']}")
            continue
        try:
            root = ET.parse(xml_path).getroot()
        except ET.ParseError as exc:
            problems.append(f"invalid XML: {rule['title']}: {exc}")
            continue
        xml_title = root.findtext("./LawBody/LawTitle", default="")
        xml_num = root.findtext("./LawNum", default="")
        main = root.find("./LawBody/MainProvision")
        if xml_title != rule["title"]:
            problems.append(f"title mismatch: {rule['title']} / {xml_title}")
        if xml_num != rule["lawNum"]:
            problems.append(f"law number mismatch: {rule['title']}")
        if main is None or not normalized("".join(main.itertext())):
            problems.append(f"empty body: {rule['title']}")
            continue
        xml_text = normalized("".join(main.itertext()))
        if "@@" in xml_text or "NaN" in xml_text:
            problems.append(f"generator marker leaked: {rule['title']}")
        if CIRCLED_PARAGRAPH_RE.search(xml_text):
            problems.append(f"circled paragraph number leaked: {rule['title']}")
        prepared_path = PREPARED / f"{rule['slug']}.txt"
        if prepared_path.exists() and rule["slug"] not in {
            "criminal-procedure", "civil-procedure", "general-incorporated-association-noncontentious"
        }:
            source_text = source_body(prepared_path)
            ratio = 1.0 if source_text == xml_text else difflib.SequenceMatcher(
                None, source_text, xml_text, autojunk=True
            ).ratio()
            scores.append((ratio, rule["title"], len(source_text), len(xml_text)))

    print(f"catalog={len(rules)} xml={len(list((ROOT / 'data' / 'court-rules').glob('*.xml')))}")
    if scores:
        exact_count = sum(1 for score in scores if score[0] == 1.0)
        print(f"coverage min={min(score[0] for score in scores):.6f} avg={sum(score[0] for score in scores)/len(scores):.6f} exact={exact_count}/{len(scores)}")
        for ratio, title, source_len, xml_len in sorted(scores)[:15]:
            print(f"{ratio:.6f}\t{source_len}\t{xml_len}\t{title}")
        report_path = ROOT / "tmp" / "pdfs" / "validation-report.json"
        report_path.write_text(json.dumps([
            {"ratio": ratio, "title": title, "sourceCharacters": source_len, "xmlCharacters": xml_len}
            for ratio, title, source_len, xml_len in sorted(scores)
        ], ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if problems:
        print("PROBLEMS")
        print("\n".join(problems))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
