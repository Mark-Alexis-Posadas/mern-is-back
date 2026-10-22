export class AuthValidationError extends Error {}

export interface LoginInput {
  email: string;
  password: string;
}

export interface RegistrationInput extends LoginInput {
  name: string;
}

function bodyObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AuthValidationError(
      "A valid authentication request is required.",
    );
  }
  return input as Record<string, unknown>;
}

function emailInput(value: unknown): string {
  if (typeof value !== "string" || value.length > 512) {
    throw new AuthValidationError("A valid email address is required.");
  }
  const email = value.trim().toLowerCase();
  const parts = email.split("@");
  const local = parts[0] ?? "";
  const domain = parts[1] ?? "";
  const labels = domain.split(".");
  if (
    email.length > 254 ||
    parts.length !== 2 ||
    local.length < 1 ||
    local.length > 64 ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..") ||
    labels.length < 2 ||
    labels.some(
      (label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
    )
  ) {
    throw new AuthValidationError("A valid email address is required.");
  }
  return email;
}

function passwordInput(value: unknown, registration: boolean): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > (registration ? 72 : 1024)
  ) {
    throw new AuthValidationError(
      registration
        ? "Password must contain 8 or more characters and fit within 72 UTF-8 bytes."
        : "A password of at most 1024 UTF-8 bytes is required.",
    );
  }
  if (
    registration &&
    (value.length < 8 ||
      !/[A-Z]/.test(value) ||
      !/[0-9]/.test(value) ||
      value.includes("\0"))
  ) {
    throw new AuthValidationError(
      "Password must contain at least 8 characters, an uppercase letter, and a number.",
    );
  }
  // Never trim passwords. Login deliberately does not apply new-account rules.
  return value;
}

export function validateLogin(input: unknown): LoginInput {
  const body = bodyObject(input);
  return {
    email: emailInput(body.email),
    password: passwordInput(body.password, false),
  };
}

export function validateRegistration(input: unknown): RegistrationInput {
  const body = bodyObject(input);
  if (typeof body.name !== "string" || body.name.length > 200) {
    throw new AuthValidationError("Name must contain 2 to 100 characters.");
  }
  const name = body.name.trim();
  if (
    name.length < 2 ||
    name.length > 100 ||
    /[\u0000-\u001f\u007f]/.test(name)
  ) {
    throw new AuthValidationError("Name must contain 2 to 100 characters.");
  }
  // Only these fields are accepted; role and other extra properties are ignored.
  return {
    name,
    email: emailInput(body.email),
    password: passwordInput(body.password, true),
  };
}
