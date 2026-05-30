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
</body>
</html>`;
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
}
