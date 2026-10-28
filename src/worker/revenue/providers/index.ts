import type { Provider } from "../../../shared/sites";
import type { ProviderAdapter } from "../types";
import { creem } from "./creem";
import { dodo } from "./dodo";
import { fastspring } from "./fastspring";
import { gumroad } from "./gumroad";
import { lemonsqueezy } from "./lemonsqueezy";
import { paddle } from "./paddle";
import { paypal } from "./paypal";
import { stripe } from "./stripe";

export const ADAPTERS: Record<Provider, ProviderAdapter> = { stripe, paddle, lemonsqueezy, dodo, creem, gumroad, fastspring, paypal };
