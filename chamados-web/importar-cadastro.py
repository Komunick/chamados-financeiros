# -*- coding: utf-8 -*-
"""Importa o cadastro de placas (planilha FROTA CERTADOC) e de motoristas
(CSV da programação) para o arquivo chamados-data/cadastro.json, usado pelo
autocompletar do formulário "Novo chamado".

Uso (com uv, sem instalar nada):
    uv run --with openpyxl python importar-cadastro.py
    uv run --with openpyxl python importar-cadastro.py --frota "C:\\caminho\\FROTA.xlsx" --motoristas "C:\\caminho\\MOTORISTAS.csv"

Ou dê dois cliques em IMPORTAR-CADASTRO.bat.
Rode de novo sempre que a frota ou a programação de motoristas mudar.
"""
import argparse
import csv
import json
import os
import re
import sys
from datetime import datetime

PADRAO_FROTA = r"C:\Users\brazil\Downloads\FROTA CERTADOC (2).xlsx"
PADRAO_MOTORISTAS = r"C:\Users\brazil\Downloads\PROGRAMAÇÃO BRAZIL TRANSPORTS - MOTORISTAS.csv"
RAIZ = os.path.dirname(os.path.abspath(__file__))
PADRAO_SAIDA = os.path.join(os.path.dirname(RAIZ), "chamados-data", "cadastro.json")


def so_digitos(v):
    return re.sub(r"\D", "", v or "")


def fmt_telefone(v):
    d = so_digitos(v)
    if len(d) == 11:
        return f"({d[0:2]}) {d[2:7]}-{d[7:]}"
    if len(d) == 10:
        return f"({d[0:2]}) {d[2:6]}-{d[6:]}"
    return ""  # incompleto: melhor vazio do que travar o formulário


def fmt_cpf(v):
    d = so_digitos(v)
    if len(d) != 11:
        return ""
    return f"{d[0:3]}.{d[3:6]}.{d[6:9]}-{d[9:]}"


def ler_frota(caminho):
    import openpyxl
    wb = openpyxl.load_workbook(caminho, read_only=True, data_only=True)
    # A aba de dados é a "1º PASSO" (a primeira é só instruções).
    ws = wb[wb.sheetnames[1]] if len(wb.sheetnames) > 1 else wb.active
    veiculos = []
    vistos = set()
    for row in ws.iter_rows(min_row=10, values_only=True):
        placa = str(row[1] or "").strip().upper().replace("-", "")
        if not re.fullmatch(r"[A-Z]{3}\d[A-Z0-9]\d{2}", placa):
            continue  # ignora cabeçalho, vazios e lixo
        if placa in vistos:
            continue
        vistos.add(placa)
        veiculos.append({
            "placa": placa,
            "renavam": so_digitos(str(row[2] or "")),
        })
    return veiculos


def ler_motoristas(caminho):
    with open(caminho, encoding="utf-8-sig", newline="") as f:
        linhas = list(csv.DictReader(f))
    motoristas = []
    por_chave = {}
    for l in linhas:
        nome = re.sub(r"\s+", " ", (l.get("MOTORISTA") or "")).strip()
        if not nome:
            continue
        cpf = fmt_cpf(l.get("CPF") or "")
        m = {
            "nome": nome,
            "cpf": cpf,
            "telefone": fmt_telefone(l.get("TELEFONE") or ""),
            "status": (l.get("STATUS") or "").strip().upper(),
            "vinculo": (l.get("FROTA / AGREGADO") or "").strip().upper(),
            "vencimentoCnh": (l.get("VENCIMENTO CNH") or "").strip(),
        }
        chave = so_digitos(cpf) or nome.upper()
        existente = por_chave.get(chave)
        if existente:
            # duplicado: mantém o registro mais completo
            if not existente["cpf"] and m["cpf"]:
                existente.update(m)
            continue
        por_chave[chave] = m
        motoristas.append(m)
    motoristas.sort(key=lambda m: m["nome"].upper())
    return motoristas


def main():
    ap = argparse.ArgumentParser(description="Importa placas e motoristas para o cadastro.json")
    ap.add_argument("--frota", default=PADRAO_FROTA, help="planilha xlsx da frota (CertaDoc)")
    ap.add_argument("--motoristas", default=PADRAO_MOTORISTAS, help="csv da programação de motoristas")
    ap.add_argument("--saida", default=PADRAO_SAIDA, help="cadastro.json de destino")
    args = ap.parse_args()

    for caminho, rotulo in [(args.frota, "frota"), (args.motoristas, "motoristas")]:
        if not os.path.isfile(caminho):
            sys.exit(f"ERRO: arquivo de {rotulo} não encontrado: {caminho}")

    veiculos = ler_frota(args.frota)
    motoristas = ler_motoristas(args.motoristas)
    cadastro = {
        "atualizadoEm": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "fonteFrota": os.path.basename(args.frota),
        "fonteMotoristas": os.path.basename(args.motoristas),
        "veiculos": veiculos,
        "motoristas": motoristas,
    }
    os.makedirs(os.path.dirname(args.saida), exist_ok=True)
    tmp = args.saida + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cadastro, f, ensure_ascii=False, indent=1)
    os.replace(tmp, args.saida)
    print(f"OK: {len(veiculos)} veículos e {len(motoristas)} motoristas gravados em {args.saida}")


if __name__ == "__main__":
    main()
