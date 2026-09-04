import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { hashCPF, maskCPF, normalizePhone } from "../src/services/masking";
import { computeUsage } from "../src/services/usage";

// RLS real (config/tenantGuard.ts): DATABASE_URL conecta como app_runtime, sem BYPASSRLS — mas
// criar o Tenant aqui é o próprio problema do ovo e da galinha (não dá pra setar a GUC
// app.tenant_id de um tenant que ainda não existe). Seed precisa do role administrativo
// (DATABASE_URL_ADMIN, o mesmo `postgres`/bypass de sempre), nunca do role restrito.
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL_ADMIN || process.env.DATABASE_URL } },
});

async function main() {
  const tenant = await prisma.tenant.create({
    data: { name: "TopConta Demo" },
  });

  const passwordHash = await bcrypt.hash("mudar123", 10);
  await prisma.user.createMany({
    data: [
      { tenantId: tenant.id, name: "Admin Demo", email: "admin@topconta.demo", passwordHash, role: "ADMIN" },
      { tenantId: tenant.id, name: "Operador Demo", email: "operador@topconta.demo", passwordHash, role: "OPERATOR" },
      { tenantId: tenant.id, name: "Analista Demo", email: "analista@topconta.demo", passwordHash, role: "ANALYST" },
    ],
  });

  const cidades = ["São Paulo", "Rio de Janeiro", "Belo Horizonte", "Curitiba", "Salvador"];
  const cpfs = ["52998224725", "11144477735", "39053344705", "16899535009", "84765374007"];

  for (let i = 0; i < 40; i++) {
    const limiteTotal = [0, 500, 1000, 2000, 5000][i % 5];
    const valorUtilizado = limiteTotal * [0, 0.1, 0.35, 0.6, 0.85, 1][i % 6];
    const { percentual, faixa } = computeUsage(limiteTotal, valorUtilizado);
    const cpfRaw = cpfs[i % cpfs.length] + String(i).padStart(2, "0").slice(0, 0); // mantém cpf válido base
    const phone = normalizePhone(`1199999${String(1000 + i).padStart(4, "0")}`);

    await prisma.client.create({
      data: {
        tenantId: tenant.id,
        externalId: `SEED-${i}`,
        nome: `Cliente Demo ${i + 1}`,
        telefone: phone || `+551199999${1000 + i}`,
        cpfHash: hashCPF(cpfs[i % cpfs.length], tenant.cpfSalt) + i, // garante unicidade no seed
        cpfMasked: maskCPF(cpfs[i % cpfs.length]),
        cidade: cidades[i % cidades.length],
        dataCadastro: new Date(Date.now() - i * 86400000),
        dataAberturaConta: new Date(Date.now() - (i + 30) * 86400000),
        limiteTotal,
        valorUtilizado,
        saldoDisponivel: limiteTotal - valorUtilizado,
        valorAntecipado: 0,
        dataUltimaUtilizacao: valorUtilizado > 0 ? new Date(Date.now() - i * 3600000) : null,
        percentualUtilizado: percentual,
        faixaUso: faixa,
        statusConta: i % 10 === 0 ? "INATIVO" : "ATIVO",
        origemCliente: "seed",
        autorizacaoComunicacao: i % 5 !== 0,
      },
    });
  }

  console.log("Seed concluído. Login: admin@topconta.demo / mudar123");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
