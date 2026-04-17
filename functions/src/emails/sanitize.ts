// Email-field sanitizer — blueprint R4.
//
// Tenant-controlled strings flow into email templates AND SMTP headers
// (replyTo). Two attack surfaces to defuse before the string reaches Resend
// or the rendered HTML:
//
//   1. Header smuggling. A CRLF in a value passed as `replyTo` could split
//      the header and inject a Bcc: line. Resend's SDK may or may not strip
//      these — we never rely on that.
//   2. Plain-text fallback injection. React Email auto-generates text from
//      the JSX tree; embedded newlines in emailFooter can impersonate
//      separate paragraphs in a forwarded thread.
//
// Strategy: strip all control characters (including CR/LF and NUL), keep
// tab-as-whitespace, then collapse whitespace runs, trim, and cap length.
// Every tenant-controlled string MUST pass through this before being used
// as email content or an SMTP header value.

// Attack-class control chars: NUL, most C0 controls, and DEL. These have
// no legitimate textual meaning and are stripped entirely. CR/LF/tab are
// handled separately — they get normalized to spaces by the whitespace
// pass so adjacent tokens don't silently concatenate (a plumbing company
// named "Smith Plumbing\nBcc: x" must not collapse to "Smith PlumbingBcc: x").
const UNSAFE_CONTROL_RE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function sanitizeEmailField(
  input: unknown,
  maxLen: number,
): string {
  if (input === null || input === undefined) return "";
  if (maxLen <= 0) return "";
  const raw = String(input);
  // Pass 1: drop attack-class controls (NUL, \x01-\x08, VT, FF, \x0E-\x1F, DEL).
  const stripped = raw.replace(UNSAFE_CONTROL_RE, "");
  // Pass 2: fold every whitespace run — CR, LF, tab, multiple spaces — into
  // a single space. This is what defuses header smuggling: a CR or LF in a
  // replyTo value becomes a space, so Resend's SDK (or any SMTP backend)
  // sees a single-line header value.
  const collapsed = stripped.replace(/\s+/g, " ").trim();
  return collapsed.slice(0, maxLen);
}

// Strict sanitizer for SMTP header values (From, Reply-To, Subject). Returns
// null if the field is empty post-sanitization — caller decides whether that's
// an error (replyTo required) or a fallback signal.
export function sanitizeHeaderValue(
  input: unknown,
  maxLen: number,
): string | null {
  const s = sanitizeEmailField(input, maxLen);
  return s.length === 0 ? null : s;
}
