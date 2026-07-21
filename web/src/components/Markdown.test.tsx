import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { looksLikeMarkdown, Markdown } from "./Markdown";

describe("looksLikeMarkdown", () => {
  it("detects markdown structures", () => {
    expect(looksLikeMarkdown("### 1. 技术栈\n- **Web服务器**: Apache")).toBe(true);
    expect(looksLikeMarkdown("| 端点 | 方法 |\n|------|------|")).toBe(true);
    expect(looksLikeMarkdown("普通的一行摘要，没有任何标记")).toBe(false);
  });
});

describe("Markdown", () => {
  it("renders headings, lists and tables", () => {
    const { container } = render(<Markdown text={"## 侦察发现\n- **确认** 路径遍历\n\n| 端点 | 状态 |\n|---|---|\n| /login.php | 公开 |"} />);
    expect(screen.getByText("侦察发现").tagName).toBe("H2");
    expect(container.querySelector("strong")?.textContent).toBe("确认");
    expect(container.querySelectorAll("table tbody tr")).toHaveLength(1);
  });

  it("sanitizes injected html", () => {
    const { container } = render(<Markdown text={'hello <script>alert(1)</script><img src=x onerror="alert(2)">'} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")?.getAttribute("onerror")).toBeNull();
  });

  it("opens links in a new tab", () => {
    const { container } = render(<Markdown text={"[ref](https://example.com/poc)"} />);
    const link = container.querySelector("a");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toContain("noopener");
  });
});
