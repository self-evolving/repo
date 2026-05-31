#!/usr/bin/env node

const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");

const VALID_PROVIDERS = new Set(["auto", "codex", "claude"]);
const VALID_ROUTE_KEY = /^[a-z0-9][a-z0-9._-]*$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/;
const VALID_REGISTRY_MODES = new Set(["auto", "bundled", "remote"]);
const BUNDLED_MODEL_DEFAULTS_PATH = path.resolve(__dirname, "../../../.agent/model-defaults.json");
const DEFAULT_MODEL_REGISTRY_URL =
  "https://raw.githubusercontent.com/self-evolving/repo/main/.agent/model-defaults.json";
const DEFAULT_REGISTRY_TIMEOUT_MS = 3000;

function normalizeProvider(value) {
  return String(value || "").trim().toLowerCase();
}

function validateProvider(value) {
  return VALID_PROVIDERS.has(value);
}

function setOutput(name, value) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`, "utf8");
}

function normalizeOptionalToken(value, label) {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized) return "";
  if (!SAFE_TOKEN.test(normalized)) {
    throw new Error(`${label} must be a non-empty token without whitespace or control characters`);
  }
  return normalized;
}

function normalizeOptionalProvider(value, label) {
  const normalized = normalizeProvider(value);
  if (!normalized || !validateProvider(normalized)) {
    throw new Error(`${label} must be auto, codex, or claude`);
  }
  return normalized;
}

function normalizeRegistryMode(value) {
  const normalized = String(value || "auto").trim().toLowerCase() || "auto";
  if (!VALID_REGISTRY_MODES.has(normalized)) {
    throw new Error("AGENT_MODEL_REGISTRY must be auto, bundled, or remote");
  }
  return normalized;
}

function normalizeRegistryUrl(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return DEFAULT_MODEL_REGISTRY_URL;
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("AGENT_MODEL_REGISTRY_URL must be a valid http(s) URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("AGENT_MODEL_REGISTRY_URL must use http or https");
  }
  return parsed.toString();
}

function normalizeRegistryTimeout(value) {
  const raw = String(value || "").trim();
  if (!raw) return DEFAULT_REGISTRY_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 30000) {
    throw new Error("AGENT_MODEL_REGISTRY_TIMEOUT_MS must be 1-30000");
  }
  return parsed;
}

function normalizeConfig(value, label, allowProvider) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }

  const config = {};
  if (allowProvider && Object.prototype.hasOwnProperty.call(value, "provider")) {
    config.provider = normalizeOptionalProvider(value.provider, `${label}.provider`);
  }
  if (Object.prototype.hasOwnProperty.call(value, "model")) {
    config.model = normalizeOptionalToken(value.model, `${label}.model`);
  }
  if (Object.prototype.hasOwnProperty.call(value, "reasoning_effort")) {
    const reasoningEffort = normalizeOptionalToken(
      value.reasoning_effort,
      `${label}.reasoning_effort`,
    );
    if (reasoningEffort) config.reasoningEffort = reasoningEffort;
  }
  return config;
}

function normalizeModelDefault(value, label) {
  const normalized = normalizeConfig(value, label, false);
  if (!normalized.model) {
    throw new Error(`${label}.model must be a non-empty string`);
  }
  return normalized;
}

function validateStringMetadata(value, label) {
  if (value === undefined || value === null) return;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function parseModelDefaultsRegistry(payload, label) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`${label} must be a JSON object`);
  }

  const allowedTopLevel = new Set(["version", "source_url", "verified_at", "providers"]);
  for (const key of Object.keys(payload)) {
    if (!allowedTopLevel.has(key)) {
      throw new Error(`${label}.${key} is not supported`);
    }
  }

  if (payload.version !== 1) {
    throw new Error(`${label}.version must be 1`);
  }
  validateStringMetadata(payload.source_url, `${label}.source_url`);
  validateStringMetadata(payload.verified_at, `${label}.verified_at`);

  if (!payload.providers || typeof payload.providers !== "object" || Array.isArray(payload.providers)) {
    throw new Error(`${label}.providers must be an object`);
  }

  const defaults = {};
  for (const [provider, config] of Object.entries(payload.providers)) {
    const normalizedProvider = normalizeProvider(provider);
    if (normalizedProvider !== "codex" && normalizedProvider !== "claude") {
      throw new Error(`${label}.providers contains unsupported provider: ${normalizedProvider || "missing"}`);
    }
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new Error(`${label}.providers.${normalizedProvider} must be an object`);
    }
    const allowedProviderKeys = new Set([
      "default",
      "cheap",
      "strong",
      "min_cli_version",
      "source_url",
      "verified_at",
    ]);
    for (const key of Object.keys(config)) {
      if (!allowedProviderKeys.has(key)) {
        throw new Error(`${label}.providers.${normalizedProvider}.${key} is not supported`);
      }
    }
    for (const slot of ["cheap", "strong"]) {
      if (Object.prototype.hasOwnProperty.call(config, slot)) {
        normalizeModelDefault(config[slot], `${label}.providers.${normalizedProvider}.${slot}`);
      }
    }
    validateStringMetadata(config.min_cli_version, `${label}.providers.${normalizedProvider}.min_cli_version`);
    validateStringMetadata(config.source_url, `${label}.providers.${normalizedProvider}.source_url`);
    validateStringMetadata(config.verified_at, `${label}.providers.${normalizedProvider}.verified_at`);
    defaults[normalizedProvider] = normalizeModelDefault(
      config.default,
      `${label}.providers.${normalizedProvider}.default`,
    );
  }

  return defaults;
}

function loadBundledModelDefaults() {
  const payload = JSON.parse(fs.readFileSync(BUNDLED_MODEL_DEFAULTS_PATH, "utf8"));
  return parseModelDefaultsRegistry(payload, "bundled model defaults");
}

function sourceMapFor(defaults, source) {
  return Object.fromEntries(Object.keys(defaults).map((provider) => [provider, source]));
}

function fetchJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? https : http;
    const request = client.get(parsed, { timeout: timeoutMs }, (response) => {
      const statusCode = response.statusCode || 0;
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        if (statusCode < 200 || statusCode >= 300) {
          reject(new Error(`HTTP ${statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    request.on("timeout", () => {
      request.destroy(new Error(`timed out after ${timeoutMs}ms`));
    });
    request.on("error", reject);
  });
}

