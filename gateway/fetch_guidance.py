"""Build the guidance index the maintenance agent searches: passages from published EPA
documents and from the distribution-system issue papers AWWA prepared for EPA.

Run (needs internet once, and pypdf: pip install pypdf):
    python fetch_guidance.py
Writes guidance_index.json next to this file. It holds the documents' text, so it is
git-ignored and built on each machine; without it the gateway falls back to the team's own
short notes in guidance.json. Re-run to refresh.

What is in it: the documents listed in DOCUMENTS, all published on epa.gov: EPA's own
guidance, and the 2002 distribution-system issue papers that AWWA and American Water
prepared for EPA. What is not: AWWA's own standards and manuals (C651, the M-series),
which are sold, not published, and CDC's advisory toolbox, whose site refuses downloads.
"""
import html
import io
import json
import re
import sys
import unicodedata
import urllib.request
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path

OUT = Path(__file__).with_name("guidance_index.json")
EPA = "https://www.epa.gov/sites/default/files"
PASSAGE = 900          # characters, about a paragraph
AGENT = "Mozilla/5.0 (compatible; guidance-index-builder)"

# id, title, who published it, who prepared it, year, document number, URL
DOCUMENTS = [
    ("owqm", "Online Water Quality Monitoring in Distribution Systems", "US EPA", "US EPA, Office of Water", 2018, "EPA 817-B-18-001",
     f"{EPA}/2018-05/documents/owqm-ds_guidance_042018.pdf"),
    ("timeseries", "Exploratory Analysis of Time-Series Data to Prepare for Real-Time Online Water Quality Monitoring", "US EPA",
     "US EPA, Office of Water", 2016, "EPA 817-B-16-004", f"{EPA}/2016-11/documents/exploratory_analysis_of_time-series_data_for_owqm.pdf"),
    ("respond", "Guidance for Responding to Drinking Water Contamination Incidents", "US EPA", "US EPA, Office of Water", 2018,
     "EPA 817-B-18-005", f"{EPA}/2018-12/documents/responding_to_dw_contamination_incidents.pdf"),
    ("primer", "Prepared for Contamination in Your Distribution System? (planning primer)", "US EPA", "US EPA, Office of Water", 2018,
     "EPA 817-B-18-006", f"{EPA}/2018-12/documents/planning_for_contamination_primer_2.pdf"),
    ("riskcomm", "Developing Risk Communication Plans for Drinking Water Contamination Incidents", "US EPA", "US EPA, Office of Water",
     2013, "EPA 817-F-13-003", f"{EPA}/2015-07/documents/developing_risk_communication_plans_for_drinking_water_contamination_incidents.pdf"),
    ("flushing", "Distribution System Water Quality: Protecting Water Quality Through Distribution System Flushing", "US EPA",
     "US EPA, Office of Water", 2022, "EPA 815-F-22-003", "https://www.epa.gov/system/files/documents/2022-04/ds-toolbox-fact-sheets_flushing_final-508.pdf"),
    ("secondary", "Secondary Drinking Water Standards: Guidance for Nuisance Chemicals", "US EPA", "US EPA", None, "web page",
     "https://www.epa.gov/sdwa/secondary-drinking-water-standards-guidance-nuisance-chemicals"),
    # Distribution system issue papers, published by EPA in 2002. Who prepared each is read from the paper itself.
    ("mains", "New or Repaired Water Mains (distribution system issue paper)", "US EPA", None, 2002, "issue paper",
     f"{EPA}/2015-09/documents/neworrepairedwatermains.pdf"),
    ("waterage", "Effects of Water Age on Distribution System Water Quality (distribution system issue paper)", "US EPA", None, 2002,
     "issue paper", f"{EPA}/2015-09/documents/2007_05_18_disinfection_tcr_whitepaper_tcr_waterdistribution.pdf"),
    ("permeation", "Permeation and Leaching (distribution system issue paper)", "US EPA", None, 2002, "issue paper",
     f"{EPA}/2015-09/documents/permeationandleaching.pdf"),
    ("storage", "Finished Water Storage Facilities (distribution system issue paper)", "US EPA", None, 2002, "issue paper",
     f"{EPA}/2015-09/documents/2007_05_18_disinfection_tcr_whitepaper_tcr_storage.pdf"),
    ("nitrification", "Nitrification (distribution system issue paper)", "US EPA", None, 2002, "issue paper",
     f"{EPA}/2015-09/documents/nitrification_1.pdf"),
    ("infrastructure", "Deteriorating Buried Infrastructure: Management Challenges and Strategies (distribution system issue paper)",
     "US EPA", None, 2002, "issue paper", f"{EPA}/2015-09/documents/2007_09_04_disinfection_tcr_whitepaper_tcr_infrastructure.pdf"),
    ("intrusion", "The Potential for Health Risks from Intrusion of Contaminants into the Distribution System from Pressure Transients "
     "(distribution system issue paper)", "US EPA", None, 2002, "issue paper",
     f"{EPA}/2015-09/documents/thepotentialforhealthrisksfromintrusionofcontaminants_1.pdf"),
]


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": AGENT})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return resp.read()


