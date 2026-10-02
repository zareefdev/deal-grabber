import fs from 'node:fs';

const pages = ['index', 'mobiles', 'laptops', 'electronics', 'amazon', 'flipkart',
  'under-5000', 'under-10000', 'under-25000', 'over-50000'];

let bad = 0;
for (const p of pages) {
  const f = `public/${p === 'index' ? 'index.html' : `${p}/index.html`}`;
  const html = fs.readFileSync(f, 'utf8');
  for (const x of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    let j;
    try { j = JSON.parse(x[1]); } catch { console.log(p, 'INVALID JSON'); bad++; continue; }
    const nodes = j['@graph'] || [j];
    const faq = nodes.find(n => n && n['@type'] === 'FAQPage');
    if (!faq) continue;
    const emptySchema = faq.mainEntity.filter(q => {
      const t = q.acceptedAnswer && q.acceptedAnswer.text;
      return !t || String(t).trim().length < 15;
    });
    // Only the FAQ list counts: the stats strip is also a <dl>, and its values are
    // legitimately short ("89", "₹7,999").
    const faqList = html.match(/<dl>(?:(?!<\/dl>)[\s\S])*?<\/dl>/g) || [];
    const visible = [];
    for (const dl of faqList) {
      for (const m of dl.matchAll(/<dt>([^<]*)<\/dt><dd>([^<]*)<\/dd>/g)) visible.push(m);
    }
    const emptyVisible = visible.filter(m => m[2].trim().length < 15);
    if (emptySchema.length || emptyVisible.length) {
      bad++;
      console.log(p, 'EMPTY schema:', emptySchema.length, 'empty visible:', emptyVisible.length);
    } else {
      console.log(p.padEnd(12), 'questions:', faq.mainEntity.length, 'visible:', visible.length, 'all answers present');
    }
  }
}
console.log(bad ? 'FAIL' : 'ALL FAQ OK');
process.exitCode = bad ? 1 : 0;
