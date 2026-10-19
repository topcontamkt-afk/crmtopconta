import { publicBackendUrl, publicUrlOfRequest } from "./publicUrl";
import { linkBase } from "../services/trackedLinks";

const req = (headers: Record<string, string> = {}) => ({
  originalUrl: "/api/voice/inbound?x=1",
  protocol: "http",
  headers,
  get: (n: string) => headers[n.toLowerCase()],
});

describe("endereço público", () => {
  const OLD = { ...process.env };
  afterEach(() => {
    process.env = { ...OLD };
  });

  it("vem só de PUBLIC_BACKEND_URL, sem barra no fim; sem ela, null (nada de endereço de outro ambiente)", () => {
    delete process.env.PUBLIC_BACKEND_URL;
    expect(publicBackendUrl()).toBeNull();
    process.env.PUBLIC_BACKEND_URL = " https://crm.exemplo.com.br/ ";
    expect(publicBackendUrl()).toBe("https://crm.exemplo.com.br");
  });

  it("URL assinada pelo Twilio: o endereço configurado manda, cabeçalhos X-Forwarded-* são ignorados", () => {
    process.env.PUBLIC_BACKEND_URL = "https://crm.exemplo.com.br";
    expect(publicUrlOfRequest(req({ host: "outro", "x-forwarded-host": "forjado", "x-forwarded-proto": "http" }))).toBe(
      "https://crm.exemplo.com.br/api/voice/inbound?x=1"
    );
  });

  it("sem endereço configurado (Node local), usa protocolo e host da requisição", () => {
    delete process.env.PUBLIC_BACKEND_URL;
    expect(publicUrlOfRequest(req({ host: "localhost:4000" }))).toBe("http://localhost:4000/api/voice/inbound?x=1");
  });

  it("links rastreados: LINK_BASE_URL, senão PUBLIC_BACKEND_URL, senão null", () => {
    delete process.env.LINK_BASE_URL;
    delete process.env.PUBLIC_BACKEND_URL;
    expect(linkBase()).toBeNull();
    process.env.PUBLIC_BACKEND_URL = "https://crm.exemplo.com.br/";
    expect(linkBase()).toBe("https://crm.exemplo.com.br");
    process.env.LINK_BASE_URL = "https://l.exemplo.com.br/";
    expect(linkBase()).toBe("https://l.exemplo.com.br");
  });
});