def tidy(text):
    text = unicodedata.normalize("NFKC", text or "")          # ligatures and odd spaces become plain letters
    text = re.sub(r"(\w)-\s*\n\s*(\w)", r"\1\2", text)        # words broken across lines
    return re.sub(r"\s+", " ", text).strip()


class Main(HTMLParser):
    """The readable text of a web page's <main> (or <article>), without scripts, styles or menus."""
    def __init__(self):
        super().__init__()
        self.depth, self.skip, self.out = 0, 0, []

    def handle_starttag(self, tag, attrs):
        if tag in ("main", "article"):
            self.depth += 1
        if tag in ("script", "style", "nav", "footer", "header", "form"):
            self.skip += 1
        if tag in ("p", "li", "h1", "h2", "h3", "h4", "tr", "br", "div"):
            self.out.append("\n")

    def handle_endtag(self, tag):
        if tag in ("main", "article"):
            self.depth -= 1
        if tag in ("script", "style", "nav", "footer", "header", "form"):
            self.skip = max(0, self.skip - 1)

    def handle_data(self, data):
        if self.depth and not self.skip:
            self.out.append(data)


def pages_of(raw, url):
    """-> [(page number or None, text)], and who the document says prepared it (or None)."""
    if raw[:5] == b"%PDF-":
        from pypdf import PdfReader
        reader = PdfReader(io.BytesIO(raw))
        pages = [(i + 1, tidy(p.extract_text())) for i, p in enumerate(reader.pages)]
        m = re.search(r"Prepared by:\s*(.{3,200}?)\s*Background and Disclaimer", " ".join(t for _, t in pages[:3]))
        return pages, tidy(m.group(1)) if m else None
    parser = Main()
    parser.feed(raw.decode("utf-8", errors="replace"))
    return [(None, tidy(html.unescape("".join(parser.out))))], None


def passages(text):
    """Whole sentences, gathered into passages of about PASSAGE characters."""
    out, cur = [], ""
    for sentence in re.split(r"(?<=[.!?])\s+(?=[A-Z0-9(\"])", text):
        if cur and len(cur) + len(sentence) > PASSAGE:
            out.append(cur)
            cur = ""
        cur = f"{cur} {sentence}".strip()
    if cur:
        out.append(cur)
    keep = []
    for p in out:
        letters = sum(c.isalpha() or c == " " for c in p) / max(1, len(p))
        if len(p) >= 160 and letters >= 0.78 and "....." not in p and ". . . ." not in p:    # not a contents page, table or reference list
            keep.append(p)
    return keep


def main():
    documents, rows = [], []
    for key, title, publisher, prepared_by, year, number, url in DOCUMENTS:
        try:
            pages, says = pages_of(fetch(url), url)
        except Exception as e:
            print(f"  skipped {key}: {type(e).__name__} {e}", file=sys.stderr)
            continue
        if prepared_by is None:                    # an issue paper: it names its own authors on its second page
            if not says:
                print(f"  skipped {key}: it does not say who prepared it", file=sys.stderr)
                continue
            prepared_by = re.sub(r"\s+With assistance from\s+", ", with ", says, flags=re.I) + ", for US EPA"
        n, head = 0, re.sub(r"\s*\(.*?\)$", "", title).lower()
        for page, text in pages:
            if text.lower().startswith(head):      # the running header at the top of each page
                text = text[len(head):].lstrip()
            for p in passages(text):
                rows.append([len(documents), page, p])
                n += 1
        documents.append({"id": key, "title": title, "publisher": publisher, "prepared_by": prepared_by, "year": year,
                          "number": number, "url": url, "pages": len(pages) if pages[0][0] else None, "passages": n})
        print(f"{key}: {len(pages)} page(s), {n} passages")
    if not rows:
        raise SystemExit("Nothing fetched; keeping the existing index")
    OUT.write_text(json.dumps({
        "note": "Passages from published EPA documents and AWWA-prepared EPA issue papers, for search. Built by fetch_guidance.py.",
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "documents": documents, "passages": rows}, ensure_ascii=False))
    print(f"wrote {OUT.name}: {len(documents)} documents, {len(rows)} passages, {OUT.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
