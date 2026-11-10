import type Stripe from "stripe";
import { mapAccountToConnectState } from "../stripe/connect.js";

const now = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/** Apply one supported mutation and its completion marker in a single D1 transaction. */
export async function processD1StripeEvent(
  db: D1Database,
  event: Stripe.Event,
): Promise<"processed" | "duplicate"> {
  let target:
    | {
        table: string;
        where: string;
        values: unknown[];
        set: string;
        updates: unknown[];
        /** When false, ack even if no row matches (Express account.updated no-op). */
        required: boolean;
      }
    | undefined;
  if (event.type === "account.updated") {
    const account = event.data.object as Stripe.Account;
    target = {
      table: "businesses",
      where: "stripe_account_id=?",
      values: [account.id],
      set: "connect_state=?,charges_enabled=?,payouts_enabled=?",
      updates: [
        mapAccountToConnectState(account),
        Number(Boolean(account.charges_enabled)),
        Number(Boolean(account.payouts_enabled)),
      ],
      // Match Express: early Connect events before the business is linked are acked, not retried.
      required: false,
    };
  } else if (
    [
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
    ].includes(event.type)
  ) {
    const session = event.data.object as Stripe.Checkout.Session;
    if (session.payment_status === "paid") {
      const metadata = session.metadata;
      target = {
        table: "invoice_payments",
        where:
          metadata?.businessId && metadata?.invoiceId
            ? "business_id=? AND invoice_id=?"
            : "checkout_session_id=?",
        values:
          metadata?.businessId && metadata?.invoiceId
            ? [metadata.businessId, metadata.invoiceId]
            : [session.id],
        set: "status='paid',paid_at=?,checkout_session_id=?,amount_cents=COALESCE(?,amount_cents)",
        updates: [
          new Date(
            (session.created ?? Math.floor(Date.now() / 1000)) * 1000,
          ).toISOString(),
          session.id,
          session.amount_total ?? null,
        ],
        required: true,
      };
    }
  } else if (event.type === "payment_intent.succeeded") {
    const intent = event.data.object as Stripe.PaymentIntent;
    if (intent.metadata?.businessId && intent.metadata?.invoiceId) {
      target = {
        table: "invoice_payments",
        where: "business_id=? AND invoice_id=?",
        values: [intent.metadata.businessId, intent.metadata.invoiceId],
        set: "status='paid',paid_at=?,amount_cents=COALESCE(?,amount_cents)",
        updates: [new Date().toISOString(), intent.amount_received ?? null],
        required: true,
      };
    }
  }
  const exists =
    target?.required === true
      ? ` WHERE EXISTS(SELECT 1 FROM ${target.table} WHERE ${target.where})`
      : "";
  const insert = db
    .prepare(
      `INSERT INTO stripe_events(event_id,type) SELECT ?,?${exists} ON CONFLICT(event_id) DO NOTHING RETURNING event_id`,
    )
    .bind(
      event.id,
      event.type,
      ...(target?.required === true ? (target.values ?? []) : []),
    );
  const statements = [insert];
  if (target) {
    // SQLite changes() reads the INSERT immediately before this UPDATE in the batch.
    // A duplicate INSERT changes zero rows, so it cannot apply the mutation again.
    statements.push(
      db
        .prepare(
          `UPDATE ${target.table} SET ${target.set},updated_at=${now} WHERE ${target.where} AND changes()=1`,
        )
        .bind(...target.updates, ...target.values),
    );
  }
  const [result] = await db.batch(statements);
  if (result.results.length > 0) return "processed";
  const completed = await db
    .prepare("SELECT 1 FROM stripe_events WHERE event_id=?")
    .bind(event.id)
    .first();
  if (completed) return "duplicate";
  throw new Error("Webhook target is not available yet; delivery must retry");
}