async function resolveModelDefaults(env) {
  const bundledDefaults = loadBundledModelDefaults();
  const bundledSources = sourceMapFor(bundledDefaults, "bundled");
  const mode = normalizeRegistryMode(env.MODEL_REGISTRY || "auto");
  if (mode === "bundled") {
    return { defaults: bundledDefaults, sources: bundledSources };
  }

  const registryUrl = normalizeRegistryUrl(env.MODEL_REGISTRY_URL || "");
  const timeoutMs = normalizeRegistryTimeout(env.MODEL_REGISTRY_TIMEOUT_MS || "");
  try {
    const payload = await fetchJson(registryUrl, timeoutMs);
    const remoteDefaults = parseModelDefaultsRegistry(payload, "remote model registry");
    return {
      defaults: { ...bundledDefaults, ...remoteDefaults },
      sources: { ...bundledSources, ...sourceMapFor(remoteDefaults, "remote") },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (mode === "remote") {
      throw new Error(`Could not load remote model registry from ${registryUrl}: ${message}`);
    }
    console.error(
      `Could not load remote model registry from ${registryUrl}; falling back to bundled defaults: ${message}`,
    );
    return { defaults: bundledDefaults, sources: bundledSources };
  }
}

function parsePolicy(raw) {
  const text = String(raw || "").trim();
  const empty = {
    defaultConfig: {},
    providers: {},
    routeOverrides: {},
  };
  if (!text) return empty;

  const payload = JSON.parse(text);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("AGENT_MODEL_POLICY must be a JSON object");
  }

  const policy = { ...empty };
  if (Object.prototype.hasOwnProperty.call(payload, "default")) {
    if (
      payload.default &&
      typeof payload.default === "object" &&
      !Array.isArray(payload.default) &&
      Object.prototype.hasOwnProperty.call(payload.default, "provider")
    ) {
      throw new Error("default.provider is not supported; use AGENT_DEFAULT_PROVIDER");
    }
    policy.defaultConfig = normalizeConfig(payload.default, "default", false);
  }
  if (Object.prototype.hasOwnProperty.call(payload, "providers")) {
    const providers = payload.providers;
    if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
      throw new Error("providers must be an object");
    }
    for (const [provider, config] of Object.entries(providers)) {
      const normalizedProvider = normalizeProvider(provider);
      if (normalizedProvider !== "codex" && normalizedProvider !== "claude") {
        throw new Error(`Invalid provider key in model policy: ${normalizedProvider || "missing"}`);
      }
      policy.providers[normalizedProvider] = normalizeConfig(
        config,
        `providers.${normalizedProvider}`,
        false,
      );
    }
  }
  if (Object.prototype.hasOwnProperty.call(payload, "route_overrides")) {
    const routeOverrides = payload.route_overrides;
    if (!routeOverrides || typeof routeOverrides !== "object" || Array.isArray(routeOverrides)) {
      throw new Error("route_overrides must be an object");
    }
    for (const [route, config] of Object.entries(routeOverrides)) {
      const normalizedRoute = String(route || "").trim().toLowerCase();
      if (!VALID_ROUTE_KEY.test(normalizedRoute)) {
        throw new Error(`Invalid route override key in model policy: ${normalizedRoute || "missing"}`);
      }
      policy.routeOverrides[normalizedRoute] = normalizeConfig(
        config,
        `route_overrides.${normalizedRoute}`,
        true,
      );
    }
  }
  return policy;
}

function applyRunConfig(target, config, source) {
  if (Object.prototype.hasOwnProperty.call(config, "model")) {
    target.model = config.model || "";
    target.modelSource = config.model ? source : "";
  }
  if (config.reasoningEffort) {
    target.reasoningEffort = config.reasoningEffort;
  }
}

