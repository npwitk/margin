import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, parseRemote } from "./config.js";

test("parses Margin git remotes", () => {
  assert.deepEqual(parseRemote("https://paper.example.com/git/my-paper-1a2b3c.git"), { url: "https://paper.example.com", project: "my-paper-1a2b3c", token: undefined });
  assert.deepEqual(parseRemote("http://alice:mgn_abc@localhost:5173/git/x-1.git"), { url: "http://localhost:5173", project: "x-1", token: "mgn_abc" });
  assert.deepEqual(parseRemote("https://host/margin/git/p.git"), { url: "https://host/margin", project: "p", token: undefined });
  assert.equal(parseRemote("git@github.com:a/b.git"), null);
});

test("flags beat env; missing values explain themselves", () => {
  const c = loadConfig(["--url", "https://a/", "--project", "p"], { MARGIN_TOKEN: "mgn_t", MARGIN_PROJECT: "ignored" }, "/");
  assert.deepEqual(c, { url: "https://a", project: "p", token: "mgn_t", agentName: undefined });
  assert.throws(() => loadConfig([], {}, "/"), /missing --url/);
});

test("parses the links people copy from the browser", async () => {
  const { parseLink } = await import("./config.js");
  assert.deepEqual(parseLink("https://paper.example.com/#/p/my-paper-1a2b3c"), { url: "https://paper.example.com", project: "my-paper-1a2b3c", token: undefined });
  assert.deepEqual(parseLink("http://localhost:5173/#/p/x-1?tab=board"), { url: "http://localhost:5173", project: "x-1", token: undefined });
  assert.deepEqual(parseLink("https://host/git/p.git"), { url: "https://host", project: "p", token: undefined });
  assert.equal(parseLink("https://host/#/library"), null);
});
