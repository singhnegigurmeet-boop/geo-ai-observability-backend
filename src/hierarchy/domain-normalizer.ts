import { domainToASCII } from "node:url";
import { ApplicationError } from "../errors/application-error.js";

const MAX_DOMAIN_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export function normalizeDomain(input: string) {
  const trimmed = input.trim().replace(/\.$/, "");
  if (
    trimmed.length === 0 ||
    /[\s/:@?#\\]/.test(trimmed)
  ) {
    throw invalidDomain();
  }

  const normalized = domainToASCII(trimmed).toLowerCase();
  const labels = normalized.split(".");
  if (
    normalized.length === 0 ||
    normalized.length > MAX_DOMAIN_LENGTH ||
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > MAX_LABEL_LENGTH ||
        !DOMAIN_LABEL.test(label)
    )
  ) {
    throw invalidDomain();
  }

  return normalized;
}

function invalidDomain() {
  return new ApplicationError(
    "VALIDATION_ERROR",
    "Domain must be a valid hostname-like domain"
  );
}
