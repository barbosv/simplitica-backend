import type { FastifyInstance } from "fastify";

function landingPage(title: string, message: string, actionHref: string, actionLabel: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 2rem; line-height: 1.5; color: #1a1a1a; }
    a { display: inline-block; margin-top: 1.25rem; padding: 0.75rem 1.25rem; background: #2563eb; color: #fff; text-decoration: none; border-radius: 8px; }
  </style>
</head>
<body>
  <h1>${title}</h1>
  <p>${message}</p>
  <a href="${actionHref}">${actionLabel}</a>
  <script>
    // Best-effort app handoff. If the app is unavailable, the user keeps this page.
    setTimeout(function () { window.location.href = ${JSON.stringify(actionHref)}; }, 250);
  </script>
</body>
</html>`;
}

function normalizedPaymentDeepLink(
  appReturnUrl: unknown,
  outcome: "success" | "cancel",
  invoiceId: string | undefined,
): string {
  if (typeof appReturnUrl === "string" && appReturnUrl.length > 0) {
    try {
      const parsed = new URL(appReturnUrl);
      if (parsed.protocol === "simpli-invoice:") return parsed.toString();
    } catch {
      // Ignore malformed appReturnUrl and fall back to generated deep link.
    }
  }
  const qp = invoiceId ? `?invoiceId=${encodeURIComponent(invoiceId)}` : "";
  return `simpli-invoice://payment/${outcome}${qp}`;
}

/** Stripe Connect Account Links redirect here after onboarding (HTTPS required by Stripe). */
export function registerStripeConnectLandingRoutes(app: FastifyInstance): void {
  app.get("/stripe/return", async (_req, reply) => {
    return reply
      .type("text/html; charset=utf-8")
      .send(
        landingPage(
          "Stripe setup complete",
          "Return to Simpli Invoice and tap Refresh Status to confirm your account is ready.",
          "simpli-invoice://settings/stripe",
          "Open Simpli Invoice",
        ),
      );
  });

  app.get("/stripe/refresh", async (_req, reply) => {
    return reply
      .type("text/html; charset=utf-8")
      .send(
        landingPage(
          "Continue Stripe setup",
          "This link expired. Open Simpli Invoice and tap Connect With Stripe to continue.",
          "simpli-invoice://settings/stripe",
          "Open Simpli Invoice",
        ),
      );
  });

  app.get("/payment/success", async (req, reply) => {
    const query = req.query as { invoiceId?: string; appReturnUrl?: string };
    const appURL = normalizedPaymentDeepLink(query.appReturnUrl, "success", query.invoiceId);
    return reply
      .type("text/html; charset=utf-8")
      .send(
        landingPage(
          "Payment received",
          "Thanks! Your payment was submitted successfully.",
          appURL,
          "Open Simpli Invoice",
        ),
      );
  });

  app.get("/payment/cancel", async (req, reply) => {
    const query = req.query as { invoiceId?: string; appReturnUrl?: string };
    const appURL = normalizedPaymentDeepLink(query.appReturnUrl, "cancel", query.invoiceId);
    return reply
      .type("text/html; charset=utf-8")
      .send(
        landingPage(
          "Payment canceled",
          "No charge was made. You can return to the invoice and try again anytime.",
          appURL,
          "Open Simpli Invoice",
        ),
      );
  });
}
