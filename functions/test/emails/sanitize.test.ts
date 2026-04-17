import { describe, expect, it } from "vitest";
import {
  sanitizeEmailField,
  sanitizeHeaderValue,
} from "../../src/emails/sanitize";

describe("sanitizeEmailField", () => {
  it("returns empty string for null/undefined/empty", () => {
    expect(sanitizeEmailField(null, 100)).toBe("");
    expect(sanitizeEmailField(undefined, 100)).toBe("");
    expect(sanitizeEmailField("", 100)).toBe("");
  });

  it("normalizes CR and LF to space (header smuggling vector)", () => {
    // CRLF and bare CR/LF all become single spaces — defuses smuggling while
    // preserving token boundaries so "Foo\nBcc:" doesn't collapse to "FooBcc:".
    expect(
      sanitizeEmailField("normal\r\nBcc: attacker@evil.com", 500),
    ).toBe("normal Bcc: attacker@evil.com");
    expect(sanitizeEmailField("line1\nline2", 500)).toBe("line1 line2");
    expect(sanitizeEmailField("line1\rline2", 500)).toBe("line1 line2");
  });

  it("strips NUL and other control chars except tab", () => {
    expect(sanitizeEmailField("safe\x00text", 500)).toBe("safetext");
    expect(sanitizeEmailField("safe\x01\x02\x03text", 500)).toBe("safetext");
    expect(sanitizeEmailField("safe\x1Ftext", 500)).toBe("safetext");
    expect(sanitizeEmailField("safe\x7Ftext", 500)).toBe("safetext");
    // Tab is preserved (collapsed to space by whitespace folding)
    expect(sanitizeEmailField("tabbed\ttext", 500)).toBe("tabbed text");
  });

  it("collapses runs of whitespace to single space", () => {
    expect(sanitizeEmailField("a   b", 500)).toBe("a b");
    expect(sanitizeEmailField("a\t\t\tb", 500)).toBe("a b");
    expect(sanitizeEmailField("a \t b", 500)).toBe("a b");
  });

  it("trims leading/trailing whitespace", () => {
    expect(sanitizeEmailField("  hello  ", 500)).toBe("hello");
    expect(sanitizeEmailField("\thello\n", 500)).toBe("hello");
  });

  it("caps length at maxLen", () => {
    expect(sanitizeEmailField("abcdefghij", 5)).toBe("abcde");
    expect(sanitizeEmailField("abc", 10)).toBe("abc");
  });

  it("returns empty string when maxLen is 0 or negative", () => {
    expect(sanitizeEmailField("anything", 0)).toBe("");
    expect(sanitizeEmailField("anything", -1)).toBe("");
  });

  it("coerces non-string inputs via String()", () => {
    expect(sanitizeEmailField(42, 10)).toBe("42");
    expect(sanitizeEmailField(true, 10)).toBe("true");
  });

  it("blocks LF-only header smuggling (Unix CRLF split)", () => {
    // Some SMTP stacks treat bare LF as a line break even without CR.
    const malicious = "Smith Plumbing\nBcc: steal@evil.com";
    const clean = sanitizeEmailField(malicious, 500);
    expect(clean).not.toContain("\n");
    expect(clean).not.toContain("\r");
    expect(clean).toBe("Smith Plumbing Bcc: steal@evil.com");
  });

  it("blocks CR-only header smuggling (old Mac CRLF split)", () => {
    const malicious = "Smith Plumbing\rBcc: steal@evil.com";
    const clean = sanitizeEmailField(malicious, 500);
    expect(clean).not.toContain("\n");
    expect(clean).not.toContain("\r");
  });

  it("handles realistic multi-line emailFooter safely", () => {
    const footer =
      "Smith Plumbing Ltd.\n123 Main St\nToronto, ON\n(416) 555-0100";
    const clean = sanitizeEmailField(footer, 500);
    expect(clean).toBe(
      "Smith Plumbing Ltd. 123 Main St Toronto, ON (416) 555-0100",
    );
  });
});

describe("sanitizeHeaderValue", () => {
  it("returns null when sanitized result is empty", () => {
    expect(sanitizeHeaderValue(null, 100)).toBeNull();
    expect(sanitizeHeaderValue("", 100)).toBeNull();
    expect(sanitizeHeaderValue("   ", 100)).toBeNull();
    expect(sanitizeHeaderValue("\r\n\r\n", 100)).toBeNull();
  });

  it("returns sanitized string when non-empty", () => {
    expect(sanitizeHeaderValue("contractor@example.com", 200)).toBe(
      "contractor@example.com",
    );
  });

  it("still removes CRLF from header values", () => {
    // Header value stays single-line: no CR, no LF. The space is fine —
    // Resend's replyTo validator will reject "a@b.com Bcc: ..." as not an
    // email, which is the right failure mode.
    const out = sanitizeHeaderValue("a@b.com\r\nBcc: evil@x", 200);
    expect(out).not.toContain("\n");
    expect(out).not.toContain("\r");
    expect(out).toBe("a@b.com Bcc: evil@x");
  });
});
