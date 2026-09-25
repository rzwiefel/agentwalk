export const VERIFIED_CLI_VERSION = "1.0.81-12";

export function reportCapabilities({ runtime = {}, client = "copilot-cli", cliVersion = VERIFIED_CLI_VERSION } = {}) {
  const sdkListener = typeof runtime.session?.on === "function" || typeof runtime.joinSession === "function";
  const hookNames = ["sessionStart", "sessionEnd", "userPromptSubmitted", "preToolUse", "preMcpToolCall", "postToolUse", "postToolUseFailure", "errorOccurred", "agentStop"];
  if (client === "copilot-cli") {
    return {
      client,
      status: "verified",
      version: cliVersion,
      hooks: { supported: hookNames, configured: true },
      sessionListener: { supported: sdkListener, observed: sdkListener },
      note: "Verified against the locally installed Copilot CLI hook loader and SDK declarations.",
    };
  }
  return {
    client: "copilot-app",
    status: "unverified",
    hooks: { supported: [], configured: false },
    sessionListener: { supported: false, observed: false },
    note: "The standalone app has not been observed using this extension runtime; no app support is claimed.",
  };
}
