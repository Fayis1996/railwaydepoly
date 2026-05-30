import express from 'express';
import cors from 'cors';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

// Add stealth plugin to bypass IRCTC bot protection
puppeteer.use(StealthPlugin());

const app = express();
app.use(cors());

// Test endpoint to verify Puppeteer can reach the site without getting blocked
app.get('/api/test-scrape', async (req, res) => {
  let browser;
  try {
    console.log("Launching headless browser...");
    // Render requires no-sandbox flags and explicit executable path
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: '/usr/bin/google-chrome',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
    
    console.log("Navigating to IRCTC Charts Portal...");
    await page.goto('https://www.irctc.co.in/online-charts/', { waitUntil: 'networkidle2' });
    
    // Get the page title to verify we aren't getting an "Access Denied" page
    const title = await page.title();
    console.log("Page title:", title);
    
    // In a full implementation, we would use page.type() to enter the train number
    // and page.click() to submit the form, then intercept the JSON response.
    
    await browser.close();
    
    res.json({ 
      success: true, 
      message: "Successfully loaded IRCTC portal using stealth!",
      title: title
    });
    
  } catch (error) {
    console.error("Scraping error:", error);
    if (browser) await browser.close();
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`GapSeat Data Proxy running on port ${PORT}`);
});
