import { describe, expect, it } from 'vitest';

import { ZDR_SAFE_TOOL_TYPES, convertTools, type VsCodeTool } from '../src/api/tools.js';

// The API's two documented tool constraints, each of which fails a request
// outright rather than degrading. Both are therefore correctness requirements,
// and these tests exist to keep them that way.

const FN_TOOL: VsCodeTool = {
  name: 'read_file',
  description: 'Read a file from the workspace',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
} as VsCodeTool;

describe('convertTools', () => {
  it('converts a plain tool to the API function shape', () => {
    const { tools, dropped } = convertTools([FN_TOOL], false);
    expect(dropped).toEqual([]);
    expect(tools).toEqual([
      {
        type: 'function',
        // NESTED. A flat `{ type, name, parameters }` sends `function` as
        // undefined, which the API rejects with "Invalid input: expected
        // object, received undefined" — the bug this shape fixes.
        function: {
          name: 'read_file',
          description: 'Read a file from the workspace',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      },
    ]);
  });

  it('never emits a flat tool definition, which the API rejects', () => {
    // A regression guard for the shape that caused the 0.3.1 failure: every
    // tool must carry a `function` object holding the definition.
    const { tools } = convertTools(
      [
        { name: 'a' },
        { name: 'b', description: 'd', inputSchema: { type: 'object', properties: {} } },
        { name: 'c', type: 'mcp', server: { inputSchema: { type: 'object' } } },
      ] as unknown as VsCodeTool[],
      false,
    );
    for (const tool of tools) {
      expect(tool.type).toBe('function');
      expect(tool.function, tool.function.name).toBeDefined();
      expect(typeof tool.function.name).toBe('string');
      expect(typeof tool.function.parameters).toBe('object');
    }
  });

  it('rewrites an mcp tool to type function, as the docs instruct', () => {
    // "Remote `type: mcp` tools are rejected, because the upstream would dial
    // your server on our credential. Run the MCP server on your side and
    // declare its tools as `type: function` instead."
    //
    // VS Code exposes MCP servers as `mcp`, so without this rewrite every
    // request in a session with an MCP server attached is refused.
    const mcp = {
      name: 'github_create_issue',
      type: 'mcp',
      description: 'Create an issue',
      inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
    } as unknown as VsCodeTool;

    const { tools, dropped } = convertTools([mcp], false);
    expect(dropped).toEqual([]);
    expect(tools).toHaveLength(1);
    expect(tools[0].type).toBe('function');
    // No `mcp` type may ever reach the wire.
    expect(tools.map((t) => t.type)).not.toContain('mcp');
  });

  it('never emits an mcp type, whatever it is given', () => {
    const mixed = [
      { name: 'a', type: 'mcp' },
      { name: 'b', type: 'function' },
      { name: 'c', type: 'custom' },
      { name: 'd', type: 'local_shell' },
      { name: 'e' },
    ] as unknown as VsCodeTool[];
    const { tools } = convertTools(mixed, false);
    expect(tools.every((t) => t.type === 'function')).toBe(true);
  });

  it('finds a schema nested under an mcp descriptor', () => {
    // A naive copy would send `{}` and leave the model calling blind.
    const nested = {
      name: 'search',
      type: 'mcp',
      server: { inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
    } as unknown as VsCodeTool;
    expect(convertTools([nested], false).tools[0].function.parameters).toEqual({
      type: 'object',
      properties: { q: { type: 'string' } },
    });
  });

  it('falls back to an empty object schema rather than inventing one', () => {
    const bare = { name: 'ping' } as VsCodeTool;
    expect(convertTools([bare], false).tools[0].function.parameters).toEqual({
      type: 'object',
      properties: {},
    });
    // A missing description is not an error either.
    expect(convertTools([bare], false).tools[0].function.description).toBe('');
  });

  it('drops nothing when zero data retention is off', () => {
    const tools = [
      { name: 'a', type: 'function' },
      { name: 'b', type: 'custom' },
      { name: 'c', type: 'local_shell' },
      { name: 'd', type: 'mcp' },
    ] as unknown as VsCodeTool[];
    const { tools: converted, dropped } = convertTools(tools, false);
    expect(converted).toHaveLength(4);
    expect(dropped).toEqual([]);
  });

  it('filters the array to the ZDR-safe set rather than sending it raw', () => {
    // "Requests sent with `x-cmd-zdr: 1` accept only tools your own client
    // executes, which today means `function`, `custom` and `local_shell`.
    // Anything else is refused" — a refusal fails the whole request, so the
    // array must be filtered here, not sent and rejected.
    //
    // `mcp` survives because it is rewritten to `function` first: the docs tell
    // us to declare MCP tools as `function` and run the server locally, so an
    // MCP tool is client-executed and ZDR-safe once rewritten. A genuinely
    // server-side tool like `web_search` is still dropped.
    const tools = [
      { name: 'ok_fn', type: 'function' },
      { name: 'ok_custom', type: 'custom' },
      { name: 'ok_shell', type: 'local_shell' },
      { name: 'ok_mcp', type: 'mcp' },
      { name: 'refused_web', type: 'web_search' },
    ] as unknown as VsCodeTool[];

    const { tools: converted, dropped } = convertTools(tools, true);
    expect(converted.map((t) => t.function.name)).toEqual([
      'ok_fn',
      'ok_custom',
      'ok_shell',
      'ok_mcp',
    ]);
    expect(converted.every((t) => t.type === 'function')).toBe(true);
    expect(dropped.map((d) => d.name)).toEqual(['refused_web']);
    for (const d of dropped) {
      expect(d.reason).toContain('zero data retention');
      expect(d.reason).toContain(ZDR_SAFE_TOOL_TYPES[0]);
    }
  });

  it('converts an mcp tool under ZDR rather than dropping it', () => {
    // VS Code hands MCP tools over as `mcp`, and after rewriting they are an
    // ordinary `function` — which IS ZDR-safe. Dropping them would needlessly
    // cost a ZDR user their MCP tools.
    const mcp = { name: 'github_list', type: 'mcp' } as unknown as VsCodeTool;
    const { tools, dropped } = convertTools([mcp], true);
    expect(dropped).toEqual([]);
    expect(tools).toHaveLength(1);
    expect(tools[0].type).toBe('function');
  });

  it('handles an empty tool list', () => {
    expect(convertTools([], false)).toEqual({ tools: [], dropped: [] });
    expect(convertTools([], true)).toEqual({ tools: [], dropped: [] });
  });
});
