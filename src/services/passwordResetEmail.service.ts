export async function sendPasswordResetEmail(
  email: string,
  token: string,
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.PASSWORD_RESET_FROM;
  const frontendUrl = process.env.CLIENT_URL;
  if (!apiKey || !from || !frontendUrl) return;

  const base = new URL(frontendUrl);
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/"
  ) {
    throw new Error("CLIENT_URL must be a frontend origin without a path.");
  }
  if (base.protocol !== "https:" && base.hostname !== "localhost") {
    throw new Error("CLIENT_URL must use HTTPS outside localhost.");
  }
  const resetUrl = new URL("/reset-password", base);
  resetUrl.searchParams.set("token", token);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [email],
      subject: "Reset your ShopSphere password",
      text: `Use this link to reset your password. It expires in 20 minutes.\n\n${resetUrl.toString()}\n\nIf you did not request a reset, you can ignore this email.`,
    }),
  });
  if (!response.ok) throw new Error("Password reset email could not be sent.");
}
