import { describe, it, expect } from "vitest";
import { toJSONSchema } from "zod/v4/core";
import { FakeGenerationGateway, GEN_TASKS, type GenerationPort } from "./index.js";

const g: GenerationPort = new FakeGenerationGateway();
const input = { fieldLabel: "email", goal: "log in", visibleContext: "form", history: [] };

describe("FakeGenerationGateway", () => {
  it("is deterministic and content-addresses its output", async () => {
    const a = await g.generate("form.value", input);
    const b = await g.generate("form.value", input);
    expect(a.output).toEqual(b.output);
    expect(a.provenance.responseHash).toBe(b.provenance.responseHash);
    expect(a.provenance.model).toBe("fake");
  });
});

interface ObjectNode {
  path: string;
  properties: string[];
  required: string[];
}

/** Every object-typed JSON-Schema node reachable from `node`, with its property/required keys. */
function objectNodes(node: unknown, path: string, out: ObjectNode[]): void {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return;
  const n = node as Record<string, unknown>;
  const type = n.type;
  const isObject = type === "object" || (Array.isArray(type) && type.includes("object"));
  if (isObject && n.properties != null && typeof n.properties === "object") {
    out.push({
      path,
      properties: Object.keys(n.properties as Record<string, unknown>),
      required: Array.isArray(n.required) ? (n.required as string[]) : [],
    });
  }
  const props = n.properties;
  if (props != null && typeof props === "object") {
    for (const [key, value] of Object.entries(props as Record<string, unknown>)) objectNodes(value, `${path}.properties.${key}`, out);
  }
  if (n.items !== undefined) {
    const items = Array.isArray(n.items) ? n.items : [n.items];
    items.forEach((item, i) => objectNodes(item, `${path}.items${Array.isArray(n.items) ? `[${i}]` : ""}`, out));
  }
  for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
    const members = n[keyword];
    if (Array.isArray(members)) members.forEach((member, i) => objectNodes(member, `${path}.${keyword}[${i}]`, out));
  }
  for (const keyword of ["$defs", "definitions"] as const) {
    const defs = n[keyword];
    if (defs != null && typeof defs === "object") {
      for (const [key, value] of Object.entries(defs as Record<string, unknown>)) objectNodes(value, `${path}.${keyword}.${key}`, out);
    }
  }
  if (n.additionalProperties != null && typeof n.additionalProperties === "object") {
    objectNodes(n.additionalProperties, `${path}.additionalProperties`, out);
  }
}

/**
 * #460 — the converter `@ai-sdk/provider-utils` uses to turn a zod output schema into the JSON
 * Schema sent as `response_format` (its `zod4Schema`: `toJSONSchema(schema, { target: "draft-7",
 * io: "input", reused: "inline" })`). OpenAI/Azure strict mode rejects any object node that does
 * not list ALL of its properties in `required`, so every task output must satisfy that.
 */
describe("#460 — every model output schema is strict-mode valid", () => {
  for (const kind of Object.keys(GEN_TASKS) as (keyof typeof GEN_TASKS)[]) {
    it(`${kind} output lists every object property in required`, () => {
      const jsonSchema = toJSONSchema(GEN_TASKS[kind].output, { target: "draft-7", io: "input", reused: "inline" });
      const nodes: ObjectNode[] = [];
      objectNodes(jsonSchema, kind, nodes);
      const missing = nodes.flatMap((node) => {
        const absent = node.properties.filter((property) => !node.required.includes(property));
        return absent.length === 0 ? [] : [`${node.path} missing required: ${absent.join(", ")}`];
      });
      expect(missing).toEqual([]);
    });
  }
});
