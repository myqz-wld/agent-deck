import { isJsonObject, type JsonObject, type JsonValue } from './json';

export const MCP_PLAN_PRESENTATION_SCHEMA = 'agent-deck.mcp-plan.v1';
export const MCP_DIFF_PRESENTATION_SCHEMA = 'agent-deck.mcp-diff.v1';
export const MCP_PRESENTATION_MAX_DISPLAY_BYTES = 512 * 1024;
export const MCP_PRESENTATION_MAX_FEEDBACK_LENGTH = 40_000;

const MAX_SOURCE_LENGTH = 100_000;
const MAX_TITLE_LENGTH = 120;
const MAX_LABEL_LENGTH = 80;
const MAX_PATH_LENGTH = 4_096;
const MAX_INSTRUCTIONS_LENGTH = 10_000;
const MAX_RATIONALE_LENGTH = 40_000;
const MAX_ANNOTATIONS = 40;
const MAX_ANNOTATION_LENGTH = 4_000;
const MAX_LINE = 1_000_000;

export interface McpPlanPresentationDisplay {
  schema: typeof MCP_PLAN_PRESENTATION_SCHEMA;
  plan: string;
  title?: string;
}

export interface McpDiffPresentationAnnotation {
  pane: 'after' | 'base' | 'before' | 'both' | 'ours' | 'resolution' | 'theirs';
  body: string;
  line?: number;
  title?: string;
}

export interface McpDiffPresentationPr {
  before: string;
  after: string;
  beforeLabel?: string;
  afterLabel?: string;
  unifiedDiff?: string;
}

export interface McpDiffPresentationConflict {
  ours: string;
  theirs: string;
  resolution: string;
  base?: string;
  oursLabel?: string;
  theirsLabel?: string;
  resolutionLabel?: string;
  baseLabel?: string;
}

export interface McpDiffPresentationDisplay {
  schema: typeof MCP_DIFF_PRESENTATION_SCHEMA;
  mode: 'merge-conflict' | 'pr';
  rationale: string;
  title?: string;
  filePath?: string;
  language?: string;
  instructions?: string;
  annotations?: McpDiffPresentationAnnotation[];
  pr?: McpDiffPresentationPr;
  conflict?: McpDiffPresentationConflict;
}

export type McpPresentationDisplay =
  | McpPlanPresentationDisplay
  | McpDiffPresentationDisplay;

function fail(field: string): never {
  throw new Error(`${field} is invalid`);
}

function object(value: unknown, field: string): JsonObject {
  if (!isJsonObject(value)) return fail(field);
  return value;
}

function exact(value: JsonObject, fields: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(field);
  }
}

function text(value: unknown, field: string, maximum: number, minimum = 0): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) fail(field);
  return value;
}

function optionalText(
  value: unknown,
  field: string,
  maximum: number,
): string | undefined {
  return value === undefined ? undefined : text(value, field, maximum, 1);
}

function fields(value: JsonObject, required: readonly string[], optional: readonly string[]): string[] {
  return [...required, ...optional.filter((key) => value[key] !== undefined)];
}

function displayPath(value: unknown): string | undefined {
  const path = optionalText(value, 'mcp.presentation.filePath', MAX_PATH_LENGTH);
  if (path === undefined) return undefined;
  const segments = path.replaceAll('\\', '/').split('/');
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || segments.some((part) => part === '..')) {
    fail('mcp.presentation.filePath');
  }
  return path;
}

function annotation(value: unknown): McpDiffPresentationAnnotation {
  const raw = object(value, 'mcp.presentation.annotation');
  exact(raw, fields(raw, ['body', 'pane'], ['line', 'title']), 'mcp.presentation.annotation');
  const panes = ['after', 'base', 'before', 'both', 'ours', 'resolution', 'theirs'] as const;
  if (!panes.includes(raw.pane as typeof panes[number])) fail('mcp.presentation.annotation.pane');
  if (raw.line !== undefined && (
    typeof raw.line !== 'number' || !Number.isInteger(raw.line) || raw.line < 0 || raw.line > MAX_LINE
  )) fail('mcp.presentation.annotation.line');
  return {
    pane: raw.pane as McpDiffPresentationAnnotation['pane'],
    body: text(raw.body, 'mcp.presentation.annotation.body', MAX_ANNOTATION_LENGTH, 1),
    ...(raw.line === undefined ? {} : { line: raw.line }),
    ...(raw.title === undefined ? {} : {
      title: text(raw.title, 'mcp.presentation.annotation.title', MAX_TITLE_LENGTH, 1),
    }),
  };
}

function pr(value: unknown): McpDiffPresentationPr {
  const raw = object(value, 'mcp.presentation.pr');
  exact(raw, fields(raw, ['after', 'before'], ['afterLabel', 'beforeLabel', 'unifiedDiff']),
    'mcp.presentation.pr');
  return {
    before: text(raw.before, 'mcp.presentation.pr.before', MAX_SOURCE_LENGTH),
    after: text(raw.after, 'mcp.presentation.pr.after', MAX_SOURCE_LENGTH),
    ...(raw.beforeLabel === undefined ? {} : {
      beforeLabel: text(raw.beforeLabel, 'mcp.presentation.pr.beforeLabel', MAX_LABEL_LENGTH, 1),
    }),
    ...(raw.afterLabel === undefined ? {} : {
      afterLabel: text(raw.afterLabel, 'mcp.presentation.pr.afterLabel', MAX_LABEL_LENGTH, 1),
    }),
    ...(raw.unifiedDiff === undefined ? {} : {
      unifiedDiff: text(raw.unifiedDiff, 'mcp.presentation.pr.unifiedDiff', MAX_SOURCE_LENGTH),
    }),
  };
}

