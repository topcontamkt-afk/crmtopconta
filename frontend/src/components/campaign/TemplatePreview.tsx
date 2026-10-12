import { useEffect, useState } from "react";
import { fetchBlobUrl } from "../../api/client";
import { renderSample, SAMPLE_CTX, WaTemplate } from "./types";

/** Como o cliente vai ver a mensagem no WhatsApp: imagem do cabeçalho, texto, rodapé e botões. */
export default function TemplatePreview({ template, ctx = SAMPLE_CTX, imageUrl }: { template: WaTemplate | null; ctx?: Record<string, string>; imageUrl?: string | null }) {
  const [img, setImg] = useState<string | null>(null);
  const temImagem = !!template?.imagem;
  const id = template?.id;
  const version = template?.imagem?.size;

  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    setImg(null);
    if (id && temImagem && !imageUrl) {
      fetchBlobUrl(`/templates/${id}/header`).then((u) => {
        if (cancelled) {
          if (u) URL.revokeObjectURL(u);
          return;
        }
        url = u;
        setImg(u);
      });
    }
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [id, temImagem, version, imageUrl]);

  if (!template) {
    return (
      <div>
        <strong>Selecione um template</strong>
        <p className="pd-hint">O preview aparece aqui quando você escolher.</p>
      </div>
    );
  }
  const rapidas = (template.quickReplies ?? []).filter(Boolean);
  const ctas = (template.buttons ?? []).filter((b) => b.text);
  const foto = imageUrl ?? img;
  return (
    <div className="cw-wa">
      <div className="cw-wa-bubble">
        {template.headerFormat === "IMAGE" &&
          (foto ? <img src={foto} alt="Imagem do cabeçalho" className="cw-wa-img" /> : <div className="cw-wa-img cw-wa-img-empty">{temImagem ? "Carregando imagem…" : "Sem imagem enviada"}</div>)}
        <p className="cw-wa-text">{renderSample(template, ctx)}</p>
        {template.footer && <div className="cw-wa-footer">{template.footer}</div>}
        <div className="cw-wa-time">agora</div>
      </div>
      {rapidas.map((b) => (
        <div key={b} className="cw-wa-btn">{b}</div>
      ))}
      {ctas.map((b, i) => (
        <div key={`c${i}`} className="cw-wa-btn">{b.type === "URL" ? "↗ " : "✆ "}{b.text}</div>
      ))}
    </div>
  );
}
