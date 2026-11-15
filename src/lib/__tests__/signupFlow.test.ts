import { describe, expect, it, vi } from "vitest";
import { completeSignup, type SignupSteps, type SignupUser } from "../auth/signupFlow";

const VALUES = { businessName: "Acme Plumbing", email: "owner@acme.test", password: "hunter22!" };

function user(overrides: Partial<SignupUser> = {}): SignupUser {
  return { emailVerified: false, ...overrides };
}

function authError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

const emailInUse = () =>
  vi.fn(async (): Promise<SignupUser> => {
    throw authError("auth/email-already-in-use");
  });

// A fake Firebase: tenantIdOf returns whatever the "token" holds after onSignup.
function steps(overrides: Partial<SignupSteps<SignupUser>> = {}) {
  let tenantId: string | null = null;
  const defaults = {
    createUser: vi.fn(async (): Promise<SignupUser> => user()),
    signIn: vi.fn(async (): Promise<SignupUser> => user()),
    tenantIdOf: vi.fn(async () => tenantId),
    onSignup: vi.fn(async () => {
      tenantId = "acme-plumbing";
    }),
    sendEmailVerification: vi.fn(async () => {}),
  };
  // Overrides are vi.fn() mocks too.
  return { ...defaults, ...overrides } as typeof defaults;
}

describe("completeSignup", () => {
  it("creates the account, then the business, then refreshes the token", async () => {
    const s = steps();
    await completeSignup(VALUES, s);

    expect(s.createUser).toHaveBeenCalledWith(VALUES.email, VALUES.password);
    expect(s.onSignup).toHaveBeenCalledWith("Acme Plumbing");
    expect(s.sendEmailVerification).toHaveBeenCalledOnce();
    expect(s.tenantIdOf).toHaveBeenCalledOnce();
    expect(await s.tenantIdOf.mock.results[0].value).toBe("acme-plumbing");
    expect(s.signIn).not.toHaveBeenCalled();
  });

  it("a failed onSignup is reported, and pressing Create again finishes the same account", async () => {
    // The Auth account exists after the first try, as in Firebase.
    let exists = false;
    const s = steps({
      createUser: vi.fn(async () => {
        if (exists) throw authError("auth/email-already-in-use");
        exists = true;
        return user();
      }),
    });
    s.onSignup.mockRejectedValueOnce(
      Object.assign(new Error("deadline-exceeded"), { code: "functions/deadline-exceeded" }),
    );

    await expect(completeSignup(VALUES, s)).rejects.toThrow("deadline-exceeded");
    await completeSignup(VALUES, s);

    expect(s.signIn).toHaveBeenCalledWith(VALUES.email, VALUES.password);
    expect(s.onSignup).toHaveBeenCalledTimes(2);
    expect(await s.tenantIdOf.mock.results.at(-1)!.value).toBe("acme-plumbing");
  });

  it("an account that already has a business is left alone, signed in as a login would", async () => {
    const s = steps({
      createUser: emailInUse(),
      tenantIdOf: vi.fn(async () => "acme-plumbing"),
    });

    await completeSignup(VALUES, s);

    expect(s.onSignup).not.toHaveBeenCalled();
  });

  it("doesn't resend the verification email to a verified account", async () => {
    const s = steps({
      createUser: emailInUse(),
      signIn: vi.fn(async () => user({ emailVerified: true })),
    });
    await completeSignup(VALUES, s);
    expect(s.onSignup).toHaveBeenCalledOnce();
    expect(s.sendEmailVerification).not.toHaveBeenCalled();
  });

  it("never attaches a business to an account it can't sign in to with the password", async () => {
    // e.g. someone else's account, or a portal customer's email-link account.
    const s = steps({
      createUser: emailInUse(),
      signIn: vi.fn(async (): Promise<SignupUser> => {
        throw authError("auth/invalid-credential");
      }),
    });

    await expect(completeSignup(VALUES, s)).rejects.toMatchObject({
      code: "auth/email-already-in-use",
    });
    expect(s.onSignup).not.toHaveBeenCalled();
    expect(s.tenantIdOf).not.toHaveBeenCalled();
  });

  it("passes other create errors through", async () => {
    const s = steps({
      createUser: vi.fn(async (): Promise<SignupUser> => {
        throw authError("auth/weak-password");
      }),
    });
    await expect(completeSignup(VALUES, s)).rejects.toMatchObject({ code: "auth/weak-password" });
    expect(s.signIn).not.toHaveBeenCalled();
  });
});