function resolveProviderRequest(env, policy, route) {
  const routeProvider = normalizeProvider(env.ROUTE_PROVIDER || "");
  const defaultProvider = normalizeProvider(env.DEFAULT_PROVIDER || "auto") || "auto";

  for (const candidate of [routeProvider, defaultProvider]) {
    if (candidate && !validateProvider(candidate)) {
      throw new Error(`Invalid agent provider '${candidate}' for route '${route}'. Use auto, codex, or claude.`);
    }
  }

  let requestedProvider = defaultProvider;
  let requestedReason = "AGENT_DEFAULT_PROVIDER";

  const routeConfig = policy.routeOverrides[route];
  if (routeConfig?.provider) {
    requestedProvider = routeConfig.provider;
    requestedReason = `AGENT_MODEL_POLICY route override for ${route}`;
  }

  if (routeProvider) {
    requestedProvider = routeProvider;
    requestedReason = `route override for ${route}`;
  }

  return { requestedProvider, requestedReason, hasRouteProviderOverride: Boolean(routeProvider) };
}

function resolveRunConfig(policy, modelDefaults, modelDefaultsSource, provider, route, options = {}) {
  const config = { model: "", modelSource: "", reasoningEffort: "" };
  applyRunConfig(config, modelDefaults[provider] || {}, modelDefaultsSource);
  applyRunConfig(config, policy.defaultConfig, "policy");
  applyRunConfig(config, policy.providers[provider] || {}, "policy");
  if (!options.hasRouteProviderOverride) {
    applyRunConfig(config, policy.routeOverrides[route] || {}, "policy");
  }
  return config;
}

function writeOutputs({ provider, reason, model, modelSource, reasoningEffort }) {
  setOutput("provider", provider);
  setOutput("reason", reason);
  setOutput("install_codex", provider === "codex" ? "true" : "false");
  setOutput("install_claude", provider === "claude" ? "true" : "false");
  setOutput("model", model);
  setOutput("model_source", modelSource);
  setOutput("reasoning_effort", reasoningEffort);
}

async function main(env) {
  const route = String(env.ROUTE || "").trim().toLowerCase();
  const required = normalizeProvider(env.REQUIRED || "true");
  if (required !== "true" && required !== "false") {
    throw new Error(`Invalid required flag '${required}' for route '${route}'. Use true or false.`);
  }

  const policy = parsePolicy(env.AGENT_MODEL_POLICY || "");
  const modelDefaults = await resolveModelDefaults(env);
  const { requestedProvider, requestedReason, hasRouteProviderOverride } = resolveProviderRequest(env, policy, route);

  const hasCodex = Boolean(env.OPENAI_API_KEY);
  const hasClaudeOauth = Boolean(env.CLAUDE_CODE_OAUTH_TOKEN);
  const hasAnthropic = Boolean(env.ANTHROPIC_API_KEY);
  const hasClaude = hasClaudeOauth || hasAnthropic;
  const claudeReason = hasClaudeOauth
    ? "CLAUDE_CODE_OAUTH_TOKEN is configured"
    : hasAnthropic
      ? "ANTHROPIC_API_KEY is configured"
      : "";
  const explicitProvider = requestedProvider !== "auto";

  let provider = "";
  let reason = "";
  if (explicitProvider) {
    provider = requestedProvider;
    reason = requestedReason;
  } else if (hasCodex) {
    provider = "codex";
    reason = "OPENAI_API_KEY is configured";
  } else if (hasClaude) {
    provider = "claude";
    reason = claudeReason;
  } else {
    console.error(
      `No configured agent provider for route '${route}'. Set AGENT_DEFAULT_PROVIDER to codex or claude, or configure OPENAI_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, or ANTHROPIC_API_KEY.`,
    );
    if (required === "true") {
      return 1;
    }
    writeOutputs({ provider: "", reason: "no configured provider", model: "", modelSource: "", reasoningEffort: "" });
    console.log(`Agent provider for ${route} is unresolved (no configured provider).`);
    return 0;
  }

  if (explicitProvider && provider === "codex" && !hasCodex) {
    console.error(
      `Resolved provider codex for route '${route}' without OPENAI_API_KEY; relying on local Codex authentication if available.`,
    );
  }
  if (explicitProvider && provider === "claude" && !hasClaude) {
    console.error(
      `Resolved provider claude for route '${route}' without CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY; relying on local Claude authentication if available.`,
    );
  }

  const runConfig = resolveRunConfig(policy, modelDefaults.defaults, modelDefaults.sources[provider] || "", provider, route, {
    hasRouteProviderOverride,
  });
  writeOutputs({
    provider,
    reason,
    model: runConfig.model,
    modelSource: runConfig.modelSource,
    reasoningEffort: runConfig.reasoningEffort,
  });
  console.log(`Resolved agent provider for ${route}: ${provider} (${reason}).`);
  if (runConfig.model) {
    console.log(`Resolved agent model for ${route}: ${runConfig.model} (${runConfig.modelSource}).`);
  }
  return 0;
}

try {
  main(process.env).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    },
  );
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
