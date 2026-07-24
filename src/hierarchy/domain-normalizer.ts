import { isIP } from "node:net";
import { ApplicationError } from "../errors/application-error.js";

const MAX_DOMAIN_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const ASCII_PRINTABLE = /^[\x20-\x7e]+$/;
const INTERNAL_SUFFIXES = [
  "localhost",
  "local",
  "internal",
  "intranet",
  "lan",
  "home",
  "corp",
  "private",
  "test",
  "invalid",
  "onion"
] as const;
const INSTRUCTION_PATTERNS = [
  /\b(?:ignore|disregard|forget|override)\b.*\b(?:instruction|prompt|rule)s?\b/,
  /\b(?:system|developer)\s+(?:prompt|message|instruction)s?\b/,
  /\b(?:act|behave|respond)\s+as\b/,
  /\bdo\s+not\s+follow\b/,
  /\b(?:jailbreak|prompt\s+injection)\b/
] as const;

export function normalizeDomain(input: string) {
  const raw = input.trim();
  if (
    raw.length === 0 ||
    !ASCII_PRINTABLE.test(raw) ||
    /\s/.test(raw)
  ) {
    throw invalidDomain();
  }

  const decoded = safelyDecode(raw);
  rejectHostileText(raw, decoded);

  let parsed: URL;
  try {
    parsed = new URL(hasScheme(raw) ? raw : `http://${raw}`);
  } catch {
    throw invalidDomain();
  }

  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw invalidDomain();
  }

  let hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (hostname.startsWith("www.")) {
    hostname = hostname.slice(4);
  }

  const unbracketedHostname =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  const labels = hostname.split(".");
  if (
    hostname.length === 0 ||
    hostname.length > MAX_DOMAIN_LENGTH ||
    !ASCII_PRINTABLE.test(hostname) ||
    isIP(unbracketedHostname) !== 0 ||
    labels.length < 2 ||
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > MAX_LABEL_LENGTH ||
        label.startsWith("xn--") ||
        !DOMAIN_LABEL.test(label)
    ) ||
    isInternalHostname(hostname)
  ) {
    throw invalidDomain();
  }

  return hostname;
}

function safelyDecode(value: string) {
  try {
    return decodeURIComponent(value.replace(/\+/g, "%20"));
  } catch {
    throw invalidDomain();
  }
}

function rejectHostileText(raw: string, decoded: string) {
  const inspected = `${raw} ${decoded}`.toLowerCase();
  if (
    /[<>\u0000-\u001f\u007f]/.test(inspected) ||
    /&(?:lt|gt);|<\/?\s*(?:script|iframe|object|embed|style|html)\b/.test(
      inspected
    )
  ) {
    throw invalidDomain();
  }

  const naturalLanguage = inspected.replace(/[^a-z0-9]+/g, " ");
  if (INSTRUCTION_PATTERNS.some((pattern) => pattern.test(naturalLanguage))) {
    throw invalidDomain();
  }
}

function hasScheme(value: string) {
  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}

function isInternalHostname(hostname: string) {
  return INTERNAL_SUFFIXES.some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`)
  );
}

function invalidDomain() {
  return new ApplicationError(
    "VALIDATION_ERROR",
    "Domain must resolve to a safe public ASCII hostname"
  );
}
