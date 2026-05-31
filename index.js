import express from 'express';
import cors from 'cors';
import fs from 'fs';
import * as cheerio from 'cheerio';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import OpenAI from 'openai';

puppeteer.use(StealthPlugin());

const app = express();
app.use(cors());

// --- DEEPSEEK ROUTE ENGINE ---
const routeCache = {};
const openai = new OpenAI({
  baseURL: 'https://api.deepseek.com',
  apiKey: 'sk-62dd4f93aa9844199c1a71acce35c911'
});

app.get('/api/route', async (req, res) => {
  const { trainNo, from, to } = req.query;
  if (!trainNo) {
    return res.status(400).json({ error: 'trainNo query parameter is required' });
  }

  // Use composite cache key in case they search different segments and we need to re-fetch
  const cacheKey = `${trainNo}-${from}-${to}`;
  if (routeCache[cacheKey]) {
    console.log(`Cache hit for train route ${cacheKey}`);
    return res.json({ success: true, data: routeCache[cacheKey] });
  }

  try {
    let routesDb = {};
    try { routesDb = JSON.parse(fs.readFileSync('./routes.json', 'utf8')); } catch(e) {}
    
    if (routesDb[trainNo]) {
      const trainData = {
        number: trainNo,
        name: routesDb[trainNo].name || `Train ${trainNo}`,
        route: routesDb[trainNo].route || routesDb[trainNo]
      };
      routeCache[cacheKey] = trainData;
      return res.json({ success: true, data: trainData });
    }
    
    let routeData = [];
    let trainName = `Train ${trainNo}`;

    // --- Source 1: Try erail.in (reliable, no JS needed) ---
    try {
      console.log(`Trying erail.in for train ${trainNo}...`);
      const erailRes = await fetch(`https://erail.in/rail/getTrains.aspx?TrainNo=${trainNo}&DataSource=0&Language=0&Cache=true`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });
      const erailText = await erailRes.text();
      // erail returns pipe-separated data: trainNo|trainName|...|stations
      if (erailText && erailText.includes('|')) {
        const lines = erailText.split('~');
        for (const line of lines) {
          const parts = line.split('^');
          if (parts.length > 2) {
            const stationCode = parts[1]?.trim();
            const stationName = parts[2]?.trim();
            if (stationCode && stationName && stationCode.length >= 2 && stationCode === stationCode.toUpperCase()) {
              if (!routeData.find(d => d.code === stationCode)) {
                routeData.push({ sequence: routeData.length + 1, code: stationCode, name: stationName });
              }
            }
          }
        }
      }
    } catch(e) { console.log('erail failed:', e.message); }

    // --- Source 2: Try ConfirmTkt (if erail failed) ---
    if (routeData.length === 0) {
      try {
        console.log(`Trying ConfirmTkt for train ${trainNo}...`);
        const routeRes = await fetch(`https://www.confirmtkt.com/train-schedule/${trainNo}`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        const html = await routeRes.text();
        const $ = cheerio.load(html);
        let seq = 1;
        $('a[href^="/station/"]').each((i, el) => {
          const text = $(el).text().trim();
          if (text.includes('-')) {
            const parts = text.split('-');
            if (parts.length >= 2) {
              const code = parts[parts.length - 1].trim();
              const name = parts.slice(0, parts.length - 1).join('-').trim();
              if (code === code.toUpperCase() && code.length >= 2) {
                if (!routeData.find(d => d.code === code)) {
                  routeData.push({ sequence: seq++, code, name });
                }
              }
            }
          }
        });
      } catch(e) { console.log('ConfirmTkt failed:', e.message); }
    }

    // --- Source 3: Try RailYatri API (if both above failed) ---
    if (routeData.length === 0) {
      try {
        console.log(`Trying RailYatri API for train ${trainNo}...`);
        const ryRes = await fetch(`https://www.railyatri.in/api/pnr_status/train_schedule/?train_number=${trainNo}`, {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
        });
        const ryJson = await ryRes.json();
        if (ryJson && ryJson.data && Array.isArray(ryJson.data)) {
          trainName = ryJson.train_name || trainName;
          ryJson.data.forEach((st, idx) => {
            const code = st.station_code || st.stn_code;
            const name = st.station_name || st.stn_name;
            if (code && name) {
              routeData.push({ sequence: idx + 1, code: code.toUpperCase(), name });
            }
          });
        }
      } catch(e) { console.log('RailYatri failed:', e.message); }
    }

    if (routeData.length === 0) {
      return res.status(404).json({ success: false, error: `Train route for ${trainNo} not found. Please add it to routes.json.` });
    }
    
    // Save to routes.json for next time (persistent cache)
    try {
      routesDb[trainNo] = { name: trainName, route: routeData };
      fs.writeFileSync('./routes.json', JSON.stringify(routesDb, null, 2));
      console.log(`Saved route for train ${trainNo} to routes.json`);
    } catch(e) { console.log('Could not save to routes.json:', e.message); }

    const trainData = { number: trainNo, name: trainName, route: routeData };
    routeCache[cacheKey] = trainData;
    res.json({ success: true, data: trainData });

  } catch (error) {
    console.error("Route Fetch Error:", error);
    res.status(500).json({ success: false, error: 'Failed to generate train route.' });
  }
});

