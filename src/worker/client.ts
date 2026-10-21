// Typed RPC client for the admin SPA. The SPA imports only this file; the
// route types come from the emitted declarations, so no Worker runtime types
// leak into browser code.

import { hc } from "hono/client";
import type { api } from "./app";

export type Api = typeof api;
export type ApiClient = ReturnType<typeof hc<Api>>;

export const createApiClient = (...args: Parameters<typeof hc>): ApiClient => hc<Api>(...args);
