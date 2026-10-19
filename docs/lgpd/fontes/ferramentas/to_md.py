"""Converte atos normativos (HTML Planalto/DOU/gov.br ou PDF) em Markdown com âncora por artigo.

Uso:
  to_md.py html <entrada> <saida.md> --title T --source URL --sha SHA [--encoding cp1252]
           [--start REGEX] [--end REGEX]
  to_md.py pdf  <entrada> <saida.md> --title T --source URL --sha SHA
"""
import argparse
import re
import sys
import unicodedata

from bs4 import BeautifulSoup

ART_RE = re.compile(r"^Art\.\s*(\d+)\s*(?:º|°|o)?\s*(?:-\s*([A-Z]))?\s*[\.\-–—]?\s*(.*)$", re.S)
HEAD_RE = re.compile(r"^(T[ÍI]TULO|CAP[ÍI]TULO|Se[çc][ãa]o|SE[ÇC][ÃA]O|Subse[çc][ãa]o|ANEXO)\b", re.S)


def norm(s: str) -> str:
    s = unicodedata.normalize("NFC", s.replace("\xa0", " "))
    return re.sub(r"\s+", " ", s).strip()


def slug(s: str) -> str:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")


def blocks_from_html(path, encoding, start, end):
    raw = open(path, "rb").read().decode(encoding, errors="replace")
    soup = BeautifulSoup(raw, "html.parser")
    for t in soup(["script", "style", "noscript"]):
        t.decompose()
    root = (soup.select_one("div.texto-dou") or soup.select_one("#content-core")
            or soup.select_one("#parent-fieldname-text") or soup.select_one("#page-document")
            or soup.body or soup)
    out = []
    for el in root.find_all(["p", "h1", "h2", "h3", "h4", "h5", "h6", "li"]):
        if el.find_parent(["p", "li"]) is not None:
            continue
        for br in el.find_all("br"):
            br.replace_with("\n")
        parts = [norm(x) for x in el.get_text().split("\n")]
        text = " — ".join(p for p in parts if p) if HEAD_RE.match(parts[0] if parts else "") else norm(" ".join(parts))
        if text:
            out.append(text)
    if start:
        idx = next((i for i, b in enumerate(out) if re.search(start, b)), None)
        if idx is None:
            sys.exit(f"start regex não encontrado: {start}")
        out = out[idx:]
    if end:
        idx = next((i for i, b in enumerate(out) if re.search(end, b)), None)
        if idx is not None:
            out = out[: idx + 1]
    return out


def render(blocks, title, source, sha):
    md = [f"# {title}", "",
          f"> Fonte oficial: <{source}>  ",
          f"> sha256 do original: `{sha}`  ",
          "> Conversão automática para consulta e citação. Em caso de divergência, vale o original "
          "em `original/`.", ""]
    anchors = {}
    prefix = ""
    in_quote = False
    articles = 0
    for b in blocks:
        # Texto entre aspas (alteração de outra lei, ex. art. 60 da LGPD) não vira artigo.
        if not in_quote and b.startswith(("“", '"')):
            in_quote = True
        if in_quote:
            md += [f"> {b}", ""]
            if re.search(r"[”\"]\s*(\(NR\))?\s*\.?$", b) or "(NR)" in b:
                in_quote = False
            continue
        # Planalto às vezes quebra o número do artigo ("Art. 5 7. (VETADO)").
        b = re.sub(r"^Art\.\s*(\d+)\s+(\d+)\s*\.", r"Art. \1\2.", b)
        h = HEAD_RE.match(b)
        if h:
            if h.group(1).upper() == "ANEXO":
                prefix = slug(b.split("—")[0])[:20] + "-"
            md += [f"## {b}", ""]
            continue
        m = ART_RE.match(b)
        if m:
            num = m.group(1) + (f"-{m.group(2)}" if m.group(2) else "")
            anchor = f"{prefix}art-{num.lower()}"
            n = anchors.get(anchor, 0) + 1
            anchors[anchor] = n
            if n > 1:
                anchor = f"{anchor}-v{n}"
            label = f"Art. {m.group(1)}{'º' if int(m.group(1)) < 10 else ''}" + (f"-{m.group(2)}" if m.group(2) else "")
            md += [f'<a id="{anchor}"></a>', "", f"### {label}", "", m.group(3) or "", ""]
            articles += 1
            continue
        md += [b, ""]
    return "\n".join(md).rstrip() + "\n", articles, anchors


def pdf_to_md(path, title, source, sha):
    from pypdf import PdfReader
    r = PdfReader(path)
    md = [f"# {title}", "",
          f"> Fonte oficial: <{source}>  ",
          f"> sha256 do original: `{sha}`  ",
          "> Extração automática de texto do PDF, por página, para consulta e citação "
          "(`#p-N` = página N do PDF). Em caso de divergência, vale o PDF em `original/`.", ""]
    for i, page in enumerate(r.pages, 1):
        text = page.extract_text() or ""
        text = re.sub(r"-\n(\w)", r"\1", text)
        md += [f'<a id="p-{i}"></a>', "", f"## Página {i}", "", text.strip(), ""]
    return "\n".join(md).rstrip() + "\n", len(r.pages)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("kind", choices=["html", "pdf"])
    ap.add_argument("inp")
    ap.add_argument("out")
    ap.add_argument("--title", required=True)
    ap.add_argument("--source", required=True)
    ap.add_argument("--sha", required=True)
    ap.add_argument("--encoding", default="utf-8")
    ap.add_argument("--start")
    ap.add_argument("--end")
    a = ap.parse_args()
    if a.kind == "pdf":
        text, pages = pdf_to_md(a.inp, a.title, a.source, a.sha)
        print(f"{a.out}: {pages} páginas")
    else:
        blocks = blocks_from_html(a.inp, a.encoding, a.start, a.end)
        text, n, anchors = render(blocks, a.title, a.source, a.sha)
        dups = [k for k, v in anchors.items() if v > 1]
        print(f"{a.out}: {n} artigos, {len(anchors)} âncoras únicas, duplicadas={dups}")
    open(a.out, "w", encoding="utf-8").write(text)


if __name__ == "__main__":
    main()
