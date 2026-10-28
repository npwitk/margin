import type { DocumentTemplate, Engine } from "./types.ts";

/**
 * The template gallery: every format you can start a paper, slides, poster or
 * letter from. Files live in apps/server/templates/<id>/; templates with a
 * `kit` also need the venue's official style files, which the server downloads
 * from the venue (they aren't ours to redistribute).
 */

export type TemplateCategory = "Basic" | "Conference" | "Journal" | "Slides" | "Poster" | "Thesis & reports" | "Letters & CV";

export const TEMPLATE_CATEGORIES: TemplateCategory[] = ["Basic", "Conference", "Journal", "Slides", "Poster", "Thesis & reports", "Letters & CV"];

export interface TemplateInfo {
  id: string;
  name: string;
  category: TemplateCategory;
  /** One line under the name, e.g. "acmart · sigconf". */
  detail: string;
  /** Shape of the preview. */
  shape?: "page" | "slide" | "poster";
  engine?: Engine;
  /** Uses the venue's official style files, downloaded when the project is made. */
  kit?: { source: string };
  /** Conferences (names as in the deadline list) that use this format. */
  venues?: string[];
  /** Words people might search for. */
  keywords?: string;
  /** The generated single-file template to use when this goes next to an existing paper. */
  beside?: DocumentTemplate;
}

