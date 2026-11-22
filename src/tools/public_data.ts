import { searchCatalog, describeApi, callApi, SearchArgs, DescribeArgs, CallArgs, maskKey } from "../lib/publicdata.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (v: unknown): ToolResult => ({
  content: [{ type: "text" as const, text: typeof v === "string" ? v : maskKey(JSON.stringify(v, null, 2)) }],
});

const fail = (e: any): ToolResult => ({
  content: [{ type: "text" as const, text: maskKey(JSON.stringify({ error: e?.message ?? String(e), code: e?.code }, null, 2)) }],
  isError: true,
});

export const searchPublicDataTool = async (args: SearchArgs) => {
  try {
    return ok(await searchCatalog(args));
  } catch (e) {
    return fail(e);
  }
};

export const describePublicApiTool = async (args: DescribeArgs) => {
  try {
    return ok(await describeApi(args));
  } catch (e) {
    return fail(e);
  }
};

export const callPublicApiTool = async (args: CallArgs) => {
  try {
    return ok(await callApi(args));
  } catch (e) {
    return fail(e);
  }
};
