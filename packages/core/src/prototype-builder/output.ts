import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

/** A path or publication conflict in a trusted local output workspace. */
export class PrototypeOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrototypeOutputError";
  }
}
function fail(message: string): never {
  throw new PrototypeOutputError(message);
}
async function assertAvailableOutput(directory: string): Promise<void> {
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      fail("Output path is a symlink or non-directory");
    if ((await readdir(directory)).length)
      fail("Output directory already contains files");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
async function outputTarget(
  root: string,
  relative: string,
): Promise<{ parent: string; directory: string }> {
  if (
    typeof relative !== "string" ||
    !relative ||
    path.isAbsolute(relative) ||
    relative
      .split(/[\\/]/)
      .some((part) => !part || part === "." || part === "..") ||
    relative.includes("\\")
  )
    fail("Output path must be a contained relative directory");
  const base = await realpath(root);
  const segments = relative.split("/");
  let parent = base;
  for (const segment of segments.slice(0, -1)) {
    parent = path.join(parent, segment);
    try {
      const stat = await lstat(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        fail(`Output path contains a symlink or non-directory: ${segment}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(parent);
    }
  }
  const actualParent = await realpath(parent);
  const fromBase = path.relative(base, actualParent);
  if (
    fromBase === ".." ||
    fromBase.startsWith(`..${path.sep}`) ||
    path.isAbsolute(fromBase)
  )
    fail("Output escapes root");
  const directory = path.join(actualParent, segments.at(-1)!);
  await assertAvailableOutput(directory);
  return { parent: actualParent, directory };
}

/** Stage every file, then publish the complete directory with one same-filesystem rename. */
export async function publishPrototypeBundle(
  root: string,
  relative: string,
  files: Readonly<Record<string, string>>,
  write: (file: string, contents: string) => Promise<void> = (file, contents) =>
    writeFile(file, contents, { flag: "wx" }),
): Promise<string> {
  const { parent, directory } = await outputTarget(root, relative);
  const staging = await mkdtemp(path.join(parent, ".mimic-prototype-"));
  let published = false;
  try {
    for (const [name, contents] of Object.entries(files)) {
      if (!/^[a-z][a-z0-9.-]*$/.test(name) || name === "." || name === "..")
        fail(`Unsafe output file name: ${name}`);
      await write(path.join(staging, name), contents);
    }
    await assertAvailableOutput(directory);
    try {
      await rename(staging, directory);
    } catch (error) {
      if (
        ["EEXIST", "ENOTEMPTY"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        fail("Output directory became occupied during publication");
      throw error;
    }
    published = true;
  } finally {
    if (!published) await rm(staging, { recursive: true, force: true });
  }
  return directory;
}