export const TEMPLATES: TemplateInfo[] = [
  // Basic
  { id: "article", name: "Article", category: "Basic", detail: "Sections, natbib, a references folder", beside: "article", keywords: "paper report generic" },
  { id: "preprint", name: "Preprint", category: "Basic", detail: "Clean single column for arXiv", keywords: "arxiv preprint working paper" },
  { id: "blank", name: "Blank", category: "Basic", detail: "Just main.tex", beside: "blank", keywords: "empty minimal" },

  // Conference papers
  {
    id: "acm-sigconf", name: "ACM Conference", category: "Conference", detail: "acmart · sigconf, two columns",
    keywords: "acm sigconf acmart",
    venues: ["CCS", "CHI", "SIGKDD", "WWW", "SIGCOMM", "MobiCom", "MobiSys", "SenSys", "SIGMOD", "SIGIR", "CIKM", "WSDM", "ACM MM", "AsiaCCS", "RecSys", "WiSec", "CODASPY", "UIST", "IMC", "CoNEXT", "HotNets", "ICMR", "IUI", "MMSys", "SACMAT"],
  },
  {
    id: "ieee", name: "IEEE Conference", category: "Conference", detail: "IEEEtran · conference, two columns", beside: "ieee",
    keywords: "ieee ieeetran",
    venues: ["S&P", "EuroS&P", "NDSS", "CSFW", "DSN", "INFOCOM", "ICC", "GLOBECOM", "WCNC", "ICDE", "ICDM", "ICRA", "IROS", "ICSE", "ASE", "ICSME", "SANER", "ICST", "ISSRE", "ICDCS", "IPDPS", "CLUSTER", "BigData", "TrustCom", "CNS", "SECON", "PerCom", "ISIT", "BIBM", "COMPSAC", "ICWS", "IWQoS", "LCN", "WoWMoM", "NOMS", "ICCCN", "ICNP", "QRS", "APSEC"],
  },
  {
    id: "lncs", name: "Springer LNCS", category: "Conference", detail: "llncs · Lecture Notes in Computer Science",
    keywords: "springer lncs llncs iacr",
    venues: ["ESORICS", "ACNS", "CRYPTO", "EUROCRYPT", "ASIACRYPT", "PKC", "TCC", "FC", "CT-RSA", "INDOCRYPT", "ISC", "ICICS", "ACISP", "INSCRYPT", "SecureComm", "MICCAI", "ECML-PKDD", "ISWC", "ESWC", "CAV", "TACAS", "ECIR", "DASFAA", "DEXA", "ER", "CAiSE", "ICSOC", "FM", "ATVA", "SETTA", "ICFEM", "APLAS", "VMCAI", "SAS", "RV", "Euro-Par", "ICANN", "PRICAI", "PAKDD", "WISE", "KSEM", "NLPCC", "PRCV", "MMM"],
  },
  { id: "usenix", name: "USENIX", category: "Conference", detail: "Official usenix-2020-09 style", kit: { source: "usenix.org" }, venues: ["USENIX Security", "OSDI", "NSDI", "FAST", "SOUPS"], keywords: "usenix security" },
  { id: "neurips", name: "NeurIPS 2025", category: "Conference", detail: "Official neurips_2025 style", kit: { source: "neurips.cc" }, venues: ["NeurIPS"], keywords: "nips machine learning" },
  { id: "icml", name: "ICML 2025", category: "Conference", detail: "Official icml2025 style", kit: { source: "icml.cc" }, venues: ["ICML"], keywords: "machine learning" },
  { id: "iclr", name: "ICLR 2026", category: "Conference", detail: "Official iclr2026 style", kit: { source: "github.com/ICLR" }, venues: ["ICLR"], keywords: "machine learning representation" },
  { id: "acl", name: "ACL (*ACL)", category: "Conference", detail: "Official acl.sty, review mode", kit: { source: "github.com/acl-org" }, venues: ["ACL", "EMNLP", "NAACL", "EACL", "CoNLL", "IJCNLP"], keywords: "nlp emnlp naacl arr" },
  { id: "cvpr", name: "CVPR", category: "Conference", detail: "Official CVPR author kit, review mode", kit: { source: "github.com/cvpr-org" }, venues: ["CVPR"], keywords: "computer vision" },

  // Journals
  { id: "ieee-journal", name: "IEEE Transactions", category: "Journal", detail: "IEEEtran · journal", keywords: "ieee journal transactions tifs tdsc tpami" },
  { id: "acm-journal", name: "ACM Journal", category: "Journal", detail: "acmart · acmsmall (TOPS, CSUR, PACM)", venues: ["CSCW"], keywords: "acm journal tops pacm acmsmall" },
  { id: "elsevier", name: "Elsevier", category: "Journal", detail: "elsarticle (Computers & Security…)", keywords: "elsevier elsarticle journal" },
  { id: "revtex", name: "APS Physics", category: "Journal", detail: "REVTeX 4.2 · Physical Review", keywords: "physics aps revtex prl" },
  { id: "amsart", name: "AMS Math", category: "Journal", detail: "amsart with theorem environments", keywords: "math ams theorem" },

  // Slides
  { id: "beamer-metropolis", name: "Metropolis", category: "Slides", detail: "Modern, flat beamer theme", shape: "slide", keywords: "beamer presentation talk slides" },
  { id: "beamer-simple", name: "Clean", category: "Slides", detail: "Minimal white slides, big type", shape: "slide", keywords: "beamer presentation talk slides minimal" },
  { id: "beamer-madrid", name: "Madrid", category: "Slides", detail: "Classic academic beamer", shape: "slide", beside: "beamer", keywords: "beamer presentation talk slides" },

  // Posters
  { id: "tikzposter", name: "Landscape Poster", category: "Poster", detail: "tikzposter · A0 landscape", shape: "poster", beside: "poster", keywords: "poster a0" },
  { id: "beamerposter", name: "Portrait Poster", category: "Poster", detail: "beamerposter · A0 portrait", keywords: "poster a0 portrait" },

  // Thesis & reports
  { id: "thesis", name: "Thesis", category: "Thesis & reports", detail: "Chapters, front matter, bibliography", keywords: "phd master dissertation book" },
  { id: "tech-report", name: "Technical Report", category: "Thesis & reports", detail: "Title page and contents", keywords: "report whitepaper" },
  { id: "tufte", name: "Tufte Handout", category: "Thesis & reports", detail: "Wide margins for side notes", keywords: "handout notes lecture" },

  // Letters & CV
  { id: "cover-letter", name: "Cover Letter", category: "Letters & CV", detail: "To an editor or program chair", beside: "letter", keywords: "letter editor submission" },
  { id: "rebuttal", name: "Response to Reviewers", category: "Letters & CV", detail: "Point-by-point reply", keywords: "rebuttal revision reviewers response" },
  { id: "cv", name: "Academic CV", category: "Letters & CV", detail: "moderncv · classic", keywords: "cv resume moderncv" },
];

export const templateById = (id: string) => TEMPLATES.find((t) => t.id === id);

/** The template a conference uses, by its name in the deadline list. */
export function templateForVenue(venue: string): TemplateInfo | undefined {
  const v = venue.trim().toLowerCase();
  return TEMPLATES.find((t) => t.venues?.some((x) => x.toLowerCase() === v));
}

/** An upcoming (or the latest) edition of a conference, from the public deadline list. */
export interface ConferenceEdition {
  /** Short name, e.g. "CCS". */
  name: string;
  description: string;
  year: number;
  /** Next submission deadline as an ISO instant, or null when not announced. */
  deadline: string | null;
  abstractDeadline?: string | null;
  /** What the deadline is, e.g. "Cycle A" (when there are several). */
  round?: string;
  /** Timezone the venue states the deadline in, e.g. "AoE". */
  timezone?: string;
  date?: string;
  place?: string;
  link?: string;
  /** Research area, e.g. "Security". */
  area?: string;
  rank?: string;
  /** Matching template id, if we know the venue's format. */
  template?: string;
}

/** What a project is written for, shown on its card. */
export interface ProjectVenue {
  name: string;
  year?: number;
  deadline?: string | null;
  link?: string;
}
