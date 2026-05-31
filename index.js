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
    const routesDb = JSON.parse(fs.readFileSync('./routes.json', 'utf8'));
    if (routesDb[trainNo]) {
      const trainData = {
        number: trainNo,
        name: `Train ${trainNo}`,
        route: routesDb[trainNo]
      };
      routeCache[cacheKey] = trainData;
      return res.json({ success: true, data: trainData });
    }
    
    // Fallback if not found in routes.json
    console.log(`Scraping real train route for train ${trainNo} from ConfirmTkt...`);
    const routeRes = await fetch(`https://www.confirmtkt.com/train-schedule/${trainNo}`);
    const html = await routeRes.text();
    const $ = cheerio.load(html);
    const routeData = [];
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

    if (routeData.length === 0) {
      return res.status(404).json({ success: false, error: 'Train route not found.' });
    }
    
    // Store in cache
    const trainData = {
      number: trainNo,
      name: `Train ${trainNo}`,
      route: routeData
    };
    
    routeCache[cacheKey] = trainData;
    
    res.json({ success: true, data: trainData });
  } catch (error) {
    console.error("AI Route Fetch Error:", error);
    res.status(500).json({ success: false, error: 'Failed to generate train route via AI.' });
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
    console.log(`Starting extraction for train: ${trainNo}, station: ${boardingStation} -> ${destinationStation}, class: ${classType}`);
    const launchOptions = {
      headless: false,
      slowMo: 50,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    };
    
    if (process.env.RENDER) {
      launchOptions.executablePath = '/usr/bin/google-chrome';
    }

    browser = await puppeteer.launch(launchOptions);
    const page = await browser.newPage();
    
    // Set a realistic viewport
    await page.setViewport({ width: 1280, height: 800 });

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
    await page.goto('https://www.irctc.co.in/online-charts/', { waitUntil: 'networkidle2', timeout: 60000 });
    
    console.log("Automating UI...");
    // 1. Find all text inputs (Train Name, Date, Boarding Station)
    const inputs = await page.$$('input[type="text"]');
    if (inputs.length > 0) {
      // Click the first input (Train Number)
      await inputs[0].click();
      await page.keyboard.type(trainNo, { delay: 100 });
      
      // Wait for the dropdown options to appear (API call) and press Enter
      await new Promise(r => setTimeout(r, 2500));
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      
      await new Promise(r => setTimeout(r, 1500));
      
      // 2. Select Boarding Station
      if (inputs.length > 2 && boardingStation) {
        await inputs[2].click();
        await page.keyboard.type(boardingStation, { delay: 100 });
        await new Promise(r => setTimeout(r, 2500));
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
      }

      await new Promise(r => setTimeout(r, 1000));

      // 3. Click the "Get Train Chart" button
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const submitBtn = buttons.find(b => b.textContent.includes('Get Train Chart') || b.textContent.includes('Chart'));
        if (submitBtn) submitBtn.click();
      });
    }

    console.log("Waiting for summary page to load...");
      await page.waitForFunction(
        () => document.body.innerText.includes('Vacant Berth') || document.body.innerText.includes('Chart Not Prepared') || document.body.innerText.includes('No Vacant'),
        { timeout: 15000 }
      ).catch(() => console.log("Timeout waiting for UI update..."));
      
      // 4. Select Destination Station on the summary page
      if (destinationStation) {
        console.log(`Setting Destination Station to ${destinationStation} on summary page...`);
        // Better way: use Puppeteer to type into the Journey To box
        // The placeholder is usually "Journey To"
        try {
          const destInput = await page.$('input[placeholder*="Journey To"], input[placeholder*="Destination"]');
          if (destInput) {
            await destInput.click();
            // Clear existing
            await page.keyboard.down('Control');
            await page.keyboard.press('A');
            await page.keyboard.up('Control');
            await page.keyboard.press('Backspace');
            
            await page.keyboard.type(destinationStation, { delay: 100 });
            await new Promise(r => setTimeout(r, 2000));
            await page.keyboard.press('ArrowDown');
            await page.keyboard.press('Enter');
            console.log("Selected Destination, waiting for UI to update...");
            await new Promise(r => setTimeout(r, 3000)); // wait for network reload
          } else {
             // Fallback: Just try to click the 4th input
             const allInputs = await page.$$('input');
             if (allInputs.length >= 4) {
               await allInputs[3].click();
               await page.keyboard.down('Control'); await page.keyboard.press('A'); await page.keyboard.up('Control'); await page.keyboard.press('Backspace');
               await page.keyboard.type(destinationStation, { delay: 100 });
               await new Promise(r => setTimeout(r, 2000));
               await page.keyboard.press('ArrowDown');
               await page.keyboard.press('Enter');
               console.log("Selected Destination (fallback), waiting for UI to update...");
               await new Promise(r => setTimeout(r, 3000));
             }
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


// --- THE ORIGINAL TEST ENDPOINT ---
app.get('/api/test-scrape', async (req, res) => {
  let browser;
  try {
    const launchOptions = {
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    };
    if (process.env.RENDER) launchOptions.executablePath = '/usr/bin/google-chrome';

    browser = await puppeteer.launch(launchOptions);
    const page = await browser.newPage();
    await page.goto('https://www.irctc.co.in/online-charts/', { waitUntil: 'networkidle2' });
    const title = await page.title();
    await browser.close();
    res.json({ success: true, message: "Successfully loaded IRCTC portal using stealth!", title });
  } catch (error) {
    if (browser) await browser.close();
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`GapSeat Data Proxy running on port ${PORT}`);
});
