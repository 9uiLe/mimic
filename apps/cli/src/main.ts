#!/usr/bin/env node
import { getStatus } from "@mimic/core";

if (process.argv.length > 2) {
  console.error("Usage: mimic");
  process.exitCode = 2;
} else {
  console.log(JSON.stringify(getStatus()));
}
