const fs = require("node:fs/promises");
const path = require("node:path");

/**
 * A pilot share is an empty directory, never an existing user collection.
 * Refuse links at every path component (not only at the last component) so
 * that a junction/symlink cannot redirect enrollment into a Vault.
 *
 * A successful return never implies that the folder was shared. The caller
 * must separately confirm and submit the Syncthing configuration operation.
 */
async function prepareEmptyPilotFolder(folderPath) {
  if (typeof folderPath !== "string" || !path.isAbsolute(folderPath)) {
    throw new Error("Pilot directory must be an absolute path");
  }
  const target = path.resolve(folderPath);
  const root = path.parse(target).root;
  if (root === target) {
    throw new Error("Filesystem roots cannot be used as a pilot folder");
  }

  let current = root;
  let created = false;
  const components = path.relative(root, target).split(path.sep).filter(Boolean);
  for (const component of components) {
    current = path.join(current, component);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error("リンクや通常ファイルを経由する検証フォルダは許可しません");
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      // No recursive mkdir: each newly encountered component is created
      // only after its parent passed a no-follow metadata check.
      await fs.mkdir(current, { mode: 0o700 });
      created = true;
    }
  }

  await assertEmptyPilotFolder(target);
  return created;
}

async function assertEmptyPilotFolder(folderPath) {
  if (typeof folderPath !== "string" || !path.isAbsolute(folderPath)) {
    throw new Error("Pilot directory must be an absolute path");
  }
  const stat = await fs.lstat(folderPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Pilot directory is not an ordinary directory");
  }
  if ((await fs.readdir(folderPath)).length !== 0) {
    throw new Error("空でない検証フォルダの自動共有は許可しません");
  }
}

module.exports = { prepareEmptyPilotFolder, assertEmptyPilotFolder };
