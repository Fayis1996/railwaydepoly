const irctc = require('irctc-connect');

async function test() {
  try {
    const res = await irctc.getTrainInfo('12617');
    console.log(JSON.stringify(res, null, 2));
  } catch(e) {
    console.error(e);
  }
}
test();
