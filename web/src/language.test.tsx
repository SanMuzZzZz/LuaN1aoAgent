import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { LanguageProvider, useLanguage } from "./language";

beforeEach(() => {
  localStorage.clear();
});

describe("LanguageProvider", () => {
  it("uses Chinese for a Chinese browser without a stored preference", () => {
    setBrowserLanguage("zh-CN");
    renderProbe();

    expect(screen.getByRole("button", { name: "zh-CN:载入" })).toBeInTheDocument();
  });

  it("uses English for an English browser without a stored preference", () => {
    setBrowserLanguage("en-US");
    renderProbe();

    expect(screen.getByRole("button", { name: "en-US:Load" })).toBeInTheDocument();
  });

  it("defaults to Chinese for other browser locales", () => {
    setBrowserLanguage("fr-FR");
    renderProbe();

    expect(screen.getByRole("button", { name: "zh-CN:载入" })).toBeInTheDocument();
  });

  it("prefers the stored locale over the browser locale", () => {
    setBrowserLanguage("zh-CN");
    localStorage.setItem("luanniao-locale", "en-US");
    renderProbe();

    expect(screen.getByRole("button", { name: "en-US:Load" })).toBeInTheDocument();
  });

  it("persists a toggle and updates document language and title", async () => {
    setBrowserLanguage("zh-CN");
    renderProbe();

    fireEvent.click(screen.getByRole("button", { name: "zh-CN:载入" }));

    expect(screen.getByRole("button", { name: "en-US:Load" })).toBeInTheDocument();
    expect(localStorage.getItem("luanniao-locale")).toBe("en-US");
    await waitFor(() => {
      expect(document.documentElement.lang).toBe("en-US");
      expect(document.title).toBe("LuaNiao Agent Workbench");
    });
  });
});

function Probe() {
  const { locale, t, toggleLocale } = useLanguage();
  return <button type="button" onClick={toggleLocale}>{locale}:{t("common.load")}</button>;
}

function renderProbe() {
  return render(<LanguageProvider><Probe /></LanguageProvider>);
}

function setBrowserLanguage(language: string) {
  Object.defineProperty(window.navigator, "language", {
    configurable: true,
    value: language
  });
}
