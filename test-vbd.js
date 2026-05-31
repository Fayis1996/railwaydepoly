import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  
  await page.goto('https://www.irctc.co.in/online-charts/', { waitUntil: 'networkidle2' });
  
  await page.waitForFunction(() => document.body.innerText.includes('Vacant Berth') || document.body.innerText.includes('Chart Not Prepared'), { timeout: 15000 }).catch(e => console.log(e));
  
  const text = await page.evaluate(() => document.body.innerText);
  const html = await page.evaluate(() => document.body.innerHTML);
  
  require('fs').writeFileSync('irctc_innerText.txt', text);
  require('fs').writeFileSync('irctc_dom.html', html);
  console.log("Dumped to irctc_innerText.txt and irctc_dom.html");
  
  await browser.close();
})();
