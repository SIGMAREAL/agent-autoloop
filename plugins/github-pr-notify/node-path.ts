import { realpathSync } from "node:fs";

const resolve = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

// Keep the upstream Homebrew upgrade contract local: an installed plugin cannot import engine files.
export function nodePath(executable: string, prefixes = ["/opt/homebrew", "/usr/local"]) {
  const roots = prefixes.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const match = new RegExp(`^(${roots})/Cellar/([^/]+)/[^/]+/bin/([^/]+)$`).exec(executable);
  if (!match) return executable;
  const opt = `${match[1]}/opt/${match[2]}/bin/${match[3]}`;
  const linked = resolve(opt),
    current = resolve(executable);
  return linked && (!current || linked === current) ? opt : executable;
}
