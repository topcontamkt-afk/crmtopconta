import { buildOtpAuthUri, buildQrCodeDataUri } from "./twoFactor";

describe("buildQrCodeDataUri", () => {
  it("gera SVG em data URI (o PNG trava a requisição no Worker)", async () => {
    const uri = await buildQrCodeDataUri(buildOtpAuthUri("a@b.c", "JBSWY3DPEHPK3PXP"));
    expect(uri.startsWith("data:image/svg+xml;base64,")).toBe(true);
    const svg = Buffer.from(uri.split(",")[1], "base64").toString("utf8");
    expect(svg).toMatch(/^<svg[\s\S]*<\/svg>\s*$/);
  });
});
