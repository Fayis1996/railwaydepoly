const fs = require('fs');
const html = fs.readFileSync('irctc_dom.html', 'utf8');

// Quick regex to find inputs
const inputMatches = html.match(/<input[^>]*>/gi) || [];
console.log(`Found ${inputMatches.length} inputs.`);
inputMatches.forEach((m, i) => {
  console.log(`Input ${i}: ${m}`);
});

// Also find any label containing Journey To or Destination
const labelMatches = html.match(/<[^>]*>.*?Journey To.*?<\/[^>]*>/gi) || [];
console.log(`Found ${labelMatches.length} Journey To labels.`);
labelMatches.forEach((m, i) => {
  console.log(`Label ${i}: ${m.substring(0, 100)}`);
});
