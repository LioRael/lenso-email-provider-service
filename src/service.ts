import {
  defineModule,
  defineService,
  eventHandler,
  runtimeFunction,
  type ProviderV1Options,
} from "@lenso/service-kit";
import dispatchObservedSchema from "../contracts/lenso.email.dispatch-observed.v1.schema.json" with { type: "json" };
import dispatchRequestedSchema from "../contracts/lenso.email.dispatch-requested.v1.schema.json" with { type: "json" };
import receiptObservedSchema from "../contracts/lenso.email.receipt-observed.v1.schema.json" with { type: "json" };

import { canonicalDigest } from "./canonical.js";
import {
  DISPATCH_EVENT,
  DISPATCH_FUNCTION,
  RECEIPT_CHECK_EVENT,
  RECEIPT_CHECK_FUNCTION,
} from "./contracts.js";

export const SERVICE_ID = "lenso/email-provider-service";
export const MODULE_ID = "lenso/email-delivery";
export const EXPORT_KEY = "email-delivery";
export const SERVICE_VERSION = "0.1.0";

const receiptCheckContract = {
  id: RECEIPT_CHECK_EVENT,
  protocol: "lenso.event-contract.v1",
  version: 1,
};
export const contractDigests = {
  dispatch: canonicalDigest(dispatchRequestedSchema),
  dispatchObserved: canonicalDigest(dispatchObservedSchema),
  receiptObserved: canonicalDigest(receiptObservedSchema),
  receiptCheck: canonicalDigest(receiptCheckContract),
};
export const emailContractBundleDigest = canonicalDigest({
  protocol: "lenso.email-contract-bundle.v1",
  schemas: contractDigests,
});

export const providedModule = defineModule({
  capabilities: [],
  eventHandlers: [
    eventHandler("email.dispatch-requested.v1", DISPATCH_EVENT, {
      operation: {
        idempotency: "requires_key",
        operationId: "email.dispatch.enqueue.v1",
        summary: "Enqueue one immutable transactional email dispatch",
      },
    }),
    eventHandler("email.receipt-check-requested.v1", RECEIPT_CHECK_EVENT, {
      operation: {
        idempotency: "requires_key",
        operationId: "email.receipt-check.enqueue.v1",
        summary: "Enqueue a receipt lookup for one email attempt",
      },
    }),
  ],
  name: MODULE_ID,
  runtimeFunctions: [
    runtimeFunction(DISPATCH_FUNCTION, {
      operation: {
        idempotency: "requires_key",
        operationId: DISPATCH_FUNCTION,
        summary: "Dispatch one transactional email attempt",
        timeoutMs: 30_000,
      },
      queue: "email-delivery",
      retryPolicy: { initial_delay_ms: 1_000, max_attempts: 5 },
      version: 1,
    }),
    runtimeFunction(RECEIPT_CHECK_FUNCTION, {
      operation: {
        idempotency: "idempotent",
        operationId: RECEIPT_CHECK_FUNCTION,
        summary: "Read the latest durable remote receipt",
        timeoutMs: 5_000,
      },
      queue: "email-receipts",
      retryPolicy: { initial_delay_ms: 1_000, max_attempts: 3 },
      version: 1,
    }),
  ],
  storyDisplay: [
    {
      display_name: "Send transactional email",
      source: { kind: "execution_name", name: DISPATCH_FUNCTION },
      story_title: "Email dispatch",
    },
    {
      display_name: "Check email receipt",
      source: { kind: "execution_name", name: RECEIPT_CHECK_FUNCTION },
      story_title: "Email receipt check",
    },
  ],
  version: SERVICE_VERSION,
});

export const service = defineService({
  compatibility: {
    required_host_features: ["provider.v1", "provider.host-effects", "service.status"],
  },
  install: {
    services: [
      {
        autoStart: true,
        command: "pnpm start",
        name: "lenso-email-provider-service",
        readyTimeoutMs: 15_000,
        readyUrl: "http://127.0.0.1:4112/lenso/service/v1/status",
      },
    ],
  },
  modules: [providedModule],
  name: "lenso-email-provider-service",
  requiredEnv: ["DATABASE_URL", "EMAIL_TRANSPORT"],
  version: SERVICE_VERSION,
});

export const providerManifest: Record<string, unknown> = JSON.parse(
  JSON.stringify(providedModule),
) as Record<string, unknown>;

export const manifestDigest = canonicalDigest(providerManifest);
export const serviceReleaseDigest = canonicalDigest({
  contracts: contractDigests,
  serviceId: SERVICE_ID,
  version: SERVICE_VERSION,
});

export const moduleRelease = {
  compatibility: {
    host_api_requirement: ">=0.5.0, <1.0.0",
    protocol_digests: [emailContractBundleDigest],
    transports: ["http_json"],
  },
  delivery: {
    contract_digests: [emailContractBundleDigest],
    export: EXPORT_KEY,
    kind: "service",
    responsibility_profile: "provider",
    service_id: SERVICE_ID,
    service_release_digest: serviceReleaseDigest,
    service_release_version: SERVICE_VERSION,
  },
  manifest: providerManifest,
  manifest_digest: manifestDigest,
  module_id: MODULE_ID,
  protocol: "lenso.module-release.v1",
  version: SERVICE_VERSION,
};

export const moduleReleaseDigest = canonicalDigest(moduleRelease);

export const providerV1Base = {
  exports: [
    {
      contractDigests: { email: emailContractBundleDigest },
      exportKey: EXPORT_KEY,
      manifest: providerManifest,
      manifestDigest,
      moduleId: MODULE_ID,
      moduleReleaseDigest,
      moduleVersion: SERVICE_VERSION,
    },
  ],
  features: ["host_effects"],
  moduleReleases: { [EXPORT_KEY]: moduleRelease },
  protocolContractDigest: canonicalDigest({ protocol: "lenso.provider.v1", version: 1 }),
  serviceId: SERVICE_ID,
  serviceReleaseDigest,
  serviceReleaseVersion: SERVICE_VERSION,
} satisfies Omit<ProviderV1Options, "invocationStore" | "runtimeInstanceId">;
