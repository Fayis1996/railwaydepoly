const cheerio = require('cheerio');
const fs = require('fs');

async function test() {
  const html = fs.readFileSync('/tmp/confirmtkt.html', 'utf8');
  const $ = cheerio.load(html);
  const data = [];
  let seq = 1;

  $('.rs-table-row').each((i, el) => {
    // wait, what is the structure?
    // Let's print the classes of rows to see what exists
  });
  
  // Actually, I can just look for the anchor tags containing /station/
  $('a[href^="/station/"]').each((i, el) => {
    const text = $(el).text().trim();
    if (text.includes('-')) {
      const parts = text.split('-');
      if (parts.length >= 2) {
        const code = parts[parts.length - 1].trim();
        const name = parts.slice(0, parts.length - 1).join('-').trim();
        if (code === code.toUpperCase() && code.length >= 2) {
          // Avoid duplicates
          if (!data.find(d => d.code === code)) {
            data.push({ sequence: seq++, code, name });
          }
        }
      }
    }
  });

  console.log(JSON.stringify(data, null, 2));
}

test();
