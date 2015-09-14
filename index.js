var dwc = require('./lib/dwc');

var app = dwc.createServer({
  port: 8000
});

app.listen();
