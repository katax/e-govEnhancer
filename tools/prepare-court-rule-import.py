"""Prepare extracted Supreme Court PDFs for the e-Gov-like XML builder.

The script removes document-front-matter and layout-only page markers, locates
the real body independently of whether a PDF has a table of contents, and emits
a stable catalog used by both the popup and Lite viewer.
"""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from collections import OrderedDict
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TMP_ROOT = ROOT / "tmp" / "pdfs"
PREPARED_DIR = TMP_ROOT / "prepared"
SOURCE_LINKS = TMP_ROOT / "source-links.json"
EXTRACTION_REPORT = TMP_ROOT / "extraction-report.json"
BUILD_MANIFEST = TMP_ROOT / "build-manifest.json"
CATALOG_JSON = ROOT / "data" / "court-rules" / "catalog.json"
CATALOG_JS = ROOT / "shared" / "court-rule-catalog.js"

PAGE_BREAK = "@@PAGE_BREAK@@"
BODY_MARKER = "@@BODY@@"
NUMBER_CHARS = "〇○零一二三四五六七八九十百千万0-9０-９"
ARTICLE_RE = re.compile(rf"^第[{NUMBER_CHARS}]+条(?:の[{NUMBER_CHARS}]+)?")
HEADING_RE = re.compile(rf"^第[{NUMBER_CHARS}]+[編章節款目]")
CAPTION_RE = re.compile(r"^[（(].+[）)]$")
APPENDIX_RE = re.compile(r"^(?:別表|別紙|様式|付録)(?:[ 　]|第|$)")
LAW_NUM_RE = re.compile(
    rf"(?:明治|大正|昭和|平成|令和|明|大|昭|平|令)[{NUMBER_CHARS}]+年"
    rf"[{NUMBER_CHARS}]+月[{NUMBER_CHARS}]+日.*?(?:最高裁判所規則|最高裁判所告示).*?第[{NUMBER_CHARS}]+号"
)
LAW_CITATION_RE = re.compile(
    rf"([^、。；;：（）()「」『』\n]{{2,100}}?法)[（(]"
    rf"(明治|大正|昭和|平成|令和)([{NUMBER_CHARS}]+)年法律第([{NUMBER_CHARS}]+)号"
)

CATEGORY_LABELS = {
    "civil": "民事",
    "criminal": "刑事",
    "family": "家事・少年",
    "other": "その他",
}

EXISTING = {
    "刑事訴訟規則": {
        "id": "COURTRULECRIMPROC001",
        "slug": "criminal-procedure",
        "aliases": ["刑事訴訟規則", "刑訴規則", "刑訴"],
        "baseLawId": "323AC0000000131",
        "baseLawTitle": "刑事訴訟法",
        "sourceLabel": "添付PDF・令和8年5月21日反映版",
        "lawNum": "昭和二十三年十二月一日最高裁判所規則第三十二号",
        "skipBuild": True,
    },
    "民事訴訟規則": {
        "id": "COURTRULECIVILPROC01",
        "slug": "civil-procedure",
        "aliases": ["民事訴訟規則", "民訴規則", "民訴"],
        "baseLawId": "408AC0000000109",
        "baseLawTitle": "民事訴訟法",
        "sourceLabel": "添付PDF・令和8年5月21日反映版",
        "lawNum": "平成八年十二月十七日最高裁判所規則第五号",
        "skipBuild": True,
    },
    "一般社団法人等非訟事件手続規則": {
        "id": "COURTRULEGENASSOC001",
        "slug": "general-incorporated-association-noncontentious",
        "aliases": ["一般社団法人等非訟事件手続規則", "一般社団法人等非訟事件手続", "一般社団法人等非訟"],
        "baseLawId": "418AC0000000048",
        "baseLawTitle": "一般社団法人及び一般財団法人に関する法律",
        "sourceLabel": "裁判所PDF・令和8年5月21日版",
        "lawNum": "平成二十年十月一日最高裁判所規則第九号",
        "skipBuild": True,
    },
}

