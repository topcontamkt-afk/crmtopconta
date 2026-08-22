import "express";

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        tenantId: string;
        role: "ADMIN" | "OPERATOR" | "ANALYST" | "VIEWER";
        email: string;
      };
      /**
       * Corpo bruto (bytes) da requisição JSON, capturado pelo `verify` do express.json() em
       * app.ts. Usado pelo webhook do WhatsApp (POST /api/integrations/webhooks/whatsapp) para
       * verificar a assinatura X-Hub-Signature-256, que precisa ser calculada sobre os bytes
       * exatos recebidos — não sobre o objeto já parseado/serializado de volta.
       */
      rawBody?: Buffer;
    }
  }
}
