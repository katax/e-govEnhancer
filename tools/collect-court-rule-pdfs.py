"""Download the PDF links published on the four Supreme Court rule pages."""

from __future__ import annotations

import html
import json
import re
import urllib.parse
import urllib.request
from collections import OrderedDict
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TMP_ROOT = ROOT / "tmp" / "pdfs"
PAGE_DIR = TMP_ROOT / "pages"
DOWNLOAD_DIR = TMP_ROOT / "downloads"

CATEGORY_URLS = OrderedDict([
    ("civil", "https://www.courts.go.jp/toukei_siryou/kisokusyu/minzi_kisoku/index.html"),
    ("criminal", "https://www.courts.go.jp/toukei_siryou/kisokusyu/keizi_kisoku/index.html"),
    ("family", "https://www.courts.go.jp/toukei_siryou/kisokusyu/kazi_syonen_kisoku/index.html"),
    ("other", "https://www.courts.go.jp/toukei_siryou/kisokusyu/sonota_kisoku/index.html"),
])

ANCHOR_RE = re.compile(
    r'<a\b[^>]*href="([^"]+\.pdf[^"]*)"[^>]*>(.*?)</a>',
    re.IGNORECASE | re.DOTALL,
)


def fetch(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "e-Gov-Enhancer court-rule importer"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


def clean_title(anchor_html: str) -> str:
    value = re.sub(r"<[^>]+>", "", anchor_html)
    value = html.unescape(value)
    value = re.sub(r"\s*[（(]\s*PDF\s*[:：].*?[）)]\s*$", "", value, flags=re.IGNORECASE)
    return value.strip()


def main() -> None:
    PAGE_DIR.mkdir(parents=True, exist_ok=True)
    DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
    records: list[dict[str, str]] = []
    for category, category_url in CATEGORY_URLS.items():
        page_bytes = fetch(category_url)
        (PAGE_DIR / f"{category}.html").write_bytes(page_bytes)
        page = page_bytes.decode("utf-8")
        for match in ANCHOR_RE.finditer(page):
            url = urllib.parse.urljoin(category_url, html.unescape(match.group(1)))
            filename = urllib.parse.unquote(urllib.parse.urlparse(url).path.rsplit("/", 1)[-1])
            records.append({
                "category": category,
                "title": clean_title(match.group(2)),
                "url": url,
                "fileName": filename,
                "categoryUrl": category_url,
            })

    (TMP_ROOT / "source-links.json").write_text(
        json.dumps(records, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    unique = OrderedDict((record["url"], record) for record in records)
    for index, record in enumerate(unique.values(), start=1):
        target = DOWNLOAD_DIR / record["fileName"]
        if not target.exists():
            target.write_bytes(fetch(record["url"]))
        print(f"[{index:03}/{len(unique):03}] {record['title']}")
    print(f"Collected {len(records)} links; {len(unique)} unique PDFs")


if __name__ == "__main__":
    main()
