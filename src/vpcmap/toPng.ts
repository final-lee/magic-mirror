const SCALE = 2;

/** 현재 SVG를 원본 크기 ×2 PNG 바이트로 만든다. 확대/이동은 무시한다. */
export async function svgToPng(svg: SVGSVGElement, width: number, height: number): Promise<Uint8Array> {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.querySelector("[data-viewport]")?.removeAttribute("transform");
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  clone.setAttribute("viewBox", `0 0 ${width} ${height}`);
  clone.removeAttribute("style");
  const xml = new XMLSerializer().serializeToString(clone);
  const url = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const img = new Image();
    img.width = width;
    img.height = height;
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("이미지를 만들지 못했어요"));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = width * SCALE;
    canvas.height = height * SCALE;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("캔버스를 만들지 못했어요");
    ctx.scale(SCALE, SCALE);
    ctx.drawImage(img, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("PNG로 변환하지 못했어요");
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
}
