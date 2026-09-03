"""Normalize circled paragraph numbers in generated court-rule XML files."""

from __future__ import annotations

import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data" / "court-rules"
CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳"
NUMBER = {character: index + 1 for index, character in enumerate(CIRCLED)}
MARKER_RE = re.compile(f"([{CIRCLED}])[\\t 　]*")


def paragraph(number: int, sentence: str) -> ET.Element:
    result = ET.Element("Paragraph", {"Num": str(number)})
    ET.SubElement(result, "ParagraphNum").text = None if number == 1 else str(number)
    paragraph_sentence = ET.SubElement(result, "ParagraphSentence")
    ET.SubElement(paragraph_sentence, "Sentence").text = sentence.lstrip()
    return result


def normalize_article(article: ET.Element) -> int:
    changed = 0
    for source_paragraph in list(article.findall("Paragraph")):
        paragraph_number = int(source_paragraph.get("Num", "1"))
        for sentence in source_paragraph.iter("Sentence"):
            if len(sentence):
                continue
            value = sentence.text or ""
            matches = list(MARKER_RE.finditer(value))
            if not matches:
                continue
            numbers = [NUMBER[match.group(1)] for match in matches]
            sequential = all(number == numbers[index - 1] + 1 for index, number in enumerate(numbers[1:], 1))
            begins_with_one = numbers[0] == 1 and not value[:matches[0].start()].strip()
            continues_paragraphs = numbers[0] == paragraph_number + 1
            if not sequential or not (begins_with_one or continues_paragraphs):
                continue

            segments = [
                value[match.end():(matches[index + 1].start() if index + 1 < len(matches) else len(value))]
                for index, match in enumerate(matches)
            ]
            if begins_with_one:
                sentence.text = segments.pop(0).lstrip()
                numbers.pop(0)
            else:
                sentence.text = value[:matches[0].start()].rstrip()

            insertion_index = list(article).index(source_paragraph) + 1
            for number, text in zip(numbers, segments):
                article.insert(insertion_index, paragraph(number, text))
                insertion_index += 1
            changed += 1
            break
    return changed


def normalize_file(path: Path) -> int:
    tree = ET.parse(path)
    changed = sum(normalize_article(article) for article in tree.iter("Article"))
    if changed:
        ET.indent(tree, space="  ")
        tree.write(path, encoding="utf-8", xml_declaration=True, short_empty_elements=False)
    return changed


def main() -> None:
    paths = [Path(argument) for argument in sys.argv[1:]] or sorted(DATA_DIR.glob("*.xml"))
    total = 0
    for path in paths:
        changed = normalize_file(path)
        if changed:
            print(f"{path.relative_to(ROOT)}: {changed} article(s)")
            total += changed
    print(f"Normalized {total} article(s) across {len(paths)} XML file(s)")


if __name__ == "__main__":
    main()
