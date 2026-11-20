/**
 * Minimal glob matching on POSIX-style relative paths, without dependencies.
 * Supports `**` (any number of segments), `*` (within a segment), `?` and `{a,b}`.
 */

const cache = new Map<string, RegExp>();

export function hasGlobChars(s: string): boolean {
  return /[*?{]/.test(s);
}

export function globToRegExp(glob: string): RegExp {
  const cached = cache.get(glob);
  if (cached) return cached;
  let re = "";
  let braceDepth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const atSegStart = i === 0 || glob[i - 1] === "/";
        if (glob[i + 2] === "/" && atSegStart) {
          re += "(?:[^/]*/)*"; // `**/` matches zero or more directories
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      braceDepth++;
      re += "(?:";
    } else if (c === "}" && braceDepth > 0) {
      braceDepth--;
      re += ")";
    } else if (c === "," && braceDepth > 0) {
      re += "|";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  const out = new RegExp(`^${re}$`);
  cache.set(glob, out);
  return out;
}

export function globMatch(glob: string, rel: string): boolean {
  return globToRegExp(glob).test(rel);
}

/**
 * gitignore-like deny check. A pattern without `/` matches any path segment
 * (e.g. `*.sqlite`, `secrets`). A pattern with `/` is anchored at the root; it also
 * blocks everything below a matching directory. A trailing `/` means "this directory".
 */
export function matchesDeny(relPosix: string, pattern: string): boolean {
  let p = pattern.trim().replace(/^\.\//, "");
  if (!p) return false;
  if (p.endsWith("/")) p = p.slice(0, -1);
  const anchored = p.includes("/");
  if (p.startsWith("/")) p = p.slice(1);
  if (!p) return false;
  const parts = relPosix.split("/");
  if (!anchored) {
    const re = globToRegExp(p);
    return parts.some((seg) => re.test(seg));
  }
  const re = globToRegExp(p);
  for (let i = parts.length; i >= 1; i--) {
    if (re.test(parts.slice(0, i).join("/"))) return true;
  }
  return false;
}
