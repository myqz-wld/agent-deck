export type CodexAgentTomlValue =
  | string
  | number
  | boolean
  | CodexAgentTomlValue[]
  | { [key: string]: CodexAgentTomlValue | undefined };

export type CodexAgentTomlObject = { [key: string]: CodexAgentTomlValue | undefined };

export interface ParsedCodexAgentToml {
  name?: string;
  description?: string;
  developerInstructions?: string;
  nicknameCandidates?: string[];
  model?: string;
  modelReasoningEffort?: string;
  sandboxMode?: string;
  config: CodexAgentTomlObject;
}

const AGENT_MANIFEST_KEYS = new Set([
  'name',
  'description',
  'developer_instructions',
  'nickname_candidates',
]);

const THREAD_MAPPED_KEYS = new Set(['model', 'model_reasoning_effort', 'sandbox_mode']);

export function parseCodexAgentToml(content: string): ParsedCodexAgentToml {
  const root = parseTomlObject(content);
  const name = readString(root.name);
  const description = readString(root.description);
  const developerInstructions = readString(root.developer_instructions);
  const nicknameCandidates = readStringArray(root.nickname_candidates);
  const model = readString(root.model);
  const modelReasoningEffort = readString(root.model_reasoning_effort);
  const sandboxMode = readString(root.sandbox_mode);
  return {
    name,
    description,
    developerInstructions,
    nicknameCandidates,
    model,
    modelReasoningEffort,
    sandboxMode,
    config: stripAgentManifestKeys(root),
  };
}

export interface CodexAgentTomlInput {
  name: string;
  description: string;
  developerInstructions: string;
  model?: string;
  modelReasoningEffort?: string;
  sandboxMode?: string;
}

export function stringifyCodexAgentToml(input: CodexAgentTomlInput): string {
  const lines = [
    `name = ${quoteTomlString(input.name)}`,
    `description = ${quoteTomlString(input.description)}`,
  ];
  const model = input.model?.trim();
  if (model) lines.push(`model = ${quoteTomlString(model)}`);
  const effort = input.modelReasoningEffort?.trim();
  if (effort) lines.push(`model_reasoning_effort = ${quoteTomlString(effort)}`);
  const sandboxMode = input.sandboxMode?.trim();
  if (sandboxMode) lines.push(`sandbox_mode = ${quoteTomlString(sandboxMode)}`);
  lines.push('', `developer_instructions = ${quoteTomlMultiline(input.developerInstructions)}`);
  return `${lines.join('\n')}\n`;
}

function parseTomlObject(content: string): CodexAgentTomlObject {
  const root: CodexAgentTomlObject = {};
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  let currentPath: string[] = [];
  let currentArrayItem: CodexAgentTomlObject | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;

    const arrayTable = line.match(/^\s*\[\[([^\]]+)]]\s*$/);
    if (arrayTable) {
      currentPath = splitKeyPath(arrayTable[1]);
      currentArrayItem = appendArrayTable(root, currentPath);
      continue;
    }

    const table = line.match(/^\s*\[([^\]]+)]\s*$/);
    if (table) {
      currentPath = splitKeyPath(table[1]);
      ensureObjectPath(root, currentPath);
      currentArrayItem = null;
      continue;
    }

    const eq = findAssignmentEquals(line);
    if (eq < 0) continue;
    const keyPath = splitKeyPath(line.slice(0, eq).trim());
    const valueStart = line.slice(eq + 1).trimStart();
    const parsed = parseTomlValueWithMultiline(valueStart, lines, i);
    i = parsed.nextLineIndex;
    const target = currentArrayItem ?? ensureObjectPath(root, currentPath);
    setObjectPath(target, keyPath, parsed.value);
  }

  return root;
}

