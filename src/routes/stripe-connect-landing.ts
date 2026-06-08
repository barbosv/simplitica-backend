import type { FastifyInstance } from "fastify";

const baseStyles = `
    body {
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      margin: 0;
      padding: 2rem 1.25rem;
      line-height: 1.55;
      color: #1a1a1a;
      background: #f8fafc;
    }
    main {
      max-width: 28rem;
      margin: 0 auto;
      padding: 1.75rem 1.5rem;
      background: #fff;
      border-radius: 12px;
      border: 1px solid #e2e8f0;
      box-shadow: 0 1px 3px rgba(15, 23, 42, 0.06);
    }
    h1 { font-size: 1.5rem; font-weight: 700; margin: 0 0 0.75rem; }
    p { margin: 0 0 0.75rem; color: #334155; }
    .footer { margin-top: 1.25rem; font-size: 0.875rem; color: #64748b; }
    a.cta {
      display: inline-block;
      margin-top: 1.25rem;
      padding: 0.75rem 1.25rem;
      background: #2563eb;
      color: #fff;
      text-decoration: none;
      border-radius: 8px;
      font-weight: 600;
    }
`;

/** Contractor Stripe Connect onboarding — returns to the iOS app. */
function contractorHandoffPage(
  title: string,
  message: string,
  actionHref: string,
  actionLabel: string,
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>${baseStyles}</style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    <p>${message}</p>
    <a class="cta" href="${actionHref}">${actionLabel}</a>
  </main>
  <script>
    setTimeout(function () { window.location.href = ${JSON.stringify(actionHref)}; }, 250);
  </script>
</body>
</html>`;
}

/** Customer Checkout receipt — no app install or deep link. */
function customerReceiptPage(title: string, message: string, footer: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>${baseStyles}</style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    <p>${message}</p>
    <p class="footer">${footer}</p>
  </main>
</body>
</html>`;
}

/** Stripe Connect Account Links redirect here after onboarding (HTTPS required by Stripe). */
export function registerStripeConnectLandingRoutes(app: FastifyInstance): void {
  app.get("/stripe/return", async (_req, reply) => {
    return reply
      .type("text/html; charset=utf-8")
      .send(
        contractorHandoffPage(
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
        contractorHandoffPage(
          "Continue Stripe setup",
          "This link expired. Open Simpli Invoice and tap Connect With Stripe to continue.",
          "simpli-invoice://settings/stripe",
          "Open Simpli Invoice",
        ),
      );
  });

  app.get("/payment/success", async (_req, reply) => {
    return reply
      .type("text/html; charset=utf-8")
      .send(
        customerReceiptPage(
          "Payment complete",
          "Thank you — your payment was received successfully. A receipt may be sent by email if your payment method provides one.",
          "You can close this window.",
        ),
      );
  });

  app.get("/payment/cancel", async (_req, reply) => {
    return reply
      .type("text/html; charset=utf-8")
      .send(
        customerReceiptPage(
          "Payment not completed",
          "No charge was made. You can close this page and use the payment link from your invoice if you would like to try again.",
          "You can close this window.",
        ),
      );
  });
}
