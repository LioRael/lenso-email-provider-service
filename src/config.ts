export type TransportKind = "fake" | "smtp";

export interface ServiceConfig {
  bindHost: string;
  port: number;
  databaseUrl: string;
  autoMigrate: boolean;
  dispatchLeaseMs: number;
  providerName: string;
  transport: TransportKind;
  fakeMode: "accepted" | "delivered" | "temporary_failure" | "permanent_failure" | "delivery_unknown";
  smtp?: {
    connectionTimeoutMs: number;
    host: string;
    port: number;
    secure: boolean;
    username: string;
    password: string;
    usernameReference: string;
    passwordReference: string;
    fromAddress: string;
    fromName: string;
    greetingTimeoutMs: number;
    maxConnections: number;
    maxMessages: number;
    rateLimitPerSecond: number;
    socketTimeoutMs: number;
  };
  localEnrollmentToken?: string;
  providerBearerToken?: string;
}

const envReference = /^[A-Z_][A-Z0-9_]*$/u;

const integer = (value: string | undefined, fallback: number, name: string, min: number, max: number) => {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return parsed;
};

const required = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name];
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
};

const secretFromReference = (env: NodeJS.ProcessEnv, referenceName: string): { value: string; reference: string } => {
  const reference = required(env, referenceName);
  if (!envReference.test(reference)) throw new Error(`${referenceName} must name an environment variable`);
  const value = env[reference];
  if (!value) throw new Error(`credential referenced by ${referenceName} is unavailable`);
  return { reference, value };
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): ServiceConfig => {
  const transport = (env.EMAIL_TRANSPORT ?? "fake") as TransportKind;
  if (transport !== "fake" && transport !== "smtp") {
    throw new Error("EMAIL_TRANSPORT must be fake or smtp");
  }
  const fakeMode = (env.EMAIL_FAKE_MODE ?? "delivered") as ServiceConfig["fakeMode"];
  if (!["accepted", "delivered", "temporary_failure", "permanent_failure", "delivery_unknown"].includes(fakeMode)) {
    throw new Error("EMAIL_FAKE_MODE is invalid");
  }
  const base: ServiceConfig = {
    autoMigrate: env.DATABASE_AUTO_MIGRATE === "true",
    bindHost: env.HOST?.trim() || "127.0.0.1",
    databaseUrl: required(env, "DATABASE_URL"),
    dispatchLeaseMs: integer(env.EMAIL_DISPATCH_LEASE_MS, 30_000, "EMAIL_DISPATCH_LEASE_MS", 1_000, 300_000),
    fakeMode,
    port: integer(env.PORT, 4_112, "PORT", 1, 65_535),
    providerName: env.EMAIL_PROVIDER_NAME?.trim() || "lenso-email",
    transport,
    ...(env.LENSO_LOCAL_ENROLLMENT_TOKEN ? { localEnrollmentToken: env.LENSO_LOCAL_ENROLLMENT_TOKEN } : {}),
    ...(env.LENSO_PROVIDER_BEARER_TOKEN ? { providerBearerToken: env.LENSO_PROVIDER_BEARER_TOKEN } : {}),
  };
  if (
    base.bindHost !== "127.0.0.1" &&
    base.bindHost !== "localhost" &&
    !base.providerBearerToken
  ) {
    throw new Error("LENSO_PROVIDER_BEARER_TOKEN is required outside loopback");
  }
  if (
    base.localEnrollmentToken &&
    base.bindHost !== "127.0.0.1" &&
    base.bindHost !== "localhost"
  ) {
    throw new Error("LENSO_LOCAL_ENROLLMENT_TOKEN is only supported on loopback");
  }
  if (transport === "smtp") {
    const username = secretFromReference(env, "EMAIL_SMTP_USERNAME_ENV");
    const password = secretFromReference(env, "EMAIL_SMTP_PASSWORD_ENV");
    base.smtp = {
      connectionTimeoutMs: integer(env.EMAIL_SMTP_CONNECTION_TIMEOUT_MS, 5_000, "EMAIL_SMTP_CONNECTION_TIMEOUT_MS", 1_000, 15_000),
      fromAddress: required(env, "EMAIL_FROM_ADDRESS"),
      fromName: env.EMAIL_FROM_NAME?.trim() || "Lenso",
      greetingTimeoutMs: integer(env.EMAIL_SMTP_GREETING_TIMEOUT_MS, 5_000, "EMAIL_SMTP_GREETING_TIMEOUT_MS", 1_000, 15_000),
      host: required(env, "EMAIL_SMTP_HOST"),
      maxConnections: integer(env.EMAIL_SMTP_MAX_CONNECTIONS, 5, "EMAIL_SMTP_MAX_CONNECTIONS", 1, 100),
      maxMessages: integer(env.EMAIL_SMTP_MAX_MESSAGES, 100, "EMAIL_SMTP_MAX_MESSAGES", 1, 10_000),
      password: password.value,
      passwordReference: password.reference,
      port: integer(env.EMAIL_SMTP_PORT, 587, "EMAIL_SMTP_PORT", 1, 65_535),
      rateLimitPerSecond: integer(env.EMAIL_SMTP_RATE_LIMIT_PER_SECOND, 10, "EMAIL_SMTP_RATE_LIMIT_PER_SECOND", 1, 10_000),
      secure: env.EMAIL_SMTP_SECURE === "true",
      socketTimeoutMs: integer(env.EMAIL_SMTP_SOCKET_TIMEOUT_MS, 15_000, "EMAIL_SMTP_SOCKET_TIMEOUT_MS", 1_000, 25_000),
      username: username.value,
      usernameReference: username.reference,
    };
    if (base.smtp.socketTimeoutMs >= base.dispatchLeaseMs) {
      throw new Error("EMAIL_SMTP_SOCKET_TIMEOUT_MS must be shorter than EMAIL_DISPATCH_LEASE_MS");
    }
  }
  return base;
};

export const redactedConfigSummary = (config: ServiceConfig) => ({
  bindHost: config.bindHost,
  database: "configured",
  providerAuth: config.providerBearerToken ? "configured" : "loopback-only",
  providerName: config.providerName,
  transport: config.transport,
  ...(config.smtp
    ? {
        smtp: {
          host: config.smtp.host,
          connectionTimeoutMs: config.smtp.connectionTimeoutMs,
          greetingTimeoutMs: config.smtp.greetingTimeoutMs,
          maxConnections: config.smtp.maxConnections,
          maxMessages: config.smtp.maxMessages,
          passwordReference: config.smtp.passwordReference,
          port: config.smtp.port,
          rateLimitPerSecond: config.smtp.rateLimitPerSecond,
          secure: config.smtp.secure,
          socketTimeoutMs: config.smtp.socketTimeoutMs,
          usernameReference: config.smtp.usernameReference,
        },
      }
    : {}),
});
