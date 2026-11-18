import { listToolDescriptors } from "../native-host/src/tool-registry.ts";

interface JsonSchemaObject {
  properties?: Record<string, { type?: string | string[]; enum?: unknown[] }>;
  required?: string[];
}

function firstSentence(text: string): string {
  const match = /^.*?[.!?](?=\s|$)/s.exec(text.trim());
  return (match ? match[0] : text.trim()).replace(/\s+/g, " ");
}

function params(schema: JsonSchemaObject): string {
  const props = Object.entries(schema.properties ?? {});
  if (props.length === 0) return "none";
  const required = new Set(schema.required ?? []);
  return props
    .map(([name, p]) => `\`${name}${required.has(name) ? "" : "?"}\``)
    .join(", ");
}

export function renderToolsDoc(): string {
  const rows = listToolDescriptors().map(
    (t) =>
      `| \`${t.name}\` | ${firstSentence(t.description).replace(/\|/g, "\\|").replace(/<(\w+)>/g, "`<$1>`")} | ${params(t.inputSchema as JsonSchemaObject)} |`
  );
  return [
    "# Tool reference",
    "",
    "Generated from `native-host/src/tool-registry.ts` by `npm run docs:tools`. Do not edit by hand.",
    "A trailing `?` marks an optional parameter. `GET /v1/tools` or `chh tools` returns the full JSON Schema for each tool.",
    "",
    "| Tool | Summary | Parameters |",
    "|------|---------|------------|",
    ...rows,
    "",
  ].join("\n");
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.stdout.write(renderToolsDoc());
}
