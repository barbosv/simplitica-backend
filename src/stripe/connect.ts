import type Stripe from "stripe";
import type { BusinessRecord, ConnectState } from "../db/types.js";

export function mapAccountToConnectState(account: Stripe.Account): ConnectState {
  if (account.charges_enabled && account.details_submitted) {
    return "active";
  }
  const disabled = account.requirements?.disabled_reason;
  if (disabled) {
    return "restricted";
  }
  if (account.details_submitted || account.charges_enabled || account.payouts_enabled) {
    return "pending";
  }
  return "not_started";
}

export function businessStatusResponse(business: BusinessRecord) {
  return {
    state: business.connectState,
    chargesEnabled: business.chargesEnabled,
    payoutsEnabled: business.payoutsEnabled,
    dashboardUrl: business.dashboardUrl ?? undefined,
  };
}

export async function syncBusinessFromStripeAccount(
  account: Stripe.Account,
): Promise<{
  connectState: ConnectState;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
}> {
  return {
    connectState: mapAccountToConnectState(account),
    chargesEnabled: Boolean(account.charges_enabled),
    payoutsEnabled: Boolean(account.payouts_enabled),
  };
}