function parseTomlValueWithMultiline(
  initial: string,
  lines: string[],
  currentLineIndex: number,
): { value: CodexAgentTomlValue; nextLineIndex: number } {
  if (initial.startsWith('"""') || initial.startsWith("'''")) {
    const delimiter = initial.slice(0, 3);
    const rest = initial.slice(3);
    const inlineEnd = rest.indexOf(delimiter);
    if (inlineEnd >= 0) {
      return {
        value: rest.slice(0, inlineEnd),
        nextLineIndex: currentLineIndex,
      };
    }
    const chunks: string[] = rest.length > 0 ? [rest] : [];
    for (let i = currentLineIndex + 1; i < lines.length; i += 1) {
      const end = lines[i].indexOf(delimiter);
      if (end >= 0) {
        chunks.push(lines[i].slice(0, end));
        return {
          value: chunks.join('\n'),
          nextLineIndex: i,
        };
      }
      chunks.push(lines[i]);
    }
    return { value: chunks.join('\n'), nextLineIndex: lines.length - 1 };
  }
  return { value: parseTomlValue(stripTomlComment(initial).trim()), nextLineIndex: currentLineIndex };
}

function parseTomlValue(raw: string): CodexAgentTomlValue {
  if (raw.startsWith('"') && raw.endsWith('"')) return unquoteBasicString(raw);
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  if (raw.startsWith('[') && raw.endsWith(']')) {
    return splitTomlArray(raw.slice(1, -1)).map(parseTomlValue);
  }
  return raw;
}

function splitTomlArray(raw: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const ch of raw) {
    if (quote) {
      current += ch;
      if (quote === '"' && ch === '\\' && !escaped) {
        escaped = true;
        continue;
      }
      if (ch === quote && !escaped) quote = null;
      escaped = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ',') {
      const item = current.trim();
      if (item) out.push(item);
      current = '';
      continue;
    }
    current += ch;
  }
  const last = current.trim();
  if (last) out.push(last);
  return out;
}

function stripTomlComment(line: string): string {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (quote === '"' && ch === '\\' && !escaped) {
        escaped = true;
        continue;
      }
      if (ch === quote && !escaped) quote = null;
      escaped = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#') return line.slice(0, i);
  }
  return line;
}

function findAssignmentEquals(line: string): number {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (quote === '"' && ch === '\\' && !escaped) {
        escaped = true;
        continue;
      }
      if (ch === quote && !escaped) quote = null;
      escaped = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '=') return i;
  }
  return -1;
}

function splitKeyPath(key: string): string[] {
  return key
    .split('.')
    .map((part) => part.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

function ensureObjectPath(root: CodexAgentTomlObject, path: string[]): CodexAgentTomlObject {
  let current = root;
  for (const part of path) {
    const existing = current[part];
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      current[part] = {};
    }
    current = current[part] as CodexAgentTomlObject;
  }
  return current;
}

function appendArrayTable(root: CodexAgentTomlObject, path: string[]): CodexAgentTomlObject {
  const parent = ensureObjectPath(root, path.slice(0, -1));
  const key = path[path.length - 1];
  if (!key) return parent;
  const existing = parent[key];
  const arr = Array.isArray(existing) ? existing : [];
  const next: CodexAgentTomlObject = {};
  arr.push(next);
  parent[key] = arr;
  return next;
}

function setObjectPath(
  root: CodexAgentTomlObject,
  path: string[],
  value: CodexAgentTomlValue,
): void {
  const parent = ensureObjectPath(root, path.slice(0, -1));
  const key = path[path.length - 1];
  if (key) parent[key] = value;
}

function stripAgentManifestKeys(root: CodexAgentTomlObject): CodexAgentTomlObject {
  const config: CodexAgentTomlObject = {};
  for (const [key, value] of Object.entries(root)) {
    if (AGENT_MANIFEST_KEYS.has(key) || THREAD_MAPPED_KEYS.has(key)) continue;
    config[key] = value;
  }
  return config;
}

function readString(value: CodexAgentTomlValue | undefined): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readStringArray(value: CodexAgentTomlValue | undefined): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return strings.length > 0 ? strings.map((item) => item.trim()) : undefined;
}

function unquoteBasicString(raw: string): string {
  try {
    return JSON.parse(raw) as string;
  } catch {
    return raw.slice(1, -1);
  }
}

function quoteTomlString(value: string): string {
  return JSON.stringify(value.replace(/\r\n/g, '\n'));
}

function quoteTomlMultiline(value: string): string {
  const normalized = value.replace(/\r\n/g, '\n');
  if (!normalized.includes("'''")) return `'''\n${normalized}${normalized.endsWith('\n') ? '' : '\n'}'''`;
  return `"""\n${normalized.replace(/"""/g, '\\"\\"\\"')}${normalized.endsWith('\n') ? '' : '\n'}"""`;
}
