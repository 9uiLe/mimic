import { randomUUID } from "node:crypto";
import { link, open, rm } from "node:fs/promises";
import path from "node:path";

/** Publish a complete metadata file exactly once. A crash before link leaves no final file. */
export async function atomicCreateJson(
  file: string,
  value: unknown,
  failpoint?: (phase: "before-link" | "after-link") => void,
): Promise<boolean> {
  const directory = path.dirname(file);
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${randomUUID()}.pending`,
  );
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    failpoint?.("before-link");
    try {
      await link(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    failpoint?.("after-link");
    const parent = await open(directory, "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    return true;
  } finally {
    await rm(temporary, { force: true });
  }
}