function conflict(value: unknown): McpDiffPresentationConflict {
  const raw = object(value, 'mcp.presentation.conflict');
  exact(raw, fields(raw, ['ours', 'resolution', 'theirs'], [
    'base', 'baseLabel', 'oursLabel', 'resolutionLabel', 'theirsLabel',
  ]), 'mcp.presentation.conflict');
  return {
    ours: text(raw.ours, 'mcp.presentation.conflict.ours', MAX_SOURCE_LENGTH),
    theirs: text(raw.theirs, 'mcp.presentation.conflict.theirs', MAX_SOURCE_LENGTH),
    resolution: text(raw.resolution, 'mcp.presentation.conflict.resolution', MAX_SOURCE_LENGTH),
    ...(raw.base === undefined ? {} : {
      base: text(raw.base, 'mcp.presentation.conflict.base', MAX_SOURCE_LENGTH),
    }),
    ...Object.fromEntries([
      ['oursLabel', raw.oursLabel],
      ['theirsLabel', raw.theirsLabel],
      ['resolutionLabel', raw.resolutionLabel],
      ['baseLabel', raw.baseLabel],
    ].filter(([, item]) => item !== undefined).map(([key, item]) => [
      key,
      text(item, `mcp.presentation.conflict.${key}`, MAX_LABEL_LENGTH, 1),
    ])),
  } as McpDiffPresentationConflict;
}

function assertBytes(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value)) > MCP_PRESENTATION_MAX_DISPLAY_BYTES) {
    fail('mcp.presentation.bytes');
  }
}

export function parseMcpPresentationDisplay(value: unknown): McpPresentationDisplay | null {
  if (!isJsonObject(value)) return null;
  if (value.schema === MCP_PLAN_PRESENTATION_SCHEMA) {
    exact(value, fields(value, ['plan', 'schema'], ['title']), 'mcp.presentation.plan');
    const result: McpPlanPresentationDisplay = {
      schema: MCP_PLAN_PRESENTATION_SCHEMA,
      plan: text(value.plan, 'mcp.presentation.plan.plan', MAX_SOURCE_LENGTH, 1),
      ...(value.title === undefined ? {} : {
        title: text(value.title, 'mcp.presentation.plan.title', MAX_TITLE_LENGTH, 1),
      }),
    };
    assertBytes(result);
    return result;
  }
  if (value.schema !== MCP_DIFF_PRESENTATION_SCHEMA) return null;
  exact(value, fields(value, ['mode', 'rationale', 'schema'], [
    'annotations', 'conflict', 'filePath', 'instructions', 'language', 'pr', 'title',
  ]), 'mcp.presentation.diff');
  if (value.mode !== 'pr' && value.mode !== 'merge-conflict') fail('mcp.presentation.diff.mode');
  const annotations = value.annotations === undefined
    ? undefined
    : Array.isArray(value.annotations) && value.annotations.length <= MAX_ANNOTATIONS
      ? value.annotations.map(annotation)
      : fail('mcp.presentation.diff.annotations');
  const parsedPr = value.pr === undefined ? undefined : pr(value.pr);
  const parsedConflict = value.conflict === undefined ? undefined : conflict(value.conflict);
  if ((value.mode === 'pr') !== Boolean(parsedPr) || (value.mode === 'pr') === Boolean(parsedConflict)) {
    fail('mcp.presentation.diff.payload');
  }
  if (annotations?.some((item) => value.mode === 'pr'
    ? !['after', 'before', 'both'].includes(item.pane)
    : !['base', 'ours', 'resolution', 'theirs'].includes(item.pane) ||
      (item.pane === 'base' && !parsedConflict?.base))) {
    fail('mcp.presentation.diff.annotations');
  }
  const result: McpDiffPresentationDisplay = {
    schema: MCP_DIFF_PRESENTATION_SCHEMA,
    mode: value.mode,
    rationale: text(value.rationale, 'mcp.presentation.diff.rationale', MAX_RATIONALE_LENGTH, 1),
    ...(value.title === undefined ? {} : {
      title: text(value.title, 'mcp.presentation.diff.title', MAX_TITLE_LENGTH, 1),
    }),
    ...(value.filePath === undefined ? {} : { filePath: displayPath(value.filePath)! }),
    ...(value.language === undefined ? {} : {
      language: text(value.language, 'mcp.presentation.diff.language', MAX_LABEL_LENGTH, 1),
    }),
    ...(value.instructions === undefined ? {} : {
      instructions: text(value.instructions, 'mcp.presentation.diff.instructions',
        MAX_INSTRUCTIONS_LENGTH, 1),
    }),
    ...(annotations === undefined ? {} : { annotations }),
    ...(parsedPr === undefined ? {} : { pr: parsedPr }),
    ...(parsedConflict === undefined ? {} : { conflict: parsedConflict }),
  };
  assertBytes(result);
  return result;
}

export function parseMcpPresentationFeedback(value: JsonValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  const raw = object(value, 'mcp.presentation.feedback');
  exact(raw, raw.feedback === undefined ? [] : ['feedback'], 'mcp.presentation.feedback');
  return optionalText(raw.feedback, 'mcp.presentation.feedback.feedback',
    MCP_PRESENTATION_MAX_FEEDBACK_LENGTH)?.trim() || undefined;
}