// --- THE REAL SCRAPER ENDPOINT ---
app.get('/api/chart', async (req, res) => {
  const { trainNo, boardingStation = '', destinationStation = '', classType = 'SL' } = req.query;
  if (!trainNo) {
    return res.status(400).json({ error: 'trainNo query parameter is required' });
  }

  let browser;
  try {
    const PROXY_HOST = process.env.PROXY_HOST || 'brd.superproxy.io';
    const PROXY_PORT = process.env.PROXY_PORT || '33335';
    const PROXY_USERNAME = process.env.PROXY_USERNAME || 'brd-customer-hl_7697c697-zone-residential_proxy1';
    const PROXY_PASSWORD = process.env.PROXY_PASSWORD || '12jekm7cm99f';

    const useProxy = !!PROXY_HOST && !!PROXY_USERNAME;

    console.log(`Starting extraction for train: ${trainNo}, station: ${boardingStation} -> ${destinationStation}, class: ${classType}`);
    const launchArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-extensions',
      '--disable-http2',
      '--window-size=1280,800',
      '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    ];

    if (useProxy) {
      console.log(`Routing through proxy: ${PROXY_HOST}:${PROXY_PORT}`);
      launchArgs.push(`--proxy-server=http://${PROXY_HOST}:${PROXY_PORT}`);
      launchArgs.push('--ignore-certificate-errors');
    }

    const launchOptions = {
      headless: true,
      slowMo: 0,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable',
      args: launchArgs
    };

    browser = await puppeteer.launch(launchOptions);
    const page = await browser.newPage();

    if (useProxy) {
      console.log("Authenticating proxy session...");
      await page.authenticate({
        username: PROXY_USERNAME,
        password: PROXY_PASSWORD
      });
    }
    
    // Set a realistic viewport
    await page.setViewport({ width: 1280, height: 800 });

    // Spoof realistic browser headers to avoid bot detection
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-IN,en;q=0.9,hi;q=0.8',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'max-age=0',
      'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Upgrade-Insecure-Requests': '1'
    });

    // Override WebDriver detection (makes headless Chrome look real)
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-IN', 'en'] });
      window.chrome = { runtime: {} };
    });

    // Set up a listener to intercept the JSON API response from IRCTC
    let interceptedData = null;
    let interceptedDetails = []; // To hold detailed berth data (vbd)
    
    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('api')) {
        console.log(`INTERCEPTED API URL: ${url}`);
      }
      if (url.includes('online-charts') && url.includes('api')) {
        try {
          const contentType = response.headers()['content-type'];
          if (contentType && contentType.includes('application/json')) {
            const json = await response.json();
            
            // 1. Intercept Summary Data (cdd)
            if (json && Object.keys(json).length > 2 && !url.includes('vacantberth')) {
              interceptedData = json;
              console.log("Successfully intercepted IRCTC summary data!");
            }
            
            // 2. Intercept Detailed Berth Data (vbd)
            if (json && json.vbd) {
              interceptedDetails.push(...json.vbd);
              console.log(`Intercepted ${json.vbd.length} detailed berth records!`);
            }
          }
        } catch (e) {
          // Ignore parsing errors
        }
      }
    });

    console.log("Navigating to portal...");
    await page.goto('https://www.irctc.co.in/online-charts/', { waitUntil: 'domcontentloaded', timeout: 60000 });

    console.log("Automating UI...");
    // 1. Enter Train Number - wait for field and log all input info
    await page.waitForSelector('input[type="text"]', { timeout: 20000 });
    await new Promise(r => setTimeout(r, 1500));

    // Log all inputs for debugging
    const inputCount = await page.evaluate(() => {
      const inputs = document.querySelectorAll('input[type="text"]');
      console.log('Input count:', inputs.length);
      inputs.forEach((inp, i) => console.log(`Input[${i}]: placeholder="${inp.placeholder}" id="${inp.id}" name="${inp.name}" value="${inp.value}"`));
      return inputs.length;
    });
    console.log(`Found ${inputCount} text inputs on page`);

    // Focus first input (train number) and type
    await page.evaluate(() => {
      const inputs = document.querySelectorAll('input[type="text"]');
      if (inputs.length > 0) inputs[0].focus();
    });
    await page.keyboard.type(trainNo, { delay: 120 });

    // Wait for autocomplete dropdown
    await new Promise(r => setTimeout(r, 3500));
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    // Wait longer for page to re-render after train selection
    await new Promise(r => setTimeout(r, 3000));

    // 2. Enter Boarding Station - re-detect inputs after page re-render
    if (boardingStation) {
      // Log updated inputs after train selection
      const updatedInputCount = await page.evaluate(() => {
        const inputs = document.querySelectorAll('input[type="text"]');
        console.log('Updated input count after train selection:', inputs.length);
        inputs.forEach((inp, i) => console.log(`Input[${i}]: placeholder="${inp.placeholder}" id="${inp.id}" name="${inp.name}" value="${inp.value}"`));
        return inputs.length;
      });
      console.log(`After train selection: ${updatedInputCount} text inputs`);

      // Try to find boarding station input by placeholder text
      const foundBoarding = await page.evaluate((station) => {
        const inputs = Array.from(document.querySelectorAll('input[type="text"]'));
        // Find input that appears to be for boarding station (not already filled with train name)
        let target = inputs.find(inp => inp.placeholder && 
          (inp.placeholder.toLowerCase().includes('boarding') || inp.placeholder.toLowerCase().includes('from') || inp.placeholder.toLowerCase().includes('station')));
        // Fallback to index 2 if no placeholder match
        if (!target && inputs.length > 2) target = inputs[2];
        if (target) {
          target.focus();
          return true;
        }
        return false;
      }, boardingStation);

      if (foundBoarding) {
        // Clear and type boarding station
        await page.keyboard.down('Control');
        await page.keyboard.press('A');
        await page.keyboard.up('Control');
        await page.keyboard.press('Backspace');
        await page.keyboard.type(boardingStation, { delay: 120 });
        await new Promise(r => setTimeout(r, 3500));
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
        await new Promise(r => setTimeout(r, 2000));
      } else {
        console.log('Could not find boarding station input!');
      }
    }

    // 3. Click the "Get Train Chart" button
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const submitBtn = buttons.find(b => b.textContent.includes('Get Train Chart') || b.textContent.includes('Chart'));
      if (submitBtn) submitBtn.click();
    });

    console.log("Waiting for summary page to load...");
    await page.waitForFunction(
      () => document.body.innerText.includes('Vacant Berth') || document.body.innerText.includes('Chart Not Prepared') || document.body.innerText.includes('No Vacant'),
      { timeout: 15000 }
    ).catch(() => console.log("Timeout waiting for UI update..."));
    
    // 4. Select Destination Station on the summary page
    if (destinationStation) {
      console.log(`Setting Destination Station to ${destinationStation} on summary page...`);
      await new Promise(r => setTimeout(r, 2000));
      
      try {
        // Find input dynamically
        const placeholderSelector = 'input[placeholder*="Journey To"], input[placeholder*="Destination"]';
        const hasPlaceholderInput = await page.$(placeholderSelector);
        
        if (hasPlaceholderInput) {
          await page.focus(placeholderSelector);
          await page.keyboard.down('Control');
          await page.keyboard.press('A');
          await page.keyboard.up('Control');
          await page.keyboard.press('Backspace');
          
          await page.keyboard.type(destinationStation, { delay: 100 });
          await new Promise(r => setTimeout(r, 2500));
          await page.keyboard.press('ArrowDown');
          await page.keyboard.press('Enter');
          await new Promise(r => setTimeout(r, 3000));
        } else {
          // Fallback using direct query selector evaluation
          await page.evaluate(() => {
            const allInputs = document.querySelectorAll('input');
            if (allInputs.length >= 4) {
              allInputs[3].focus();
            }
          });
          await page.keyboard.down('Control');
          await page.keyboard.press('A');
          await page.keyboard.up('Control');
          await page.keyboard.press('Backspace');
          
          await page.keyboard.type(destinationStation, { delay: 100 });
          await new Promise(r => setTimeout(r, 2500));
          await page.keyboard.press('ArrowDown');
          await page.keyboard.press('Enter');
          await new Promise(r => setTimeout(r, 3000));
        }
      } catch (e) {
        console.log("Could not set destination station: ", e);
      }
    }

      // DEBUG: Save a screenshot and DOM unconditionally
      await page.screenshot({ path: 'irctc_debug.png', fullPage: true });
      try {
        const domText = await page.evaluate(() => document.body.innerText);
        const domHtml = await page.evaluate(() => document.body.innerHTML);
        fs.writeFileSync('irctc_innerText.txt', domText);
        fs.writeFileSync('irctc_dom.html', domHtml);
        console.log("Saved irctc_dom.html unconditionally");
      } catch(e) {
        console.log("Failed to save dom", e);
      }

    // 5. Deep-Scraping: Try to click the specific Class tab to trigger detailed vbd endpoints!
    if (interceptedData) {
      console.log(`Deep scraping detailed berths for class ${classType}...`);
      await new Promise(r => setTimeout(r, 2000)); // wait for UI to render summary
      
      const domScrapedBerths = await page.evaluate(async (targetCls) => {
        // Find the index of the column for the target class
        const ths = Array.from(document.querySelectorAll('thead tr:last-child th'));
        let targetIndex = -1;
        for (let i = 0; i < ths.length; i++) {
          if (ths[i].textContent.includes(targetCls) || (targetCls === 'SL' && ths[i].textContent.includes('SLEEPER'))) {
            targetIndex = i;
            break;
          }
        }
        
        let scraped = [];
        let seenBerths = new Set();
        let debugInfo = `Target column index for ${targetCls}: ${targetIndex}`;

        if (targetIndex !== -1) {
          const tbody = document.querySelector('tbody');
          if (tbody) {
            // Find the <tr> that contains the Berth Details links (usually the first one)
            const tr = tbody.querySelector('tr');
            if (tr) {
              const tds = Array.from(tr.querySelectorAll('td'));
              if (tds.length > targetIndex) {
                const targetTd = tds[targetIndex];
                // The link is either an <a> or a <span style="cursor: pointer">
                const link = targetTd.querySelector('span') || targetTd.querySelector('a') || targetTd;
                if (link && link.textContent.includes('Berth Details')) {
                  try {
                    link.click();
                    await new Promise(r => setTimeout(r, 2000));
                  } catch(e) {}
                }
              }
            }
          }
        }


          return { scraped, debugInfo };
        }, classType);
        
        console.log(`DOM Debug Info: ${domScrapedBerths.debugInfo}`);
        console.log(`DOM Scraped ${domScrapedBerths.scraped.length} berths directly from tables!`);
        
        // If the network interception successfully grabbed the raw JSON (which ignores pagination), use it!
        if (interceptedDetails.length > 0) {
          console.log(`Using ${interceptedDetails.length} JSON Intercepted berths instead of DOM to avoid pagination limits.`);
        } else {
          interceptedDetails = domScrapedBerths.scraped;
        }
      }

    await browser.close();

    if (interceptedData) {
      // Send BOTH summary and detailed data to the frontend
      res.json({ success: true, data: interceptedData, detailedBerths: interceptedDetails });
    } else {
      res.status(404).json({ 
        success: false, 
        error: "Could not extract chart data. The IRCTC UI might have changed, or no chart is prepared for this train." 
      });
    }

  } catch (error) {
    console.error(error);
    if (browser) await browser.close();
    res.status(500).json({ success: false, error: error.message });
  }
});


