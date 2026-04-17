import { Button as REButton } from "@react-email/components";
import { computeForeground, isValidHexColor } from "../../shared/contrast";

// Primary CTA — uses tenant primaryColor with a WCAG-safe computed foreground.
// Blueprint rule #6 of email design principles: contrast guard applies to CTA.
// Fallback color if tenant primaryColor is invalid/missing is Tailwind indigo-600
// (#4F46E5) because its contrast against white is 4.56:1 and against any of its
// computed foregrounds is AAA-grade.

const FALLBACK_BG = "#4F46E5";

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
