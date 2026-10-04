import { test } from "node:test";
import assert from "node:assert/strict";
import { byline, isGenericKey, parseBibtex, samePaper, suggestKey, toBibitem, toBibtex } from "@margin/shared";

const fields = { author: "Wells, Thomas and Houben, Steven", title: "{CollabAR} -- Investigating the Mediating Role of Mobile AR Interfaces", year: "2020", booktitle: "Proc. CHI", doi: "10.1145/3313831.3376541" };

test("library keys and bylines", () => {
  assert.equal(suggestKey(fields), "wells2020collabar");
  assert.equal(byline(fields), "Wells & Houben, 2020");
  assert.equal(byline({ author: "A. One and B. Two and C. Three", year: "2021" }), "One et al., 2021");
  assert.ok(isGenericKey("ref12") && isGenericKey("b3") && !isGenericKey("wells2020"));
});

test("same paper by DOI, else by title and year", () => {
  assert.ok(samePaper(fields, { doi: "https://doi.org/10.1145/3313831.3376541", title: "x" }));
  assert.ok(samePaper({ title: "Attention is all you need", year: "2017" }, { title: "Attention Is All You {N}eed", year: "2017" }));
  assert.ok(!samePaper({ title: "Attention is all you need", year: "2017" }, { title: "Attention is all you need", year: "2025" }));
});

test("BibTeX round trip", () => {
  const [e] = parseBibtex(toBibtex({ type: "inproceedings", key: "wells2020collabar", fields }));
  assert.equal(e.key, "wells2020collabar");
  assert.deepEqual(e.fields, fields);
});

test("IEEE-style bibitem", () => {
  assert.equal(toBibitem({ key: "w", fields }),
    "\\bibitem{w}\nT. Wells and S. Houben,\n``{CollabAR} -- Investigating the Mediating Role of Mobile AR Interfaces,''\nin \\textit{Proc. CHI}, 2020, doi: 10.1145/3313831.3376541.");
});
