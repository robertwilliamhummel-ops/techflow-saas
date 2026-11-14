import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BusinessMark } from "@/components/portal/BusinessMark";
import { BusinessLogo } from "../BusinessLogo";

const LOGO = "https://firebasestorage.googleapis.com/v0/b/demo/o/tenants%2Facme%2Flogo.png?alt=media&token=t";

function imgOf(html: string): string {
  const img = /<img [^>]*>/.exec(html)?.[0];
  if (!img) throw new Error(`no <img> in ${html}`);
  return img;
}

describe("BusinessLogo", () => {
  it("keeps the logo's own shape: scaled into a max box, never a fixed square", () => {
    const img = imgOf(renderToStaticMarkup(createElement(BusinessLogo, { src: LOGO, maxWidth: 144, maxHeight: 32 })));
    expect(img).toContain('class="h-auto w-auto object-contain"');
    expect(img).toContain("max-width:144px");
    expect(img).toContain("max-height:32px");
    expect(img).not.toMatch(/size-\d/);
  });

  it("sits a logo on a white tile as tall as the box plus padding, never narrower than tall", () => {
    const html = renderToStaticMarkup(
      createElement(BusinessLogo, { src: LOGO, maxWidth: 160, maxHeight: 40, tile: true }),
    );
    expect(html).toMatch(/^<span class="[^"]*\bbg-white\b[^"]*" style="height:48px;min-width:48px">/);
    expect(imgOf(html)).toContain("max-width:160px");
  });

  it("puts the caller's classes on the outermost element", () => {
    expect(
      renderToStaticMarkup(createElement(BusinessLogo, { src: LOGO, maxWidth: 240, maxHeight: 64, className: "mx-auto" })),
    ).toMatch(/^<img [^>]*class="h-auto w-auto object-contain mx-auto"/);
    expect(
      renderToStaticMarkup(
        createElement(BusinessLogo, { src: LOGO, maxWidth: 80, maxHeight: 32, tile: true, className: "ring-1" }),
      ),
    ).toMatch(/^<span class="[^"]*\bring-1\b/);
  });
});

describe("BusinessMark", () => {
  it("shows a list row's logo up to 80 × 32 and a document header's up to 160 × 40", () => {
    const row = renderToStaticMarkup(
      createElement(BusinessMark, { name: "Acme", logoUrl: LOGO, primaryColor: "#123456" }),
    );
    expect(imgOf(row)).toContain("max-width:80px;max-height:32px");
    const header = renderToStaticMarkup(
      createElement(BusinessMark, { name: "Acme", logoUrl: LOGO, primaryColor: "#123456", size: "lg" }),
    );
    expect(imgOf(header)).toContain("max-width:160px;max-height:40px");
  });

  it("shows the initial on the brand colour without a logo", () => {
    const html = renderToStaticMarkup(
      createElement(BusinessMark, { name: "acme", logoUrl: null, primaryColor: "#123456" }),
    );
    expect(html).not.toContain("<img");
    expect(html).toContain(">A</span>");
  });
});
