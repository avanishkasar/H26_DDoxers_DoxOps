import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runProcess } from "../runner";

const env = { ...process.env };

function captured(): { sink: { append(t: string): void }; text(): string } {
  let all = "";
  return { sink: { append: (t: string) => (all += t) }, text: () => all };
}

describe("runProcess streaming", () => {
  it("keeps multi-byte characters split across chunks intact", async () => {
    const script =
      "const b = Buffer.from('risk table \\u2500\\u2502 done\\n', 'utf8');" +
      "process.stdout.write(b.subarray(0, 12));" +
      "setTimeout(() => process.stdout.write(b.subarray(12)), 150);";
    const out = captured();
    const result = await runProcess(process.execPath, ["-e", script], { cwd: process.cwd(), env, output: out.sink });
    assert.equal(result.code, 0);
    assert.equal(out.text(), "risk table ─│ done\n");
    assert.equal(result.stdout, "risk table ─│ done\n");
  });

  it("redacts a secret written in two parts", async () => {
    const key = "AIzaSyExampleKey0123456789";
    const script =
      `process.stderr.write('using ${key.slice(0, 9)}');` +
      `setTimeout(() => process.stderr.write('${key.slice(9)} now\\n'), 150);`;
    const out = captured();
    const lines: string[] = [];
    const result = await runProcess(process.execPath, ["-e", script], {
      cwd: process.cwd(),
      env,
      output: out.sink,
      secrets: [key],
      onLine: (l) => lines.push(l),
    });
    assert.equal(result.code, 0);
    assert.equal(out.text().includes(key), false);
    assert.equal(out.text(), "using *** now\n");
    assert.equal(result.stderr, "using *** now\n");
    assert.deepEqual(lines, ["using *** now"]);
  });
});
