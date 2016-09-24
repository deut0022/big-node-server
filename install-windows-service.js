var Service = require('node-windows').Service;

// Create a new service object
var svc = new Service({
  name:'BIG Server - nodejs',
  description: 'The nodejs app that logs data from the parallele JACE',
  script: 'C:\\big_server_node_js\\big-server.js'
});

// Listen for the "install" event, which indicates the
// process is available as a service.
svc.on('install',function(){
  svc.start();
});

svc.install();
