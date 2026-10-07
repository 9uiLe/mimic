import { createServer } from "node:http";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { createServer as createViteServer } from "vite";

const vite = await createViteServer({
  configFile: false,
  appType: "custom",
  server: { middlewareMode: true },
});
let fixture;
let server;
async function close() {
  await new Promise((resolve) => server?.close(() => resolve()));
  await vite.close();
  if (fixture) await rm(fixture.root, { recursive: true, force: true });
}
try {
  const { setupPrototypeJourney } = await vite.ssrLoadModule(
    "/fixtures/prototype-journey/setup.ts",
  );
  const { buildPrototypeJourney } = await vite.ssrLoadModule(
    "/packages/core/src/prototype-journey/index.ts",
  );
  fixture = await setupPrototypeJourney();
  const output = await buildPrototypeJourney(
    fixture.store,
    fixture.journeyPlan,
    fixture.root,
  );
  server = createServer(async (request, response) => {
    const name = request.url === "/" ? "index.html" : request.url?.slice(1);
    if (
      !name ||
      !["index.html", "prototype.css", "prototype.js"].includes(name)
    ) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "content-type": name.endsWith(".css")
        ? "text/css"
        : name.endsWith(".js")
          ? "text/javascript"
          : "text/html",
    });
    response.end(await readFile(path.join(output.directory, name)));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No loopback address");
  process.stdout.write(
    `C-204 synthetic journey: http://127.0.0.1:${address.port}/\nPlan digest: ${output.planDigest}\nBundle: ${output.directory}\nPress Ctrl+C to stop.\n`,
  );
  process.on("SIGINT", () => void close().then(() => process.exit(0)));
  process.on("SIGTERM", () => void close().then(() => process.exit(0)));
} catch (error) {
  await close();
  throw error;
}