KANJI_DIGITS = {"零": 0, "〇": 0, "○": 0, "一": 1, "二": 2, "三": 3, "四": 4,
                "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
ERA_CODES = {"明治": "1", "大正": "2", "昭和": "3", "平成": "4", "令和": "5"}
LAW_CITATION_OVERRIDES = {
    "昭和二十二年法律第百五十三号": {"id": "322AC0000000153", "title": "家事審判法施行法"},
    "昭和二十一年法律第十三号": {"id": "321AC0000000013", "title": "罹災都市借地借家臨時処理法"},
    "明治二十三年法律第二十九号": {"id": "123AC0000000029", "title": "民事訴訟法（旧法）"},
    "明治三十一年法律第十五号": {"id": "131AC0000000015", "title": "競売法"},
    "昭和二十二年法律第百五十二号": {"id": "322AC0000000152", "title": "家事審判法"},
    "大正十一年法律第七十五号": {"id": "211AC0000000075", "title": "刑事訴訟法（旧法）"},
    "昭和二十六年法律第二百二十二号": {"id": "326AC1000000222", "title": "民事調停法"},
}


def kanji_number(value: str) -> int:
    source = unicodedata.normalize("NFKC", value).replace("○", "〇")
    if source.isdigit():
        return int(source)
    if not any(unit in source for unit in "十百千万") and all(char in KANJI_DIGITS for char in source):
        return int("".join(str(KANJI_DIGITS[char]) for char in source))
    total = section = digit = 0
    for char in source:
        if char in KANJI_DIGITS:
            digit = KANJI_DIGITS[char]
        elif char in "十百千":
            unit = {"十": 10, "百": 100, "千": 1000}[char]
            section += (digit or 1) * unit
            digit = 0
        elif char == "万":
            total += (section + digit or 1) * 10000
            section = digit = 0
        else:
            raise ValueError(value)
    return total + section + digit


def compact(value: str) -> str:
    return re.sub(r"[\s　]", "", value or "")


def remove_pdf_japanese_spacing(value: str) -> str:
    japanese = r"\u3005\u3040-\u30ff\u3400-\u9fff〇○零一二三四五六七八九十百千万０-９"
    source = value or ""
    marker = re.match(r"^([0-9０-９]+|[一二三四五六七八九十百]+|[イロハニホヘトチリヌルヲワカヨタレソツネナラムウヰノオクヤマケフコエテアサキユメミシヱヒモセス])([\t 　]+)(?![条項号編章節款目])(.+)$", source)
    body = marker.group(3) if marker else source
    result = re.sub(rf"(?<=[{japanese}）)」』】〕、。，．])[\t 　]+(?=[{japanese}（(「『【〔、。，．）)」』】〕])", "", body)
    result = re.sub(r"[\t 　]+(?=[、。，．）)」』】〕])", "", result)
    result = re.sub(r"(?<=[（(「『【〔、。，．])[\t 　]+", "", result)
    return f"{marker.group(1)} {result}" if marker else result


def title_key(value: str) -> str:
    return compact(re.sub(r"[（(]原文は縦書き[）)]", "", value or ""))


def clean_lines(text: str) -> list[str]:
    lines: list[str] = []
    for raw in text.replace("\f", "\n").splitlines():
        line = remove_pdf_japanese_spacing(raw.strip())
        if not line:
            continue
        if line == PAGE_BREAK:
            lines.append(line)
            continue
        if re.fullmatch(r"[-―－—]?\s*[0-9０-９]+\s*[-―－—]?", line):
            continue
        lines.append(line)
    return lines


def find_law_number(lines: list[str]) -> str:
    for index, line in enumerate(lines[:30]):
        if line == PAGE_BREAK or line.startswith("改正"):
            continue
        candidate = compact(line)
        if LAW_NUM_RE.search(candidate):
            return candidate
        if "最高裁判所" in candidate and index > 0 and ("規則" in candidate or "告示" in candidate or "通達" in candidate):
            return candidate
    return "裁判所公式PDF掲載文書"


def structural(line: str) -> bool:
    return bool(ARTICLE_RE.match(line) or HEADING_RE.match(line) or CAPTION_RE.match(line)
                or APPENDIX_RE.match(line) or re.match(r"^附[ 　]*則(?:[ 　]|$)", line))


def locate_sections(lines: list[str], title: str) -> tuple[list[str], list[str], dict[str, object]]:
    usable = [line for line in lines if line != PAGE_BREAK]
    key = title_key(title)
    title_positions = [i for i, line in enumerate(usable[:200]) if title_key(line) == key]
    toc_index = next((i for i, line in enumerate(usable[:300]) if compact(line) == "目次"), -1)
    first_article = next((i for i, line in enumerate(usable) if ARTICLE_RE.match(line)), -1)
    if first_article < 0:
        start_after = title_positions[-1] + 1 if title_positions else 1
        body_start = start_after
        return [], usable[body_start:], {
            "bodyStrategy": "unnumbered",
            "bodyStart": body_start,
            "firstArticle": -1,
            "toc": False,
        }

    if toc_index >= 0 and toc_index < first_article:
        toc_first = next((i for i in range(toc_index + 1, first_article) if HEADING_RE.match(usable[i])), -1)
        body_start = -1
        if toc_first >= 0:
            signature = compact(re.sub(r"[（(].*?[）)]$", "", usable[toc_first]))
            body_start = next(
                (i for i in range(toc_first + 1, first_article + 1)
                 if compact(re.sub(r"[（(].*?[）)]$", "", usable[i])) == signature),
                -1,
            )
        if body_start < 0:
            body_start = first_article
            if first_article > 0 and CAPTION_RE.match(usable[first_article - 1]):
                body_start -= 1
        toc_lines = usable[toc_index + 1:body_start]
        return toc_lines, usable[body_start:], {
            "bodyStrategy": "toc-repeat" if body_start < first_article else "toc-article",
            "bodyStart": body_start,
            "firstArticle": first_article,
            "toc": True,
        }

    start_after = title_positions[-1] + 1 if title_positions else 0
    body_start = next((i for i in range(start_after, first_article + 1) if structural(usable[i])), first_article)
    return [], usable[body_start:], {
        "bodyStrategy": "after-title",
        "bodyStart": body_start,
        "firstArticle": first_article,
        "toc": False,
    }


def stable_rule_id(title: str) -> str:
    return "COURTRULE" + hashlib.sha1(title.encode("utf-8")).hexdigest()[:11].upper()


def stable_slug(title: str) -> str:
    return "court-rule-" + hashlib.sha1(title.encode("utf-8")).hexdigest()[:12]


def aliases_for(title: str) -> list[str]:
    aliases = [title]
    for suffix in ("に関する規則", "手続規則", "規則"):
        if title.endswith(suffix) and len(title) > len(suffix) + 1:
            aliases.append(title.removesuffix(suffix))
            break
    return list(OrderedDict.fromkeys(aliases))


def cited_laws(text: str) -> list[tuple[str, str, str, bool]]:
    found: OrderedDict[str, tuple[str, str, bool]] = OrderedDict()
    for match in LAW_CITATION_RE.finditer(text):
        name = match.group(1).strip()
        name = re.sub(r"^.*?[ 　]", "", name)
        if len(name) < 2 or name.startswith(("同法", "この法", "法律")):
            continue
        try:
            year = kanji_number(match.group(3))
            number = kanji_number(match.group(4))
        except ValueError:
            continue
        law_id = f"{ERA_CODES[match.group(2)]}{year:02d}AC{number:010d}"
        law_num = f"{match.group(2)}{match.group(3)}年法律第{match.group(4)}号"
        following = compact(text[match.end():match.end() + 100])
        is_base = bool(re.search(r"以下(?:単に)?[「『]?法[」』]?という", following))
        found.setdefault(law_num, (name, law_id, is_base))
    result = [(name, law_id, law_num, is_base) for law_num, (name, law_id, is_base) in found.items()]
    return sorted(result, key=lambda item: not item[3])


def main() -> None:
    PREPARED_DIR.mkdir(parents=True, exist_ok=True)
    CATALOG_JSON.parent.mkdir(parents=True, exist_ok=True)
    records = json.loads(SOURCE_LINKS.read_text(encoding="utf-8-sig"))
    reports = json.loads(EXTRACTION_REPORT.read_text(encoding="utf-8"))
    reports_by_url = {item["url"]: item for item in reports}

    merged: OrderedDict[str, dict[str, object]] = OrderedDict()
    for record in records:
        item = merged.setdefault(record["url"], {**record, "categories": []})
        category = CATEGORY_LABELS[record["category"]]
        if category not in item["categories"]:
            item["categories"].append(category)

    catalog: list[dict[str, object]] = []
    manifest: list[dict[str, str]] = []
    diagnostics: list[dict[str, object]] = []
    all_reference_laws: OrderedDict[str, str] = OrderedDict()
    all_citations: OrderedDict[str, dict[str, str]] = OrderedDict()
    resolution_path = TMP_ROOT / "resolved-law-citations.json"
    resolved_citations = json.loads(resolution_path.read_text(encoding="utf-8-sig")) if resolution_path.exists() else {}

    for record in merged.values():
        title = str(record["title"])
        report = reports_by_url[record["url"]]
        extracted = (ROOT / report["textPath"]).read_text(encoding="utf-8")
        lines = clean_lines(extracted)
        law_num = find_law_number(lines)
        toc_lines, body_lines, diagnostic = locate_sections(lines, title)
        existing = EXISTING.get(title, {})
        law_num = str(existing.get("lawNum") or law_num)
        slug = str(existing.get("slug") or stable_slug(title))
        rule_id = str(existing.get("id") or stable_rule_id(title))
        references = cited_laws("\n".join(body_lines))
        resolved_references: list[tuple[str, str, bool]] = []
        for guessed_title, provisional_id, cited_law_num, is_base in references:
            resolution = LAW_CITATION_OVERRIDES.get(cited_law_num) or resolved_citations.get(cited_law_num, {})
            law_title = resolution.get("title") or guessed_title
            law_id = resolution.get("id") or provisional_id
            resolved_references.append((law_title, law_id, is_base))
            all_reference_laws.setdefault(law_title, law_id)
            if guessed_title != law_title:
                all_reference_laws.setdefault(guessed_title, law_id)
            all_citations.setdefault(cited_law_num, {
                "lawNum": cited_law_num,
                "guessedTitle": guessed_title,
                "provisionalId": provisional_id,
            })
        base_reference = next((item for item in resolved_references if item[2]), ("", "", False))
        base_title, base_id, _ = base_reference
        base_title = str(existing.get("baseLawTitle") or base_title)
        base_id = str(existing.get("baseLawId") or base_id)

        prepared_path = PREPARED_DIR / f"{slug}.txt"
        prepared = [title, law_num, *toc_lines, BODY_MARKER, *body_lines]
        prepared_path.write_text("\n".join(prepared).rstrip() + "\n", encoding="utf-8")
        if not existing.get("skipBuild"):
            manifest.append({"slug": slug, "input": str(prepared_path)})

        catalog.append({
            "id": rule_id,
            "slug": slug,
            "title": title,
            "lawNum": law_num,
            "lawType": "Rule",
            "aliases": existing.get("aliases") or aliases_for(title),
            "baseLawId": base_id,
            "baseLawTitle": base_title,
            "sourceLabel": existing.get("sourceLabel") or "裁判所公式PDF・2026年9月3日取得",
            "dataPath": f"data/court-rules/{slug}.xml",
            "officialUrl": record["categoryUrl"],
            "pdfUrl": record["url"],
            "categories": record["categories"],
        })
        diagnostics.append({
            "title": title,
            "slug": slug,
            "lawNum": law_num,
            "tocLines": len(toc_lines),
            "bodyLines": len(body_lines),
            "references": len(references),
            **diagnostic,
        })

    catalog.sort(key=lambda item: (str(item["categories"][0]), str(item["title"])))
    reference_laws = sorted(all_reference_laws.items(), key=lambda item: (-len(item[0]), item[0]))
    payload = {"rules": catalog, "referenceLaws": reference_laws}
    CATALOG_JSON.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    CATALOG_JS.write_text(
        "globalThis.EgovCourtRuleCatalog = " + json.dumps(payload, ensure_ascii=False, indent=2) + ";\n",
        encoding="utf-8",
    )
    BUILD_MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (TMP_ROOT / "citation-candidates.json").write_text(
        json.dumps(list(all_citations.values()), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (TMP_ROOT / "preparation-report.json").write_text(
        json.dumps(diagnostics, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"Prepared {len(catalog)} documents; build={len(manifest)}; cited laws={len(reference_laws)}")
    for item in diagnostics:
        if item["firstArticle"] < 0 or item["lawNum"] == "裁判所公式PDF掲載文書":
            print(f"CHECK {item['title']}: {item['bodyStrategy']}, {item['lawNum']}")


if __name__ == "__main__":
    main()
