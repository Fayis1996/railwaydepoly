const puppeteer = require('puppeteer');

async function scrapeRoute(trainNo) {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`https://www.confirmtkt.com/train-schedule/${trainNo}`, { waitUntil: 'networkidle2' });
  
  const route = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.train-schedule-table tbody tr'));
    const data = [];
    let seq = 1;
    for (const row of rows) {
      const cells = row.querySelectorAll('td');
      if (cells.length > 2) {
        let code = cells[0].innerText.trim();
        code = code.split('\\n')[0].split('(').pop().replace(')', '').trim();
        let name = cells[0].innerText.trim().split('\\n')[0].split('(')[0].trim();
        
        if (code && name) {
          data.push({ sequence: seq++, code, name });
        }
      }
    }
    return data;
  });
  
  console.log(JSON.stringify(route, null, 2));
  await browser.close();
}

scrapeRoute('12617').catch(console.error);
