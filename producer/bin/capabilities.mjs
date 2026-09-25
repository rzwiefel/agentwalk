#!/usr/bin/env node
import { reportCapabilities } from "../src/capabilities.mjs";

const client = process.argv.includes("--app") ? "copilot-app" : "copilot-cli";
process.stdout.write(`${JSON.stringify(reportCapabilities({ client }), null, 2)}\n`);
