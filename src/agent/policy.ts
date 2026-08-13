import path from 'node:path';

import type {
  CanUseTool,
  HookCallbackMatcher,
  PermissionResult,
} from '@anthropic-ai/claude-agent-sdk';

import type { SessionWorkspace } from './workspace';

export type PolicyDecision =
  | { behavior: 'allow' }
  | { behavior: 'deny'; reason: string }
  | { behavior: 'ask'; reason: string };

const readTools = new Set(['Read', 'Glob', 'Grep']);
const writeTools = new Set(['Write', 'Edit', 'NotebookEdit']);
const highRiskMcpPattern = /^mcp__(?:commit|lifecycle|media)__(?:commit_|create_module_version|promote_scope|execute_|start_cloud_)/u;

function extractPath(toolName: string, input: Record<string, unknown>): string | null {
  const keys = toolName === 'Glob' || toolName === 'Grep'
    ? ['path']
    : ['file_path', 'notebook_path', 'path'];
  for (const key of keys) {
    if (typeof input[key] === 'string') return input[key];
  }
  return null;
}

function isWithin(candidate: string, roots: string[], base: string): boolean {
  const resolved = path.resolve(base, candidate).toLowerCase();
  return roots.some((root) => {
    const resolvedRoot = path.resolve(root).toLowerCase();
    return resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path.sep}`);
  });
}

function assessBash(command: unknown, workspace: SessionWorkspace): PolicyDecision {
  if (typeof command !== 'string' || !command.trim()) {
    return { behavior: 'deny', reason: 'A non-empty command is required.' };
  }

  const forbidden = [
    /(?:^|\s)(?:git|curl|wget|ssh|scp|ftp|bitsadmin|certutil)(?:\s|$)/iu,
    /(?:Get-ChildItem|dir|set)\s+(?:env:|environment)/iu,
    /\$(?:env|Env):|process\.env|os\.environ/iu,
    /--encodedcommand|-enc\s/iu,
    /(?:^|[\\/])\.\.(?:[\\/]|$)/u,
    /[a-zA-Z]:[\\/]/u,
    /\\\\[^\\]+\\/u,
  ];
  if (forbidden.some((pattern) => pattern.test(command))) {
    return {
      behavior: 'deny',
      reason: 'Command violates the local workspace, credential, network, or Git boundary.',
    };
  }

  if (!isWithin(workspace.scratch, [workspace.root], workspace.root)) {
    return { behavior: 'deny', reason: 'Invalid workspace configuration.' };
  }
  return { behavior: 'allow' };
}

export function evaluateToolUse(
  toolName: string,
  input: Record<string, unknown>,
  workspace: SessionWorkspace,
): PolicyDecision {
  if (toolName === 'Agent' || toolName === 'Task' || toolName.startsWith('mcp__ide__')) {
    return { behavior: 'deny', reason: 'Subagents and external IDE tools are disabled.' };
  }
  if (toolName === 'WebSearch' || toolName === 'WebFetch') {
    return { behavior: 'deny', reason: 'Network research is disabled in ordinary sessions.' };
  }
  if (highRiskMcpPattern.test(toolName)) {
    return { behavior: 'ask', reason: 'This operation requires a host-issued confirmation token.' };
  }

  if (readTools.has(toolName)) {
    const requestedPath = extractPath(toolName, input);
    if (!requestedPath || !isWithin(requestedPath, [workspace.root], workspace.root)) {
      return { behavior: 'deny', reason: 'Reads are confined to the current session workspace.' };
    }
    return { behavior: 'allow' };
  }

  if (writeTools.has(toolName)) {
    const requestedPath = extractPath(toolName, input);
    if (!requestedPath || !isWithin(requestedPath, [
      workspace.scratch,
      workspace.output,
      workspace.temporary,
    ], workspace.root)) {
      return { behavior: 'deny', reason: 'Writes are confined to scratch, output, and tmp.' };
    }
    return { behavior: 'allow' };
  }

  if (toolName === 'Bash') {
    return assessBash(input.command, workspace);
  }
  if (toolName === 'Skill' || toolName.startsWith('mcp__')) {
    return { behavior: 'allow' };
  }

  return { behavior: 'deny', reason: `Tool is outside the P0 allowlist: ${toolName}` };
}

export function createCanUseTool(workspace: SessionWorkspace): CanUseTool {
  return async (toolName, input): Promise<PermissionResult> => {
    const decision = evaluateToolUse(toolName, input, workspace);
    if (decision.behavior === 'allow') return { behavior: 'allow' };
    return {
      behavior: 'deny',
      message: decision.reason,
      interrupt: false,
    };
  };
}

export function createPolicyHooks(workspace: SessionWorkspace): {
  PreToolUse: HookCallbackMatcher[];
} {
  return {
    PreToolUse: [{
      matcher: '.*',
      hooks: [async (input) => {
        if (input.hook_event_name !== 'PreToolUse') return { continue: true };
        const toolInput = typeof input.tool_input === 'object' && input.tool_input !== null
          ? input.tool_input as Record<string, unknown>
          : {};
        const decision = evaluateToolUse(input.tool_name, toolInput, workspace);
        if (decision.behavior === 'allow') return { continue: true };
        return {
          continue: true,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: decision.behavior === 'deny' ? 'deny' as const : 'ask' as const,
            permissionDecisionReason: decision.reason,
          },
        };
      }],
    }],
  };
}
