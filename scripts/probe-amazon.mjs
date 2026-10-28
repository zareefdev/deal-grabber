const QUERIES = ['laptop', 'smartphone', 'wireless earbuds', 'smart tv'];
const UA_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const UA_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';

async function probe(label, url, ua) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(25000),
      headers: {
        'User-Agent': ua,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-IN,en-US;q=0.9,en;q=0.8'
      }
    });
    const html = await res.text();
    const cards = (html.match(/data-asin="[A-Z0-9]{10}"/g) || []).length;
    const captcha = /captcha|Enter the characters/i.test(html);
    const robotic = /are you a robot|api-services-support@amazon/i.test(html);
    console.log(`${label} ${res.status} len=${html.length} cards=${cards} captcha=${captcha} robot=${robotic}`);
  } catch (err) {
    console.log(`${label} ERR ${err.message}`);
  }
}

for (const q of QUERIES) {
  await probe(`chrome  s?k=${q}`, `https://www.amazon.in/s?k=${encodeURIComponent(q)}`, UA_CHROME);
  await new Promise(r => setTimeout(r, 2500));
}
await probe('safari  s?k=laptop', `https://www.amazon.in/s?k=laptop`, UA_SAFARI);
await probe('deals   /deals', 'https://www.amazon.in/deals', UA_CHROME);
await probe('goldbox /gp/goldbox', 'https://www.amazon.in/gp/goldbox', UA_CHROME);
