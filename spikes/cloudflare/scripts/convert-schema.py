"""Converte backend/prisma/schema.prisma (Postgres) para SQLite/D1 (Prisma 7), só para o spike da Fase 0.

Uso: python3 -I scripts/convert-schema.py <origem> <destino>
"""
import re
import sys

src, dst = sys.argv[1], sys.argv[2]
s = open(src, encoding="utf-8").read()

s = re.sub(
    r"generator client \{.*?\n\}",
    'generator client {\n  provider = "prisma-client"\n  output   = "../src/generated/prisma"\n  runtime  = "cloudflare"\n}',
    s, count=1, flags=re.S,
)
s = re.sub(r"datasource db \{.*?\n\}", 'datasource db {\n  provider = "sqlite"\n}', s, count=1, flags=re.S)
s = re.sub(r"\s*@db\.\w+(\([^)]*\))?", "", s)          # tipos nativos do Postgres
s = re.sub(r"String\[\](\s+)@default\(\[\]\)", r'Json\1@default("[]")', s)  # listas escalares
s = re.sub(r"String\[\]", "Json", s)

open(dst, "w", encoding="utf-8").write(s)
print("ok", dst)
