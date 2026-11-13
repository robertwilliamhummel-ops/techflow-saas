import { Button as REButton } from "@react-email/components";
import { computeForeground, isValidHexColor } from "../../shared/contrast";
import { DEFAULT_PRIMARY_COLOR } from "../../shared/brandDefaults";

// Primary CTA — uses tenant primaryColor with a WCAG-safe computed foreground.
// Blueprint rule #6 of email design principles: contrast guard applies to CTA.
// Fallback if tenant primaryColor is invalid/missing: the neutral default brand
// colour (D13, slate #475569), 7.6:1 against white, so the computed foreground
// is always readable.

const FALLBACK_BG = DEFAULT_PRIMARY_COLOR;

interface ButtonProps {
  href: string;
  primaryColor?: string | null;
  children: React.ReactNode;
}

export function Button({ href, primaryColor, children }: ButtonProps) {
  const bg = isValidHexColor(primaryColor) ? primaryColor : FALLBACK_BG;
  const fg = computeForeground(bg);
  return (
    <REButton
      href={href}
      style={{
        backgroundColor: bg,
        color: fg,
        display: "inline-block",
        padding: "12px 24px",
        borderRadius: "6px",
        fontSize: "16px",
        fontWeight: 600,
        textDecoration: "none",
        textAlign: "center",
        fontFamily: "Arial, Helvetica, sans-serif",
      }}
    >
      {children}
    </REButton>
  );
}
