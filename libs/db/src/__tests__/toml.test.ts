import { describe, it, expect } from "vitest";
import {
  parseNotebookToml,
  serializeNotebookToml,
  emptyNotebookToml,
} from "../toml";

describe("parseNotebookToml", () => {
  it("parses a full toml with meta and files", () => {
    const raw = `
[meta]
name = "研究笔记"
description = "关于 LLM 的阅读记录"
color = "#6366f1"
icon = "notebook"
updated_at = 2025-06-15T08:30:00Z

[[files]]
filename = "transformer-paper.md"
id = "f_abc123"
tag = "论文"

[[files]]
filename = "attention-notes.md"
id = "f_def456"
tag = "笔记"
`;
    const result = parseNotebookToml(raw);
    expect(result.meta.name).toBe("研究笔记");
    expect(result.meta.description).toBe("关于 LLM 的阅读记录");
    expect(result.meta.color).toBe("#6366f1");
    expect(result.meta.icon).toBe("notebook");
    expect(result.files).toHaveLength(2);
    expect(result.files[0].filename).toBe("transformer-paper.md");
    expect(result.files[0].id).toBe("f_abc123");
    expect(result.files[0].tag).toBe("论文");
    expect(result.files[1].id).toBe("f_def456");
  });

  it("parses a toml with only [meta] and no [[files]] (empty notebook)", () => {
    const raw = `
[meta]
name = "空笔记本"
description = ""
color = "#6366f1"
icon = "notebook"
updated_at = 2025-06-15T08:30:00Z
`;
    const result = parseNotebookToml(raw);
    expect(result.meta.name).toBe("空笔记本");
    expect(result.files).toEqual([]);
  });

  it("parses an empty string as empty notebook", () => {
    const result = emptyNotebookToml();
    expect(result.meta.name).toBe("");
    expect(result.files).toEqual([]);
  });

  it("parses a minimal toml with just [meta] name", () => {
    const raw = `
[meta]
name = "test"
`;
    const result = parseNotebookToml(raw);
    expect(result.meta.name).toBe("test");
    expect(result.meta.description).toBe("");
    expect(result.meta.color).toBe("#6366f1");
    expect(result.meta.icon).toBe("notebook");
    expect(result.files).toEqual([]);
  });

  it("parses completely empty meta (only index, no meta fields)", () => {
    const raw = "";
    // Empty string should be caught by caller (r2Sync returns emptyNotebookToml)
    // but parseNotebookToml with truly empty string after trim should also work
    const result = parseNotebookToml(raw);
    expect(result.meta.name).toBe("");
    expect(result.files).toEqual([]);
  });

  it("handles files with missing tag gracefully", () => {
    const raw = `
[meta]
name = "test"

[[files]]
filename = "hello.md"
id = "f_1"
`;
    const result = parseNotebookToml(raw);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].tag).toBe("");
  });

  it("skips files entries missing required fields", () => {
    const raw = `
[meta]
name = "test"

[[files]]
filename = "valid.md"
id = "f_1"

[[files]]
filename = "no-id.md"
`;
    const result = parseNotebookToml(raw);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].id).toBe("f_1");
  });
});

describe("serializeNotebookToml", () => {
  it("round-trips a full notebook", () => {
    const original = parseNotebookToml(`
[meta]
name = "测试"
description = "desc"
color = "#ff0000"
icon = "book"
updated_at = 2025-06-15T08:30:00Z

[[files]]
filename = "a.md"
id = "f_1"
tag = "笔记"
`);
    const serialized = serializeNotebookToml(original);
    const reparsed = parseNotebookToml(serialized);
    expect(reparsed.meta.name).toBe("测试");
    expect(reparsed.meta.color).toBe("#ff0000");
    expect(reparsed.files).toHaveLength(1);
    expect(reparsed.files[0].filename).toBe("a.md");
  });

  it("serializes empty notebook without [[files]] key", () => {
    const empty = emptyNotebookToml();
    const serialized = serializeNotebookToml(empty);
    expect(serialized).not.toContain("[[files]]");
    expect(serialized).toContain("[meta]");
  });
});
