jest.mock("../config/env", () => ({ env: { JWT_SECRET: "segredo-de-teste" } }));
jest.mock("./audit", () => ({ logAcessoNegado: jest.fn(async () => undefined) }));

import { requireRole } from "./auth";
import { logAcessoNegado } from "./audit";

function run(role: string | null) {
  const req: any = { method: "DELETE", originalUrl: "/api/clients/c1?x=1", user: role ? { id: "u1", tenantId: "t1", role } : undefined };
  const res: any = { status: jest.fn(() => res), json: jest.fn(() => res) };
  const next = jest.fn();
  requireRole("ADMIN")(req, res, next);
  return { res, next };
}

describe("LGPD 05-03: 403 por papel fica na auditoria", () => {
  beforeEach(() => jest.clearAllMocks());

  it("papel insuficiente responde 403 e registra a tentativa", () => {
    const { res, next } = run("VIEWER");
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
    expect(logAcessoNegado).toHaveBeenCalledWith(expect.objectContaining({ id: "u1", role: "VIEWER" }), "DELETE", "/api/clients/c1?x=1", ["ADMIN"]);
  });

  it("papel permitido segue sem registrar", () => {
    const { next } = run("ADMIN");
    expect(next).toHaveBeenCalled();
    expect(logAcessoNegado).not.toHaveBeenCalled();
  });
});
