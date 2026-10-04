import { test } from "node:test";
import assert from "node:assert/strict";
import { citedKeys, parseBibtex, plainTex, titleSimilarity } from "./bibtex.ts";

const BIB = String.raw`% my refs
@inproceedings{vaswani2017attention,
  title     = {Attention Is All You Need},
  author    = {Vaswani, Ashish and Shazeer, Noam},
  year      = 2017,
  booktitle = "Advances in {Neural} Information Processing Systems"
}

@article{mcmahan2017,
  title = {Communication-Efficient Learning of Deep Networks from Decentralized Data},
  doi = {10.48550/arXiv.1602.05629}, year={2017}}
@comment{ignored}
`;

test("parses entries, fields and lines", () => {
  const e = parseBibtex(BIB);
  assert.deepEqual(e.map((x) => [x.key, x.type, x.line]), [["vaswani2017attention", "inproceedings", 2], ["mcmahan2017", "article", 9]]);
  assert.equal(e[0].fields.year, "2017");
  assert.equal(plainTex(e[0].fields.booktitle), "Advances in Neural Information Processing Systems");
  assert.equal(e[1].fields.doi, "10.48550/arXiv.1602.05629");
});

test("finds cite keys, skipping comments", () => {
  const keys = citedKeys(String.raw`As shown \citep[p.~3]{a,b} and \citet{c}.
% \cite{hidden}
\nocite{d}`);
  assert.deepEqual(keys, [{ key: "a", line: 1 }, { key: "b", line: 1 }, { key: "c", line: 1 }, { key: "d", line: 3 }]);
});

test("title similarity", () => {
  assert.ok(titleSimilarity("Attention Is All You Need", "Attention is all you need") > 0.99);
  assert.ok(titleSimilarity("Attention Is All You Need", "Deep Residual Learning for Image Recognition") < 0.2);
});
