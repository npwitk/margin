import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBibitems } from "./ai/citations.ts";

test("parses IEEE-style \\bibitem entries", () => {
  const tex = [
    '\\begin{thebibliography}{99}',
    '\\bibitem{ref28}',
    'I. Ray, K. Belyaev, and M. Rajaram,',
    "``Secure logging as a service,''",
    '\\textit{IEEE Syst. J.}, vol. 7, Jun. 2013,',
    'doi: 10.1109/JSYST.2012.2221958.',
    '',
    '\\bibitem[Pan24]{ref33}',
    "G. R. Panigrahi \\textit{et al.}, ``Analytical validation of a dataset,'' \\textit{IEEE Access}, 2024.",
    '\\end{thebibliography}',
  ].join("\n");
  const [a, b] = parseBibitems(tex);
  assert.deepEqual(a, { key: "ref28", line: 2, fields: { title: "Secure logging as a service", author: "I. Ray", doi: "10.1109/JSYST.2012.2221958", year: "2013" } });
  assert.equal(b.key, "ref33");
  assert.equal(b.fields.author, "G. R. Panigrahi");
  assert.equal(b.fields.year, "2024");
});
