import fs from "node:fs";
import path from "node:path";
import { UserError, resolveSafe } from "./paths.js";

/** Task templates live here, relative to the project root: `<TASKS_DIR>/<name>.md`. */
export const TASKS_DIR = ".zwilling/tasks";
/** Task names: no path separators, no leading dot. */
export const TASK_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_TEMPLATE_BYTES = 64 * 1024;

/** Names of the task templates in the project, sorted. Empty if there are none. */
export function listTasks(root: string): string[] {
  try {
    return fs
      .readdirSync(path.join(root, TASKS_DIR))
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3))
      .filter((n) => TASK_NAME.test(n))
      .sort();
  } catch {
    return [];
  }
}

/** Read a task template (through the same path checks as attached files). */
export async function loadTask(root: string, name: string, deny: readonly string[] = []): Promise<string> {
  if (!TASK_NAME.test(name)) throw new UserError(`Invalid task name: ${name}`);
  const available = () => {
    const list = listTasks(root);
    return list.length ? `Available tasks: ${list.join(", ")}.` : `No tasks found; add templates as ${TASKS_DIR}/<name>.md.`;
  };
  let abs: string;
  try {
    ({ abs } = await resolveSafe(root, `${TASKS_DIR}/${name}.md`, deny));
  } catch (err) {
    if (err instanceof UserError && /^File not found/.test(err.message)) {
      throw new UserError(`Unknown task "${name}". ${available()}`);
    }
    throw err;
  }
  const st = await fs.promises.stat(abs);
  if (!st.isFile()) throw new UserError(`Unknown task "${name}". ${available()}`);
  if (st.size > MAX_TEMPLATE_BYTES) throw new UserError(`Task template too large: ${name} (max 64 KB).`);
  const text = (await fs.promises.readFile(abs, "utf8")).trim();
  if (!text) throw new UserError(`Task template is empty: ${TASKS_DIR}/${name}.md`);
  return text;
}
