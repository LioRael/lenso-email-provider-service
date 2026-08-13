import { randomUUID } from "node:crypto";

import { serveService } from "@lenso/service-kit";
import pg from "pg";

import { loadConfig, redactedConfigSummary, type ServiceConfig } from "./config.js";
import { DispatchEngine } from "./dispatch.js";
import { createHandlers } from "./handlers.js";
import { migrate } from "./migrate.js";
import {
  MODULE_ID,
  moduleReleaseDigest,
  providerV1Base,
  service,
  serviceReleaseDigest,
} from "./service.js";
import { PostgresEmailLedger, PostgresProviderInvocationStore } from "./store/postgres.js";
import type { EmailTransport } from "./transports/email-transport.js";
import { FakeEmailTransport } from "./transports/fake.js";
import { SmtpEmailTransport } from "./transports/smtp.js";

const { Pool } = pg;

const transportFor = (config: ServiceConfig): EmailTransport => {
  if (config.transport === "fake") return new FakeEmailTransport([config.fakeMode]);
  if (!config.smtp) throw new Error("SMTP configuration is required");
  return new SmtpEmailTransport(config.smtp);
};

export const startService = async (config = loadConfig(), suppliedTransport?: EmailTransport) => {
  if (config.autoMigrate) await migrate(config.databaseUrl);
  const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
  const transport = suppliedTransport ?? transportFor(config);
  try {
    await pool.query("SELECT 1");
    await transport.ready();
    const ledger = new PostgresEmailLedger(pool);
    const invocationStore = new PostgresProviderInvocationStore(pool);
    const engine = new DispatchEngine({
      leaseMs: config.dispatchLeaseMs,
      ledger,
      providerName: config.providerName,
      transport,
    });
    const handlers = createHandlers(engine, ledger);
    const served = await serveService(service, {
      host: config.bindHost,
      modules: { [MODULE_ID]: handlers },
      onReady: () => {
        process.stdout.write(`${JSON.stringify({
          config: redactedConfigSummary(config),
          event: "email_provider_ready",
          moduleReleaseDigest,
        })}\n`);
      },
      port: config.port,
      ...(config.localEnrollmentToken
        ? {
            providerCore: {
              bearerToken: config.localEnrollmentToken,
              serviceId: providerV1Base.serviceId,
              servicePrincipal: `service:${providerV1Base.serviceId}`,
              serviceRevision: serviceReleaseDigest,
            },
          }
        : {}),
      providerV1: {
        ...providerV1Base,
        ...(config.providerBearerToken
          ? { bearerToken: config.providerBearerToken }
          : {}),
        invocationStore,
        runtimeInstanceId: process.env.LENSO_RUNTIME_INSTANCE_ID ?? `email-provider-${randomUUID()}`,
      },
      status: {
        checks: async () => {
          try {
            await pool.query("SELECT 1");
            return [
              { detail: "Postgres durable ledgers are reachable", name: "database", status: "ok" as const },
              { detail: `${transport.name} transport is configured`, name: "transport", status: "ok" as const },
            ];
          } catch {
            return [{ detail: "Postgres durable ledgers are unavailable", name: "database", status: "error" as const }];
          }
        },
      },
    });
    return {
      ...served,
      close: async () => {
        try {
          await served.close();
        } finally {
          try {
            await transport.close();
          } finally {
            await pool.end();
          }
        }
      },
      ledger,
      transport,
    };
  } catch (error) {
    await pool.end();
    throw error;
  }
};

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const served = await startService();
  process.stdout.write(`Lenso Email Provider ready: ${served.manifestUrl}\n`);
}
