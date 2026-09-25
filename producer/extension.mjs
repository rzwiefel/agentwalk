import { joinSession } from "@github/copilot-sdk/extension";
import { ActivityTransport } from "./src/transport.mjs";
import { approveExtensionPermission, attachToSession, createHooks } from "./src/sdk-adapter.mjs";
import { reportCapabilities } from "./src/capabilities.mjs";

function environmentOptions() {
  return {
    context: {
      client: "copilot-cli",
      version: process.env.COPILOT_VERSION,
      sessionId: process.env.SESSION_ID,
      workspaceRoot: process.env.CODEWALK_WORKSPACE_ROOT ?? process.cwd(),
      workingDirectory: process.cwd(),
    },
    options: { workspaceRoot: process.env.CODEWALK_WORKSPACE_ROOT ?? process.cwd() },
  };
}

export async function activate(runtime, options = {}) {
  const transport = options.transport ?? new ActivityTransport(options);
  const emit = event => transport.enqueue(event);
  const hooks = createHooks({ emit, context: options.context, options });
  const session = await attachToSession(runtime, { context: options.context, options, onEvent: emit });
  return {
    hooks,
    session,
    capabilities: reportCapabilities({
      runtime,
      client: options.context?.client ?? "copilot-cli",
      cliVersion: options.context?.version,
    }),
  };
}

/**
 * The CLI imports extension.mjs for side effects. Joining here is intentional:
 * a direct-only activate export would never observe the foreground session.
 */
export async function bootstrap() {
  const { context, options } = environmentOptions();
  const transport = new ActivityTransport(options);
  const emit = event => transport.enqueue(event);
  const hooks = createHooks({ emit, context, options });
  const session = await joinSession({ hooks, onPermissionRequest: approveExtensionPermission });
  const attached = await attachToSession(session, { context, options, onEvent: emit });
  const flush = () => transport.flush().catch(() => false);
  await flush();
  const worker = setInterval(flush, Number(process.env.CODEWALK_FLUSH_INTERVAL_MS) || 1000);
  worker.unref?.();
  return {
    session: attached,
    hooks,
    capabilities: reportCapabilities({ runtime: { session }, client: "copilot-cli", cliVersion: context.version }),
  };
}

export const activation = bootstrap().catch((error) => {
  const classification = error && typeof error === "object" && typeof error.name === "string" ? error.name : "unknown";
  const message = error && typeof error === "object" && typeof error.message === "string"
    ? error.message.replace(/[\r\n]+/g, " ").slice(0, 160)
    : "no-message";
  process.stderr.write(`[codewalk-extension] bootstrap failed: ${classification}: ${message}\n`);
  return { attached: false, reason: "join-session-failed" };
});
