import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const notificationRoot = process.env.NOTIFICATION_MODULE_ROOT;
if (!notificationRoot) {
  throw new Error("NOTIFICATION_MODULE_ROOT must point to the Notification Module checkout");
}

const emailRoot = resolve(import.meta.dirname, "..");
const names = [
  "lenso.email.dispatch-requested.v1.schema.json",
  "lenso.email.dispatch-observed.v1.schema.json",
  "lenso.email.receipt-observed.v1.schema.json",
];
for (const name of names) {
  const [provided, owned] = await Promise.all([
    readFile(resolve(emailRoot, "contracts", name)),
    readFile(resolve(notificationRoot, "contracts/events", name)),
  ]);
  if (!provided.equals(owned)) {
    throw new Error(`Email Provider and Notification contract byte drift: ${name}`);
  }
}

console.log(`Verified ${names.length} Email Provider to Notification contracts`);
