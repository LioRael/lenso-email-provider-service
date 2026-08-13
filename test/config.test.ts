import { describe, expect, test } from "vitest";

import { loadConfig, redactedConfigSummary } from "../src/config.js";

describe("credential references", () => {
  test("requires Provider authentication outside loopback", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: "postgres://localhost/email",
        HOST: "0.0.0.0",
      }),
    ).toThrow("LENSO_PROVIDER_BEARER_TOKEN");

    const config = loadConfig({
      DATABASE_URL: "postgres://localhost/email",
      HOST: "0.0.0.0",
      LENSO_PROVIDER_BEARER_TOKEN: "provider-secret",
    });
    expect(config.bindHost).toBe("0.0.0.0");
    expect(redactedConfigSummary(config)).toMatchObject({
      providerAuth: "configured",
    });
    expect(JSON.stringify(redactedConfigSummary(config))).not.toContain(
      "provider-secret",
    );
  });

  test("resolves SMTP credentials indirectly and never returns their values in summaries", () => {
    const config = loadConfig({
      DATABASE_URL: "postgres://localhost/email",
      EMAIL_FROM_ADDRESS: "notifications@example.test",
      EMAIL_SMTP_HOST: "smtp.example.test",
      EMAIL_SMTP_PASSWORD: "super-secret-password",
      EMAIL_SMTP_PASSWORD_ENV: "EMAIL_SMTP_PASSWORD",
      EMAIL_SMTP_USERNAME: "service-user",
      EMAIL_SMTP_USERNAME_ENV: "EMAIL_SMTP_USERNAME",
      EMAIL_TRANSPORT: "smtp",
    });
    expect(config.smtp).toMatchObject({ password: "super-secret-password", passwordReference: "EMAIL_SMTP_PASSWORD" });
    expect(JSON.stringify(redactedConfigSummary(config))).not.toContain("super-secret-password");
    expect(JSON.stringify(redactedConfigSummary(config))).not.toContain("service-user");
  });

  test("fails before startup when a credential reference is missing", () => {
    expect(() => loadConfig({ DATABASE_URL: "postgres://localhost/email", EMAIL_TRANSPORT: "smtp" })).toThrow("EMAIL_SMTP_USERNAME_ENV");
  });
});
