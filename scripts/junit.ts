// Minimal parser for the JUnit XML `deno test --reporter=junit` writes to
// stdout. Deno owns the exact shape (checked against a live 2.9.5 run), so a
// small tailored scanner is simpler and more robust than pulling in a general
// XML dependency for a handful of known tags.

export type JunitCase = {
  name: string;
  ms: number;
  failureMessage: string | null;
  failureBody: string | null;
};

export type JunitSuite = {
  file: string;
  cases: JunitCase[];
};

export type JunitReport = {
  wallMs: number;
  suites: JunitSuite[];
};

const unescapeXml = (s: string): string =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

const attr = (tag: string, name: string): string | null => {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`));
  return m ? unescapeXml(m[1]!) : null;
};

// `deno test` always tacks a bare "error: Test failed" onto stderr when the
// run exits non-zero — pure boilerplate once we've already rendered the
// failures ourselves from the JUnit report. Strip only that exact trailing
// line so a real crash/import-error trace underneath it still gets through.
export const stripTrailingTestFailedNotice = (stderr: string): string =>
  stderr.replace(/(?:\r?\n)?error: Test failed\r?\n?$/, "");

export const parseJunit = (xml: string): JunitReport => {
  const rootMatch = xml.match(/<testsuites\b[^>]*>/);
  const wallMs = rootMatch ? Number(attr(rootMatch[0], "time") ?? "0") * 1000 : 0;

  const suites: JunitSuite[] = [];
  const suiteRe = /<testsuite\b([^>]*)>([\s\S]*?)<\/testsuite>/g;
  for (const suiteMatch of xml.matchAll(suiteRe)) {
    const suiteAttrs = suiteMatch[1]!;
    const body = suiteMatch[2]!;
    const file = attr(`<x ${suiteAttrs}>`, "name") ?? "";

    const cases: JunitCase[] = [];
    const caseRe = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
    for (const caseMatch of body.matchAll(caseRe)) {
      const caseAttrs = caseMatch[1]!;
      const inner = caseMatch[2] ?? "";
      const name = attr(`<x ${caseAttrs}>`, "name") ?? "";
      const ms = Number(attr(`<x ${caseAttrs}>`, "time") ?? "0") * 1000;

      const failMatch = inner.match(/<failure\b([^>]*)>([\s\S]*?)<\/failure>/);
      const failureMessage = failMatch ? attr(`<x ${failMatch[1]}>`, "message") : null;
      const failureBody = failMatch ? unescapeXml(failMatch[2]!.trim()) : null;

      cases.push({ name, ms, failureMessage, failureBody });
    }
    suites.push({ file, cases });
  }

  return { wallMs, suites };
};
