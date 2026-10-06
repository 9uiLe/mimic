#!/usr/bin/env node
import { dispatchCli } from "./entry.js";

process.exitCode = await dispatchCli(process.argv.slice(2));