app.get('/api/test-scrape', async (req, res) => {
  let browser;
  try {
    const PROXY_HOST = process.env.PROXY_HOST || 'brd.superproxy.io';
    const PROXY_PORT = process.env.PROXY_PORT || '33335';
    const PROXY_USERNAME = process.env.PROXY_USERNAME || 'brd-customer-hl_7697c697-zone-residential_proxy1';
    const PROXY_PASSWORD = process.env.PROXY_PASSWORD || '12jekm7cm99f';

    const useProxy = !!PROXY_HOST && !!PROXY_USERNAME;
    const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox'];

    if (useProxy) {
      launchArgs.push(`--proxy-server=http://${PROXY_HOST}:${PROXY_PORT}`);
      launchArgs.push('--ignore-certificate-errors');
    }

    const launchOptions = {
      headless: true,
      args: launchArgs
    };
    if (process.env.RENDER) launchOptions.executablePath = '/usr/bin/google-chrome';

    browser = await puppeteer.launch(launchOptions);
    const page = await browser.newPage();

    if (useProxy) {
      await page.authenticate({
        username: PROXY_USERNAME,
        password: PROXY_PASSWORD
      });
    }

    await page.goto('https://www.irctc.co.in/online-charts/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('body', { timeout: 15000 });
    const title = await page.title();
    await browser.close();
    res.json({ success: true, message: "Successfully loaded IRCTC portal using proxy!", title });
  } catch (error) {
    if (browser) await browser.close();
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`GapSeat Data Proxy running on port ${PORT}`);
});
