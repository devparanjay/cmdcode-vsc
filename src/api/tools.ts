/**
 * Tool-array conversion for the Command Code Provider API.
 *
 * The API passes tool arrays through to the model and the *client* executes
 * them, which is the loop VS Code drives. Two documented constraints apply, and
 * both are hard failures rather than warnings:
 *
 *  1. Remote `type: "mcp"` tools are rejected — "the upstream would dial your
 *     server on our credential. Run the MCP server on your side and declare its
 *     tools as `type: "function"` instead." VS Code exposes MCP servers as `mcp`
 *     type, so without the rewrite below every request in a session with an MCP
 *     server attached is refused.
 *
 *  2. Under zero data retention (`x-cmd-zdr: 1`) the accepted set narrows to
 *     `function`, `custom` and `local_shell`, and a request containing anything
 *     else **fails**. So the array is filtered rather than sent raw.
 *
 * Pure module: no `vscode` import, no I/O, fully unit-testable.
 */

/** The three tool shapes the API will accept under ZDR. */
export const ZDR_SAFE_TOOL_TYPES: readonly string[] = ['function', 'custom', 'local_shell'];

/** A tool as VS Code hands it to a provider. */
export interface VsCodeTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: object;
}

/** A tool in the OpenAI Responses `function` shape the API expects. */
export interface ApiFunctionTool {
  readonly type: 'function';
  readonly name: string;
  readonly description: string;
  readonly parameters: object;
}

/** A tool we could not convert, with the reason, so the caller can report it. */
export interface DroppedTool {
  readonly name: string;
  readonly type: string;
  readonly reason: string;
}

export interface ConversionResult {
  readonly tools: readonly ApiFunctionTool[];
  readonly dropped: readonly DroppedTool[];
}

/**
 * The schema shape MCP tools arrive in. VS Code's MCP descriptors nest the
 * callable's schema one level down, under `inputSchema` of the server entry, so
 * a naive copy would send an empty object and the model would call it blind.
 */
interface PossiblyNestedMcpTool extends VsCodeTool {
  readonly type?: string;
  readonly inputSchema?: object;
  readonly server?: { readonly inputSchema?: object };
  readonly tool?: { readonly inputSchema?: object };
}

/** An input schema with nothing usable in it is worse than none: the model then guesses. */
function isUsableSchema(schema: unknown): schema is object {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    return false;
  }
  const record = schema as Record<string, unknown>;
  // A schema that declares no properties cannot constrain or describe a call.
  return record.type !== undefined || record.properties !== undefined || record.$ref !== undefined;
}

/**
 * Dig the real schema out of an MCP descriptor, or return null when there is
 * none to find. Being unable to find one is not itself an error — a tool with a
 * free-form schema is still callable — but we never invent a schema we did not
 * receive.
 */
function resolveSchema(tool: PossiblyNestedMcpTool): object | null {
  const candidates: unknown[] = [
    tool.inputSchema,
    tool.server?.inputSchema,
    tool.tool?.inputSchema,
  ];
  for (const candidate of candidates) {
    if (isUsableSchema(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Convert VS Code's tool list into the API's `function` tools.
 *
 * Every VS Code tool is a callable, so all of them become `type: "function"`.
 * The `mcp` distinction is a transport concern (where the implementation runs),
 * not a capability one, and flattening it is precisely what the docs instruct:
 * declare the tool as `function` and let the client run it.
 *
 * @param tools       the tools VS Code offered this turn
 * @param zeroDataRetention when true, drop anything outside the ZDR-safe set
 */
export function convertTools(tools: readonly VsCodeTool[], zeroDataRetention: boolean): ConversionResult {
  const converted: ApiFunctionTool[] = [];
  const dropped: DroppedTool[] = [];

  for (const tool of tools) {
    const typed = tool as PossiblyNestedMcpTool;
    const declaredType = typed.type ?? 'function';

    // The ZDR check runs on the DECLARED type, before the rewrite. "Requests
    // sent with `x-cmd-zdr: 1` accept only tools your own client executes,
    // which today means `function`, `custom` and `local_shell`. Anything else
    // is refused" — a refusal fails the whole request, so a `web_search` or
    // server-side tool has to be removed here rather than sent and rejected.
    //
    // `mcp` is the one subtlety: the docs tell us to run the server locally and
    // declare its tools as `function`, which is what the rewrite below does. So
    // an MCP tool is treated as the `function` it becomes, not refused.
    const zdrType = declaredType === 'mcp' ? 'function' : declaredType;
    if (zeroDataRetention && !ZDR_SAFE_TOOL_TYPES.includes(zdrType)) {
      dropped.push({
        name: tool.name,
        type: declaredType,
        reason: `not permitted with zero data retention (allowed: ${ZDR_SAFE_TOOL_TYPES.join(', ')})`,
      });
      continue;
    }

    // Every VS Code tool is callable by the client, so all of them are sent as
    // `type: "function"`. The mcp distinction is about *where the code runs*,
    // not what it can do, and flattening it is what the docs instruct.
    converted.push({
      type: 'function',
      name: tool.name,
      description: tool.description ?? '',
      parameters: resolveSchema(typed) ?? { type: 'object', properties: {} },
    });
  }

  return { tools: converted, dropped };
}
