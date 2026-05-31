const cheerio = require('cheerio');

async function getTrainRoute(trainNo) {
  try {
    const res = await fetch(`https://www.confirmtkt.com/train-schedule/${trainNo}`);
    const html = await res.text();
    const $ = cheerio.load(html);
    const data = [];
    let seq = 1;

    $('a[href^="/station/"]').each((i, el) => {
      const text = $(el).text().trim();
      if (text.includes('-')) {
        const parts = text.split('-');
        if (parts.length >= 2) {
          const code = parts[parts.length - 1].trim();
          const name = parts.slice(0, parts.length - 1).join('-').trim();
          if (code === code.toUpperCase() && code.length >= 2) {
            if (!data.find(d => d.code === code)) {
              data.push({ sequence: seq++, code, name });
            }
          }
        }
      }
    });

    console.log(data.length > 0 ? "SUCCESS" : "FAILED", data.length);
  } catch(e) {
    console.error(e);
  }
}

getTrainRoute('12617');
